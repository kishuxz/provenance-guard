import neo4j, { type Driver, type ManagedTransaction, type Session } from "neo4j-driver";

import {
  GraphError,
  NodeKinds,
  REDACTABLE_ATTRIBUTES,
  REDACTED,
  type EdgeType,
  type GraphEdge,
  type GraphInput,
  type GraphNode,
  type GraphStoreAdapter,
  type GraphStoreCapabilities,
  type NodeKind,
} from "@provguard/graph";

export interface Neo4jAdapterOptions {
  readonly uri: string;
  readonly username: string;
  readonly password: string;
  /** Database name. Defaults to the server's default database. */
  readonly database?: string;
  /**
   * Persist raw chunk, claim and output text instead of redacting it.
   *
   * Off by default, matching `toCanonicalJSON` and `toJSONL`. A store holding
   * every chunk of raw material a guard ever saw is a standing disclosure risk,
   * and a system whose documentation says redaction is the default should not
   * quietly except its database.
   *
   * Turn this on only when you control the database's access, retention and
   * backups, and need the original text for investigation. Redaction touches
   * only non-identity attributes, so ids and traversals are unaffected either
   * way -- what you lose is the ability to read the material back, not the
   * ability to trace it.
   */
  readonly persistRawText?: boolean;
}

/**
 * Every node is stored with the `:PgNode` label plus its kind, and every edge
 * with `:PgEdge` plus its type. One shared label makes tenant-scoped
 * constraints and sweeps expressible in a single statement; the specific label
 * keeps kind and type filters index-friendly.
 */
const NODE_LABEL = "PgNode";
const EDGE_LABEL = "PgEdge";

/**
 * A `GraphStoreAdapter` backed by Neo4j.
 *
 * This package is deliberately isolated: nothing in the core depends on it, so
 * the guards, the CLI and the bench keep working with no database, no network
 * and no credentials. It exists to demonstrate that the graph's semantics do
 * not depend on a vendor, which is only demonstrated if it passes the same
 * conformance suite the in-memory store does.
 */
export class Neo4jGraphAdapter implements GraphStoreAdapter {
  readonly name = "neo4j";
  readonly capabilities: GraphStoreCapabilities = {
    transactions: true,
    persistent: true,
    maxBatchSize: null,
  };

  readonly #driver: Driver;
  readonly #database: string | undefined;
  readonly #persistRawText: boolean;
  #schemaReady = false;

  constructor(options: Neo4jAdapterOptions) {
    this.#driver = neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password));
    this.#database = options.database;
    this.#persistRawText = resolvePersistRawText(options.persistRawText);
  }

  /** Whether this adapter writes raw material. Reported so a caller can assert it. */
  get persistsRawText(): boolean {
    return this.#persistRawText;
  }

  /**
   * Creates constraints and indexes.
   *
   * `IF NOT EXISTS` throughout, so connecting twice is safe and a deployment
   * does not need a separate migration step to be usable.
   */
  async initialise(): Promise<void> {
    if (this.#schemaReady) {
      return;
    }

    const statements = [
      `CREATE CONSTRAINT pg_node_id IF NOT EXISTS
       FOR (n:${NODE_LABEL}) REQUIRE (n.tenantId, n.id) IS UNIQUE`,
      `CREATE CONSTRAINT pg_edge_id IF NOT EXISTS
       FOR ()-[e:${EDGE_LABEL}]-() REQUIRE (e.tenantId, e.id) IS UNIQUE`,
      // The lookups the traversals actually perform: by tenant, and by tenant
      // plus kind. Without these every trace degrades to a label scan.
      `CREATE INDEX pg_node_tenant IF NOT EXISTS FOR (n:${NODE_LABEL}) ON (n.tenantId)`,
      `CREATE INDEX pg_node_tenant_kind IF NOT EXISTS FOR (n:${NODE_LABEL}) ON (n.tenantId, n.kind)`,
      `CREATE INDEX pg_edge_tenant_type IF NOT EXISTS FOR ()-[e:${EDGE_LABEL}]-() ON (e.tenantId, e.type)`,
    ];

    const session = this.#session();
    try {
      for (const statement of statements) {
        await session.run(statement);
      }
      this.#schemaReady = true;
    } finally {
      await session.close();
    }
  }

