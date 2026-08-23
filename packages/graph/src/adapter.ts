import { GraphError } from "./codes.js";
import type { EdgeType, GraphEdge } from "./edges.js";
import { createNode, type GraphNode, type NodeKind } from "./nodes.js";
import { MemoryGraphStore } from "./store.js";
import { toCanonicalJSON } from "./serialize.js";
import { validateGraph, type GraphInput } from "./validate.js";

/**
 * What an adapter can actually do.
 *
 * Declared rather than assumed, because the alternative is discovering that an
 * adapter has no transactions from a half-written lineage graph after a crash.
 * A caller that needs atomic ingest should be able to ask first.
 */
export interface GraphStoreCapabilities {
  /** Whether `ingest` is genuinely atomic rather than best-effort. */
  readonly transactions: boolean;
  /** Whether data survives process restart. */
  readonly persistent: boolean;
  /** Largest batch `ingest` accepts, or `null` for unbounded. */
  readonly maxBatchSize: number | null;
}

/**
 * Storage-neutral graph access.
 *
 * Async throughout, including for the in-memory implementation. A synchronous
 * interface with an async implementation bolted on later is a breaking change;
 * an async interface over a synchronous store costs a microtask.
 *
 * Every method takes `tenantId` as a required argument. Tenant isolation is
 * part of the contract, not an adapter's discretion.
 */
export interface GraphStoreAdapter {
  readonly name: string;
  readonly capabilities: GraphStoreCapabilities;

  /**
   * Writes nodes and edges atomically.
   *
   * All-or-nothing. A batch containing one bad element must leave the store
   * exactly as it was: a half-ingested lineage graph is worse than no graph,
   * because it looks complete and is not.
   */
  ingest(tenantId: string, graph: GraphInput): Promise<void>;

  node(tenantId: string, id: string): Promise<GraphNode | undefined>;
  nodes(tenantId: string, kind?: NodeKind): Promise<GraphNode[]>;
  edges(tenantId: string, type?: EdgeType): Promise<GraphEdge[]>;
  outgoing(tenantId: string, nodeId: string, type?: EdgeType): Promise<GraphEdge[]>;
  incoming(tenantId: string, nodeId: string, type?: EdgeType): Promise<GraphEdge[]>;
  snapshot(tenantId: string): Promise<GraphInput>;
  close(): Promise<void>;
}

/** The reference adapter: the in-memory store behind the async contract. */
export class MemoryGraphAdapter implements GraphStoreAdapter {
  readonly name = "memory";
  readonly capabilities: GraphStoreCapabilities = {
    transactions: true,
    persistent: false,
    maxBatchSize: null,
  };

  #store = new MemoryGraphStore();

  async ingest(tenantId: string, graph: GraphInput): Promise<void> {
    assertTenantScoped(tenantId, graph);

    // Validate before touching the store. Rebuilding from a snapshot after a
    // partial write would be a rollback that depends on the write having been
    // observable, which is the bug this is meant to prevent.
    const report = validateGraph(graph);
    const fatal = report.violations.filter(
      (violation) =>
        violation.code === "GRAPH_SCHEMA_INVALID" || violation.code === "GRAPH_ID_MISMATCH",
    );
    if (fatal.length > 0) {
      throw new GraphError(
        fatal[0]?.code ?? "GRAPH_SCHEMA_INVALID",
        `refusing to ingest ${fatal.length} malformed element(s) into ${this.name}`,
        fatal.map((violation) => `${violation.elementId}: ${violation.message}`),
      );
    }

    this.#store.load(graph);
    return Promise.resolve();
  }

