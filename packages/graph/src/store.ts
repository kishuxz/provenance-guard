import { GraphError } from "./codes.js";
import type { EdgeType, GraphEdge } from "./edges.js";
import { assertTenantId } from "./ids.js";
import type { GraphNode, NodeKind } from "./nodes.js";
import type { GraphInput } from "./validate.js";

/**
 * The zero-infrastructure store.
 *
 * Core tests and the CLI run against this. Nothing about the graph's semantics
 * may depend on a database being present, so this is the reference
 * implementation the storage adapter contract is written against rather than a
 * stand-in for one.
 *
 * Every read is tenant-scoped and the tenant is a required argument, not an
 * optional filter. A cross-tenant read should require writing something that
 * looks wrong, not merely forgetting to pass a parameter.
 */
export class MemoryGraphStore {
  readonly #nodes = new Map<string, GraphNode>();
  readonly #edges = new Map<string, GraphEdge>();
  readonly #outgoing = new Map<string, Set<string>>();
  readonly #incoming = new Map<string, Set<string>>();

  constructor(graph?: GraphInput) {
    if (graph !== undefined) {
      this.load(graph);
    }
  }

  /**
   * Adds nodes and edges. Idempotent: identity is derived, so recording the
   * same fact twice converges rather than accumulating duplicates, which is
   * what lets an interrupted ingest be retried safely.
   */
  load(graph: GraphInput): this {
    for (const node of graph.nodes) {
      this.#nodes.set(node.id, node);
    }

    for (const edge of graph.edges) {
      this.#edges.set(edge.id, edge);
      addTo(this.#outgoing, edge.from, edge.id);
      addTo(this.#incoming, edge.to, edge.id);
    }

    return this;
  }

  get size(): { nodes: number; edges: number } {
    return { nodes: this.#nodes.size, edges: this.#edges.size };
  }

  /** Returns the node, or `undefined` when it is absent or belongs to another tenant. */
  node(tenantId: string, id: string): GraphNode | undefined {
    assertTenantId(tenantId);
    const node = this.#nodes.get(id);
    return node?.tenantId === tenantId ? node : undefined;
  }

  /** Like `node`, but throws when absent — for callers that cannot continue without it. */
  requireNode(tenantId: string, id: string): GraphNode {
    const node = this.node(tenantId, id);
    if (node === undefined) {
      throw new GraphError(
        "GRAPH_REFERENCE_MISSING",
        `node ${id} is not present in tenant ${tenantId}`,
      );
    }
    return node;
  }

  edge(tenantId: string, id: string): GraphEdge | undefined {
    assertTenantId(tenantId);
    const edge = this.#edges.get(id);
    return edge?.tenantId === tenantId ? edge : undefined;
  }

  /**
   * Nodes in this tenant, optionally of one kind.
   *
   * Overloaded so passing a kind narrows the result type: a caller asking for
   * `"Artifact"` gets `ArtifactNode[]` and can read `contentHash` without a
   * cast. Returning the bare union would push a cast to every call site, and a
   * cast is exactly where a wrong-kind assumption stops being checked.
   */
  nodes(tenantId: string): GraphNode[];
  nodes<K extends NodeKind>(tenantId: string, kind: K): Extract<GraphNode, { kind: K }>[];
  nodes(tenantId: string, kind?: NodeKind): GraphNode[] {
    assertTenantId(tenantId);
    return sortById(
      [...this.#nodes.values()].filter(
        (node) => node.tenantId === tenantId && (kind === undefined || node.kind === kind),
      ),
    );
  }

  edges(tenantId: string, type?: EdgeType): GraphEdge[] {
    assertTenantId(tenantId);
    return sortById(
      [...this.#edges.values()].filter(
        (edge) => edge.tenantId === tenantId && (type === undefined || edge.type === type),
      ),
    );
  }

  /** Edges leaving `nodeId`, optionally of one type. Deterministically ordered. */
  outgoing(tenantId: string, nodeId: string, type?: EdgeType): GraphEdge[] {
    return this.#adjacent(this.#outgoing, tenantId, nodeId, type);
  }

  /** Edges arriving at `nodeId`. This is the direction `trace` walks. */
  incoming(tenantId: string, nodeId: string, type?: EdgeType): GraphEdge[] {
    return this.#adjacent(this.#incoming, tenantId, nodeId, type);
  }

  /** The whole tenant's graph, ready to serialize or validate. */
  snapshot(tenantId: string): GraphInput {
    return { nodes: this.nodes(tenantId), edges: this.edges(tenantId) };
  }

  /** Every tenant with at least one node, sorted. */
  tenants(): string[] {
    return [...new Set([...this.#nodes.values()].map((node) => node.tenantId))].sort();
  }

  #adjacent(
    index: Map<string, Set<string>>,
    tenantId: string,
    nodeId: string,
    type?: EdgeType,
  ): GraphEdge[] {
    assertTenantId(tenantId);
    const ids = index.get(nodeId);
    if (ids === undefined) {
      return [];
    }

    const found: GraphEdge[] = [];
    for (const id of ids) {
      const edge = this.#edges.get(id);
      if (edge === undefined || edge.tenantId !== tenantId) {
        continue;
      }
      if (type !== undefined && edge.type !== type) {
        continue;
      }
      found.push(edge);
    }

    return sortById(found);
  }
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, new Set([value]));
  } else {
    existing.add(value);
  }
}

/**
 * Every read is sorted. Insertion order is an accident of how an audit happened
 * to be ingested, and letting it leak into results would make traversal output
 * — and therefore CLI output — non-reproducible.
 */
function sortById<T extends { id: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.id.localeCompare(right.id));
}