  /**
   * Writes the whole batch in one transaction.
   *
   * Validation runs first, inside the same call, so a malformed element is
   * rejected before any write is attempted rather than rolled back after one.
   */
  async ingest(tenantId: string, graph: GraphInput): Promise<void> {
    assertTenantScoped(tenantId, graph);
    assertStructurallySound(graph);
    await this.initialise();

    const session = this.#session();
    try {
      await session.executeWrite(async (transaction: ManagedTransaction) => {
        // MERGE on (tenantId, id) makes re-ingest idempotent, which is what
        // lets an interrupted ingest be retried instead of deduplicated later.
        await transaction.run(
          `UNWIND $nodes AS node
           MERGE (n:${NODE_LABEL} {tenantId: node.tenantId, id: node.id})
           SET n += node.properties, n.kind = node.kind`,
          {
            nodes: graph.nodes
              .map((node) => (this.#persistRawText ? node : redactNodeForStorage(node)))
              .map(toNodeParameter),
          },
        );

        await transaction.run(
          `UNWIND $edges AS edge
           MATCH (from:${NODE_LABEL} {tenantId: edge.tenantId, id: edge.from})
           MATCH (to:${NODE_LABEL} {tenantId: edge.tenantId, id: edge.to})
           MERGE (from)-[e:${EDGE_LABEL} {tenantId: edge.tenantId, id: edge.id}]->(to)
           SET e += edge.properties, e.type = edge.type`,
          { edges: graph.edges.map(toEdgeParameter) },
        );
      });
    } finally {
      await session.close();
    }
  }

  async node(tenantId: string, id: string): Promise<GraphNode | undefined> {
    const rows = await this.#read<{ node: Record<string, unknown> }>(
      `MATCH (n:${NODE_LABEL} {tenantId: $tenantId, id: $id}) RETURN properties(n) AS node`,
      { tenantId, id },
    );

    const first = rows[0];
    return first === undefined ? undefined : fromStoredNode(first.node);
  }

  async nodes(tenantId: string, kind?: NodeKind): Promise<GraphNode[]> {
    const rows = await this.#read<{ node: Record<string, unknown> }>(
      kind === undefined
        ? `MATCH (n:${NODE_LABEL} {tenantId: $tenantId}) RETURN properties(n) AS node ORDER BY n.id`
        : `MATCH (n:${NODE_LABEL} {tenantId: $tenantId, kind: $kind}) RETURN properties(n) AS node ORDER BY n.id`,
      kind === undefined ? { tenantId } : { tenantId, kind },
    );

    return rows.map((row) => fromStoredNode(row.node));
  }

  async edges(tenantId: string, type?: EdgeType): Promise<GraphEdge[]> {
    const rows = await this.#read<{ edge: Record<string, unknown> }>(
      type === undefined
        ? `MATCH ()-[e:${EDGE_LABEL} {tenantId: $tenantId}]->() RETURN properties(e) AS edge ORDER BY e.id`
        : `MATCH ()-[e:${EDGE_LABEL} {tenantId: $tenantId, type: $type}]->() RETURN properties(e) AS edge ORDER BY e.id`,
      type === undefined ? { tenantId } : { tenantId, type },
    );

    return rows.map((row) => fromStoredEdge(row.edge));
  }

  async outgoing(tenantId: string, nodeId: string, type?: EdgeType): Promise<GraphEdge[]> {
    return this.#adjacent(tenantId, nodeId, type, "outgoing");
  }

  async incoming(tenantId: string, nodeId: string, type?: EdgeType): Promise<GraphEdge[]> {
    return this.#adjacent(tenantId, nodeId, type, "incoming");
  }

  async snapshot(tenantId: string): Promise<GraphInput> {
    return { nodes: await this.nodes(tenantId), edges: await this.edges(tenantId) };
  }

  /** Removes one tenant's data. Used by tests; never called by the guards. */
  async clear(tenantId: string): Promise<void> {
    const session = this.#session();
    try {
      await session.executeWrite(async (transaction) => {
        await transaction.run(`MATCH (n:${NODE_LABEL} {tenantId: $tenantId}) DETACH DELETE n`, {
          tenantId,
        });
      });
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }

  async #adjacent(
    tenantId: string,
    nodeId: string,
    type: EdgeType | undefined,
    direction: "outgoing" | "incoming",
  ): Promise<GraphEdge[]> {
    // The node pattern is tenant-scoped on both ends. Matching only the edge's
    // tenantId would let a caller who guessed an id in another tenant walk out
    // of their own data.
    const pattern =
      direction === "outgoing"
        ? `(n:${NODE_LABEL} {tenantId: $tenantId, id: $nodeId})-[e:${EDGE_LABEL} {tenantId: $tenantId}]->(:${NODE_LABEL} {tenantId: $tenantId})`
        : `(:${NODE_LABEL} {tenantId: $tenantId})-[e:${EDGE_LABEL} {tenantId: $tenantId}]->(n:${NODE_LABEL} {tenantId: $tenantId, id: $nodeId})`;

    const rows = await this.#read<{ edge: Record<string, unknown> }>(
      `MATCH ${pattern}
       ${type === undefined ? "" : "WHERE e.type = $type"}
       RETURN properties(e) AS edge ORDER BY e.id`,
      type === undefined ? { tenantId, nodeId } : { tenantId, nodeId, type },
    );

    return rows.map((row) => fromStoredEdge(row.edge));
  }

  async #read<T>(cypher: string, parameters: Record<string, unknown>): Promise<T[]> {
    await this.initialise();
    const session = this.#session();
    try {
      const result = await session.executeRead(async (transaction) =>
        transaction.run(cypher, parameters),
      );
      return result.records.map((record) => record.toObject() as T);
    } finally {
      await session.close();
    }
  }

  #session(): Session {
    return this.#database === undefined
      ? this.#driver.session()
      : this.#driver.session({ database: this.#database });
  }
}