  async node(tenantId: string, id: string): Promise<GraphNode | undefined> {
    return Promise.resolve(this.#store.node(tenantId, id));
  }

  async nodes(tenantId: string, kind?: NodeKind): Promise<GraphNode[]> {
    return Promise.resolve(
      kind === undefined ? this.#store.nodes(tenantId) : this.#store.nodes(tenantId, kind),
    );
  }

  async edges(tenantId: string, type?: EdgeType): Promise<GraphEdge[]> {
    return Promise.resolve(this.#store.edges(tenantId, type));
  }

  async outgoing(tenantId: string, nodeId: string, type?: EdgeType): Promise<GraphEdge[]> {
    return Promise.resolve(this.#store.outgoing(tenantId, nodeId, type));
  }

  async incoming(tenantId: string, nodeId: string, type?: EdgeType): Promise<GraphEdge[]> {
    return Promise.resolve(this.#store.incoming(tenantId, nodeId, type));
  }

  async snapshot(tenantId: string): Promise<GraphInput> {
    return Promise.resolve(this.#store.snapshot(tenantId));
  }

  async close(): Promise<void> {
    this.#store = new MemoryGraphStore();
    return Promise.resolve();
  }
}

/**
 * An adapter rejects a graph carrying elements from another tenant rather than
 * silently writing them, which would let one caller seed another tenant's
 * ledger through a batch it controls.
 */
function assertTenantScoped(tenantId: string, graph: GraphInput): void {
  const foreign = [...graph.nodes, ...graph.edges].filter(
    (element) => element.tenantId !== tenantId,
  );

  if (foreign.length > 0) {
    throw new GraphError(
      "GRAPH_TENANT_MISMATCH",
      `refusing to ingest ${foreign.length} element(s) belonging to another tenant`,
      foreign.slice(0, 5).map((element) => `${element.id} is in ${element.tenantId}`),
    );
  }
}

export interface ConformanceCase {
  readonly name: string;
  /** Throws on failure. Receives a freshly constructed adapter. */
  run(adapter: GraphStoreAdapter): Promise<void>;
}

/**
 * The contract every adapter must satisfy, as data.
 *
 * Deliberately not `describe`/`it` blocks: `@provguard/graph` is a runtime
 * library and must not acquire a test framework as a dependency just so a
 * downstream adapter can reuse the suite. Each consuming package wraps these in
 * its own `it()`.
 */
export function conformanceCases(graph: GraphInput): readonly ConformanceCase[] {
  const tenant = graph.nodes[0]?.tenantId ?? "acme";

  return [
    {
      name: "declares its capabilities",
      async run(adapter) {
        assert(typeof adapter.name === "string" && adapter.name.length > 0, "adapter needs a name");
        assert(
          typeof adapter.capabilities.transactions === "boolean",
          "capabilities.transactions must be declared",
        );
        assert(
          adapter.capabilities.maxBatchSize === null || adapter.capabilities.maxBatchSize > 0,
          "maxBatchSize must be null or positive",
        );
      },
    },
    {
      name: "round-trips an ingested graph",
      async run(adapter) {
        await adapter.ingest(tenant, graph);
        const snapshot = await adapter.snapshot(tenant);

        assert(
          snapshot.nodes.length === graph.nodes.length,
          `expected ${graph.nodes.length} nodes, got ${snapshot.nodes.length}`,
        );
        assert(
          snapshot.edges.length === graph.edges.length,
          `expected ${graph.edges.length} edges, got ${snapshot.edges.length}`,
        );
      },
    },
    {
      name: "preserves every recorded fact through storage",
      async run(adapter) {
        await adapter.ingest(tenant, graph);
        const snapshot = await adapter.snapshot(tenant);

        assert(
          toCanonicalJSON(snapshot, { redact: false }) ===
            toCanonicalJSON(graph, { redact: false }),
          "snapshot is not canonically identical to what was ingested",
        );
      },
    },
    {
      name: "is idempotent when the same graph is ingested twice",
      async run(adapter) {
        await adapter.ingest(tenant, graph);
        const once = await adapter.snapshot(tenant);
        await adapter.ingest(tenant, graph);
        const twice = await adapter.snapshot(tenant);

        assert(
          toCanonicalJSON(twice, { redact: false }) === toCanonicalJSON(once, { redact: false }),
          "re-ingesting the same graph changed the store",
        );
      },
    },
    {
      name: "leaves the store untouched when ingest fails",
      async run(adapter) {
        await adapter.ingest(tenant, graph);
        const before = toCanonicalJSON(await adapter.snapshot(tenant), { redact: false });

        // The batch must contain a *new* valid element ahead of the bad one.
        // Re-sending only elements already stored makes a partial write a
        // no-op, and the case would then pass a non-atomic adapter — which is
        // precisely the adapter it exists to reject.
        const newcomer = createNode({
          kind: "Policy",
          tenantId: tenant,
          observedAt: "2026-03-04T10:00:00.000Z",
          name: "conformance-probe",
          version: "1",
          contentHash: "sha256:conformance-probe",
          mode: "enforce",
        });

        const corrupt: GraphInput = {
          nodes: [
            newcomer,
            { ...(graph.nodes[0] as GraphNode), kind: "Wormhole" } as unknown as GraphNode,
          ],
          edges: [],
        };

        let threw = false;
        try {
          await adapter.ingest(tenant, corrupt);
        } catch {
          threw = true;
        }

        assert(threw, "ingest accepted a malformed batch");
        const after = toCanonicalJSON(await adapter.snapshot(tenant), { redact: false });
        assert(after === before, "failed ingest left the store modified");
      },
    },
    {
      name: "refuses a batch carrying another tenant's elements",
      async run(adapter) {
        let threw = false;
        try {
          await adapter.ingest("globex", graph);
        } catch {
          threw = true;
        }

        assert(threw, "ingest accepted elements belonging to another tenant");
      },
    },
    {
      name: "never returns another tenant's elements",
      async run(adapter) {
        await adapter.ingest(tenant, graph);

        assert((await adapter.nodes("globex")).length === 0, "leaked nodes across tenants");
        assert((await adapter.edges("globex")).length === 0, "leaked edges across tenants");

        for (const node of graph.nodes) {
          assert(
            (await adapter.node("globex", node.id)) === undefined,
            `leaked node ${node.id} across tenants`,
          );
        }
      },
    },
    {
      name: "does not leak across tenants through neighbour lookups",
      async run(adapter) {
        // The lookup most likely to forget the tenant check, because it starts
        // from an id the caller already supplied.
        await adapter.ingest(tenant, graph);

        for (const edge of graph.edges) {
          assert(
            (await adapter.outgoing("globex", edge.from)).length === 0,
            "outgoing leaked across tenants",
          );
          assert(
            (await adapter.incoming("globex", edge.to)).length === 0,
            "incoming leaked across tenants",
          );
        }
      },
    },
    {
      name: "filters by node kind and edge type",
      async run(adapter) {
        await adapter.ingest(tenant, graph);

        const chunks = await adapter.nodes(tenant, "Chunk");
        assert(
          chunks.every((node) => node.kind === "Chunk"),
          "nodes(kind) returned another kind",
        );

        const support = await adapter.edges(tenant, "SUPPORTED_BY");
        assert(
          support.every((edge) => edge.type === "SUPPORTED_BY"),
          "edges(type) returned another type",
        );
      },
    },
    {
      name: "returns deterministically ordered reads",
      async run(adapter) {
        await adapter.ingest(tenant, graph);
        const first = (await adapter.nodes(tenant)).map((node) => node.id);

        // Re-ingesting in reverse must not change read order: insertion order
        // is an accident of ingest and must not reach the caller.
        await adapter.ingest(tenant, {
          nodes: [...graph.nodes].reverse(),
          edges: [...graph.edges].reverse(),
        });
        const second = (await adapter.nodes(tenant)).map((node) => node.id);

        assert(
          JSON.stringify(first) === JSON.stringify(second),
          "read order depended on ingest order",
        );
      },
    },
    {
      name: "walks both edge directions",
      async run(adapter) {
        await adapter.ingest(tenant, graph);
        const edge = graph.edges[0];
        assert(edge !== undefined, "fixture graph has no edges");

        const out = await adapter.outgoing(tenant, edge.from, edge.type);
        const incoming = await adapter.incoming(tenant, edge.to, edge.type);

        assert(
          out.some((candidate) => candidate.id === edge.id),
          "outgoing did not return a known edge",
        );
        assert(
          incoming.some((candidate) => candidate.id === edge.id),
          "incoming did not return a known edge",
        );
      },
    },
    {
      name: "returns an empty snapshot for an unknown tenant",
      async run(adapter) {
        await adapter.ingest(tenant, graph);
        const snapshot = await adapter.snapshot("globex");

        assert(
          snapshot.nodes.length === 0 && snapshot.edges.length === 0,
          "unknown tenant not empty",
        );
      },
    },
  ];
}

/** Declared as an assertion so a checked value narrows for the rest of the case. */
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
