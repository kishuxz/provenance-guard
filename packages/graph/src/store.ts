import { GraphError, type GraphViolationCode } from "./codes.js";
import type { EdgeType, GraphEdge } from "./edges.js";
import { assertTenantId } from "./ids.js";
import type { GraphNode, NodeKind } from "./nodes.js";
import { validateGraph, type GraphInput } from "./validate.js";

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
   * Loads a graph without validating it.
   *
   * For callers that have already validated, or that are deliberately
   * assembling a known-bad graph in a test. Named so that using it is a visible
   * decision: `load` is the safe default and this is the opt-out.
   */
  loadUnchecked(graph: GraphInput): this {
    return this.#apply(graph);
  }

  /**
   * Validates, then adds nodes and edges.
   *
   * A graph document arriving from disk, an API or another tenant's export is
   * untrusted input. Filtering reads on a `tenantId` field that the document
   * itself supplies is not isolation, so the document is checked before any of
   * it is stored.
   *
   * Structural and scope failures reject the whole batch. Semantic invariant
   * failures do not: a graph recording that a claim rested on a refused chunk
   * is a true record of a real defect, and refusing to store it would make the
   * defect unexaminable. Judging the record is `validateGraph`'s job.
   *
   * Idempotent: identity is derived, so recording the same fact twice converges
   * rather than accumulating duplicates.
   */
  load(graph: GraphInput): this {
    assertLoadable(graph);
    return this.#apply(graph);
  }

  /** Mutation, separated so validation cannot be accidentally skipped. */
  #apply(graph: GraphInput): this {
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

/**
 * Violations that make a document unfit to store at all.
 *
 * Deliberately narrow. These are failures of structure and scope -- the
 * document is not a well-formed record, or it claims elements it does not own.
 * Every other violation describes something that genuinely happened and must
 * remain storable and inspectable.
 */
const REJECTS_LOAD: readonly GraphViolationCode[] = [
  "GRAPH_SCHEMA_INVALID",
  "GRAPH_ID_MISMATCH",
  "GRAPH_DUPLICATE_ID",
  "GRAPH_TENANT_MISMATCH",
  "GRAPH_RUN_MISMATCH",
  "GRAPH_EDGE_TYPE_NOT_PERMITTED",
  "GRAPH_CYCLE_DETECTED",
];

/**
 * Throws unless the graph is fit to store.
 *
 * Runs before any mutation, so a rejected load leaves the store exactly as it
 * was. Rolling back after a partial write would depend on the write having been
 * observable, which is the failure this prevents.
 */
export function assertLoadable(graph: GraphInput): void {
  const blocking = validateGraph(graph).violations.filter((violation) =>
    REJECTS_LOAD.includes(violation.code),
  );

  if (blocking.length > 0) {
    throw new GraphError(
      blocking[0]?.code ?? "GRAPH_SCHEMA_INVALID",
      `refusing to load a graph with ${blocking.length} structural or scope violation(s)`,
      blocking
        .slice(0, 10)
        .map((violation) => `${violation.code} ${violation.elementId}: ${violation.message}`),
    );
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
