import { describe, expect, it } from "vitest";

import {
  GraphError,
  MemoryGraphAdapter,
  MemoryGraphStore,
  NodeKinds,
  baselineGraph,
  conformanceCases,
  graphFixtures,
  type EdgeType,
  type GraphInput,
  type GraphNode,
  type GraphStoreAdapter,
  type NodeKind,
} from "../src/index.js";

const TENANT = "acme";

describe("MemoryGraphAdapter conformance", () => {
  const cases = conformanceCases(baselineGraph());

  it("has cases to run", () => {
    expect(cases.length).toBeGreaterThan(8);
  });

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    async (_name, testCase) => {
      await expect(testCase.run(new MemoryGraphAdapter())).resolves.toBeUndefined();
    },
  );
});

describe("conformance suite is not vacuous", () => {
  it("fails an adapter that ignores tenant scoping", async () => {
    // A deliberately broken adapter: every read ignores the tenant. If the
    // suite passes this, it is not testing isolation.
    class LeakyAdapter extends MemoryGraphAdapter {
      override async nodes(): Promise<GraphNode[]> {
        return super.nodes(TENANT);
      }
    }

    const isolation = conformanceCases(baselineGraph()).find(
      (testCase) => testCase.name === "never returns another tenant's elements",
    );
    if (isolation === undefined) {
      throw new Error("isolation case missing");
    }

    await expect(isolation.run(new LeakyAdapter())).rejects.toThrow(/leaked/);
  });

  it("fails an adapter whose ingest is not atomic", async () => {
    // Writes each element as it goes and only then rejects — the natural shape
    // of a naive database adapter, and exactly the failure the atomicity case
    // exists to catch. Built on its own store rather than by subclassing,
    // because MemoryGraphAdapter validates before writing and so cannot be
    // made to leave a partial write.
    class NonAtomicAdapter implements GraphStoreAdapter {
      readonly name = "non-atomic";
      readonly capabilities = { transactions: false, persistent: false, maxBatchSize: null };
      readonly #store = new MemoryGraphStore();

      async ingest(_tenantId: string, graph: GraphInput): Promise<void> {
        for (const node of graph.nodes) {
          if (!NodeKinds.includes(node.kind)) {
            throw new Error("bad element");
          }
          this.#store.load({ nodes: [node], edges: [] });
        }
        this.#store.load({ nodes: [], edges: graph.edges });
      }

      async node(tenantId: string, id: string) {
        return this.#store.node(tenantId, id);
      }
      async nodes(tenantId: string, kind?: NodeKind) {
        return kind === undefined ? this.#store.nodes(tenantId) : this.#store.nodes(tenantId, kind);
      }
      async edges(tenantId: string, type?: EdgeType) {
        return this.#store.edges(tenantId, type);
      }
      async outgoing(tenantId: string, nodeId: string, type?: EdgeType) {
        return this.#store.outgoing(tenantId, nodeId, type);
      }
      async incoming(tenantId: string, nodeId: string, type?: EdgeType) {
        return this.#store.incoming(tenantId, nodeId, type);
      }
      async snapshot(tenantId: string) {
        return this.#store.snapshot(tenantId);
      }
      async close() {
        /* nothing to release */
      }
    }

    const atomicity = conformanceCases(baselineGraph()).find(
      (testCase) => testCase.name === "leaves the store untouched when ingest fails",
    );
    if (atomicity === undefined) {
      throw new Error("atomicity case missing");
    }

    await expect(atomicity.run(new NonAtomicAdapter())).rejects.toThrow(/left the store modified/);
  });
});

describe("MemoryGraphAdapter", () => {
  it("refuses a malformed batch with a typed error", async () => {
    const adapter = new MemoryGraphAdapter();
    const graph = baselineGraph();

    await expect(
      adapter.ingest(TENANT, {
        nodes: [{ kind: "Chunk", id: "not-an-id" } as unknown as GraphNode],
        edges: [],
      }),
    ).rejects.toThrow(GraphError);

    // And nothing was written.
    expect((await adapter.snapshot(TENANT)).nodes).toEqual([]);
    await adapter.ingest(TENANT, graph);
    expect((await adapter.snapshot(TENANT)).nodes).toHaveLength(graph.nodes.length);
  });

  it("refuses a batch belonging to another tenant", async () => {
    await expect(new MemoryGraphAdapter().ingest("globex", baselineGraph())).rejects.toThrow(
      GraphError,
    );
  });

  it("accepts a graph with semantic violations, since storage is not a validator", async () => {
    // A graph that fails an invariant is still a record of what happened, and
    // refusing to store it would make the defect unexaminable. Only structural
    // corruption -- unparseable elements, tampered ids -- is refused.
    const blocked = graphFixtures().find((fixture) => fixture.id === "support-from-blocked-chunk");
    if (blocked === undefined) {
      throw new Error("fixture missing");
    }

    const adapter = new MemoryGraphAdapter();
    await expect(adapter.ingest(TENANT, blocked.graph)).resolves.toBeUndefined();
    expect((await adapter.snapshot(TENANT)).nodes.length).toBeGreaterThan(0);
  });

  it("clears state on close", async () => {
    const adapter = new MemoryGraphAdapter();
    await adapter.ingest(TENANT, baselineGraph());
    await adapter.close();

    expect((await adapter.snapshot(TENANT)).nodes).toEqual([]);
  });

  it("declares itself non-persistent and transactional", () => {
    expect(new MemoryGraphAdapter().capabilities).toEqual({
      transactions: true,
      persistent: false,
      maxBatchSize: null,
    });
  });
});