/**
 * Neo4j stores scalars, not nested objects, so array-valued attributes are
 * carried as JSON. `reasonCodes` is the only one today; encoding it explicitly
 * beats a generic serializer that would silently flatten a future nested field.
 */
const JSON_ENCODED_FIELDS = ["reasonCodes"] as const;

/**
 * Resolves the raw-text opt-in.
 *
 * Only the literal boolean `true` enables it. Absent means redact. A malformed
 * value throws rather than defaulting, because the two silent failures are both
 * bad in different directions: `"false"` is truthy and would silently enable
 * raw persistence, while quietly ignoring a typo would leave an operator
 * believing they had switched it on. Neither should be discovered from the
 * contents of a database.
 */
export function resolvePersistRawText(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new GraphError(
      "GRAPH_SCHEMA_INVALID",
      `persistRawText must be a boolean, received ${typeof value}`,
    );
  }

  return value;
}

/**
 * Replaces raw material with the shared placeholder before it reaches the wire.
 *
 * Redaction happens here rather than at the query, so nothing raw is ever a
 * query parameter -- parameters end up in database query logs.
 *
 * Every redactable attribute is a non-identity field, so a redacted node's id
 * still derives from its remaining attributes and the stored graph still
 * validates.
 */
export function redactNodeForStorage(node: GraphNode): GraphNode {
  const attributes = REDACTABLE_ATTRIBUTES[node.kind];
  if (attributes.length === 0) {
    return node;
  }

  const copy = { ...node } as Record<string, unknown>;
  for (const attribute of attributes) {
    if (attribute in copy) {
      copy[attribute] = REDACTED;
    }
  }

  return copy as GraphNode;
}

function toNodeParameter(node: GraphNode): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    properties[key] = (JSON_ENCODED_FIELDS as readonly string[]).includes(key)
      ? JSON.stringify(value)
      : value;
  }

  return { tenantId: node.tenantId, id: node.id, kind: node.kind, properties };
}

function toEdgeParameter(edge: GraphEdge): Record<string, unknown> {
  return {
    tenantId: edge.tenantId,
    id: edge.id,
    type: edge.type,
    from: edge.from,
    to: edge.to,
    properties: { ...edge },
  };
}

function fromStoredNode(stored: Record<string, unknown>): GraphNode {
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if ((JSON_ENCODED_FIELDS as readonly string[]).includes(key) && typeof value === "string") {
      restored[key] = JSON.parse(value);
    } else {
      restored[key] = normaliseScalar(value);
    }
  }

  return restored as unknown as GraphNode;
}

function fromStoredEdge(stored: Record<string, unknown>): GraphEdge {
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    restored[key] = normaliseScalar(value);
  }

  return restored as unknown as GraphEdge;
}

/**
 * The driver returns integers as its own `Integer` type to preserve 64-bit
 * range. Every integer in this schema is small (an ordinal, a span offset, a
 * status code), so converting back to `number` is safe and keeps a round-trip
 * byte-identical to what was written.
 */
function normaliseScalar(value: unknown): unknown {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }
  return value;
}

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

/**
 * Rejects structurally corrupt elements before the transaction opens.
 *
 * Semantic invariant violations are deliberately *not* checked: a graph that
 * fails an invariant is still a true record of what happened, and refusing to
 * store it would make the defect unexaminable. That is `graph validate`'s job.
 */
function assertStructurallySound(graph: GraphInput): void {
  const bad = graph.nodes.filter(
    (node) =>
      typeof node?.id !== "string" ||
      node.id.length === 0 ||
      !(NodeKinds as readonly string[]).includes(node?.kind),
  );

  if (bad.length > 0) {
    // Counts and ids only. Echoing the offending node would put stored
    // material into an error string, which is the least controlled surface
    // there is.
    throw new GraphError(
      "GRAPH_SCHEMA_INVALID",
      `refusing to ingest ${bad.length} structurally invalid node(s)`,
      bad
        .slice(0, 5)
        .map((node) => `node id ${String((node as { id?: unknown }).id ?? "<absent>")}`),
    );
  }
}
