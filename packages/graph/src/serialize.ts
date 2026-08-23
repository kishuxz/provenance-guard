import { GraphError } from "./codes.js";
import { GraphEdgeSchema, type GraphEdge } from "./edges.js";
import { GRAPH_SCHEMA_VERSION } from "./ids.js";
import { GraphNodeSchema, REDACTABLE_ATTRIBUTES, type GraphNode } from "./nodes.js";
import type { GraphInput } from "./validate.js";

export interface SerializeOptions {
  /**
   * Replace raw material with a placeholder. Defaults to `true`: an export
   * leaves the process that produced it, and defaulting to the safe direction
   * means forgetting the option cannot leak anything.
   */
  readonly redact?: boolean;
}

/** Marker written in place of redacted material. */
export const REDACTED = "[redacted]";

/**
 * Serializes a graph to canonical JSON.
 *
 * Canonical means byte-identical for equivalent graphs: keys sorted, elements
 * sorted by ID, no incidental whitespace. That is what makes invariant 8 —
 * replaying an ordered audit yields an equivalent graph — checkable by
 * comparing two strings, instead of by a structural walk that has to decide for
 * itself what "equivalent" means.
 */
export function toCanonicalJSON(graph: GraphInput, options: SerializeOptions = {}): string {
  return JSON.stringify(canonicalDocument(graph, options));
}

/**
 * Serializes to JSONL: one header line, then one element per line.
 *
 * For large graphs, where holding the whole document in memory to parse it is
 * the thing you are trying to avoid.
 */
export function toJSONL(graph: GraphInput, options: SerializeOptions = {}): string {
  const document = canonicalDocument(graph, options);
  const lines = [
    JSON.stringify({
      type: "header",
      schemaVersion: document.schemaVersion,
      redacted: document.redacted,
    }),
    ...document.nodes.map((node) => JSON.stringify({ type: "node", element: node })),
    ...document.edges.map((edge) => JSON.stringify({ type: "edge", element: edge })),
  ];

  return `${lines.join("\n")}\n`;
}

export function fromCanonicalJSON(text: string): GraphInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GraphError("GRAPH_SCHEMA_INVALID", "graph document is not valid JSON", [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new GraphError("GRAPH_SCHEMA_INVALID", "graph document is not an object");
  }

  const document = parsed as { schemaVersion?: unknown; nodes?: unknown; edges?: unknown };
  assertSchemaVersion(document.schemaVersion);

  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
    throw new GraphError("GRAPH_SCHEMA_INVALID", "graph document needs nodes and edges arrays");
  }

  return {
    nodes: document.nodes.map((node, index) => parseNode(node, `nodes[${index}]`)),
    edges: document.edges.map((edge, index) => parseEdge(edge, `edges[${index}]`)),
  };
}

export function fromJSONL(text: string): GraphInput {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let sawHeader = false;

  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }

    let record: { type?: unknown; element?: unknown; schemaVersion?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch (error) {
      throw new GraphError("GRAPH_SCHEMA_INVALID", `line ${index + 1} is not valid JSON`, [
        error instanceof Error ? error.message : String(error),
      ]);
    }

    if (record.type === "header") {
      assertSchemaVersion(record.schemaVersion);
      sawHeader = true;
      continue;
    }

    if (record.type === "node") {
      nodes.push(parseNode(record.element, `line ${index + 1}`));
      continue;
    }

    if (record.type === "edge") {
      edges.push(parseEdge(record.element, `line ${index + 1}`));
      continue;
    }

    throw new GraphError(
      "GRAPH_SCHEMA_INVALID",
      `line ${index + 1} has unknown record type ${JSON.stringify(record.type)}`,
    );
  }

  if (!sawHeader) {
    // Without a header there is no schema version, so there is no way to know
    // whether this reader can interpret the rest. Guessing is how you silently
    // read a v2 document as v1.
    throw new GraphError("GRAPH_SCHEMA_INVALID", "JSONL graph is missing its header line");
  }

  return { nodes, edges };
}

interface CanonicalDocument {
  readonly schemaVersion: number;
  readonly redacted: boolean;
  readonly nodes: readonly Record<string, unknown>[];
  readonly edges: readonly Record<string, unknown>[];
}

function canonicalDocument(graph: GraphInput, options: SerializeOptions): CanonicalDocument {
  const redact = options.redact ?? true;

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    redacted: redact,
    nodes: [...graph.nodes]
      .map((node) => (redact ? redactNode(node) : node))
      .sort(byId)
      .map((node) => canonicalize(node) as Record<string, unknown>),
    edges: [...graph.edges].sort(byId).map((edge) => canonicalize(edge) as Record<string, unknown>),
  };
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

/**
 * Replaces raw material with a placeholder.
 *
 * Every attribute in `REDACTABLE_ATTRIBUTES` is a non-identity field, so a
 * redacted node's ID still derives from its own remaining attributes and a
 * redacted export validates cleanly. That property is load-bearing: an export
 * you cannot validate is an export you have to trust, which is the opposite of
 * what this project is for.
 */
function redactNode(node: GraphNode): GraphNode {
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

/** Recursively sorts object keys so serialization does not depend on insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) {
      sorted[key] = canonicalize(source[key]);
    }
  }

  return sorted;
}

function assertSchemaVersion(value: unknown): void {
  if (value !== GRAPH_SCHEMA_VERSION) {
    throw new GraphError(
      "GRAPH_SCHEMA_INVALID",
      `unsupported graph schema version ${JSON.stringify(value)}, expected ${GRAPH_SCHEMA_VERSION}`,
    );
  }
}

function parseNode(value: unknown, where: string): GraphNode {
  const parsed = GraphNodeSchema.safeParse(value);
  if (!parsed.success) {
    throw new GraphError(
      "GRAPH_SCHEMA_INVALID",
      `${where} is not a valid node`,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function parseEdge(value: unknown, where: string): GraphEdge {
  const parsed = GraphEdgeSchema.safeParse(value);
  if (!parsed.success) {
    throw new GraphError(
      "GRAPH_SCHEMA_INVALID",
      `${where} is not a valid edge`,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return parsed.data;
}
