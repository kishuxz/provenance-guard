/**
 * Stable violation codes for the lineage graph.
 *
 * These are a public contract in the same way `ReasonCode` is: they appear in
 * CLI output and in persisted validation reports, so a consumer may branch on
 * them. Codes may be added; an existing code must not change meaning, and a
 * removal is a breaking change.
 *
 * They are deliberately a separate union from `@provguard/schema`'s
 * `ReasonCode`. A `ReasonCode` says why a chunk or claim was refused — it is a
 * statement about evidence. A `GraphViolationCode` says why a recorded graph is
 * not a well-formed record of what happened. Collapsing the two would let a
 * structural defect in the ledger read as a provenance finding about the
 * material, which is exactly the confusion this project exists to prevent.
 */
export const GraphViolationCodes = [
  /** A node or edge does not satisfy its schema. */
  "GRAPH_SCHEMA_INVALID",
  /** An edge references a node ID that is not present in the graph. */
  "GRAPH_EDGE_ENDPOINT_MISSING",
  /** The edge type does not permit this (fromKind, toKind) pair. */
  "GRAPH_EDGE_TYPE_NOT_PERMITTED",
  /** An edge crosses a tenant boundary, or a node's ID disagrees with its tenant. */
  "GRAPH_TENANT_MISMATCH",
  /** An edge crosses a run boundary that its type declares run-local. */
  "GRAPH_RUN_MISMATCH",
  /** A relationship declared acyclic contains a cycle. */
  "GRAPH_CYCLE_DETECTED",
  /** SUPPORTED_BY targets a chunk the effective policy blocked. */
  "GRAPH_SUPPORT_FROM_BLOCKED_CHUNK",
  /** A delivered material claim has no support and no recorded policy exception. */
  "GRAPH_CLAIM_UNSUPPORTED_DELIVERY",
  /** A verdict does not reference the immutable policy version that produced it. */
  "GRAPH_VERDICT_POLICY_MISSING",
  /** A node's stored ID is not the ID its own identity fields derive to. */
  "GRAPH_ID_MISMATCH",
  /** Two distinct nodes or edges share an ID. */
  "GRAPH_DUPLICATE_ID",
] as const;

export type GraphViolationCode = (typeof GraphViolationCodes)[number];

export function isGraphViolationCode(value: string): value is GraphViolationCode {
  return (GraphViolationCodes as readonly string[]).includes(value);
}

/**
 * Thrown when input cannot be turned into a well-formed graph element.
 *
 * Malformed records fail closed with a typed error rather than producing a
 * partially-populated node, because a node that exists but is wrong is worse
 * than one that was refused: it will be traversed, exported, and cited.
 */
export class GraphError extends Error {
  readonly code: GraphViolationCode;
  readonly details: readonly string[];

  constructor(code: GraphViolationCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "GraphError";
    this.code = code;
    this.details = details;
  }
}
