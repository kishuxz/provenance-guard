import { z } from "zod";

import { GraphError } from "./codes.js";
import { GRAPH_SCHEMA_VERSION, deriveGraphId } from "./ids.js";
import type { NodeKind } from "./nodes.js";

export const EdgeTypes = [
  "PRODUCED",
  "CONSUMED",
  "DERIVED_FROM",
  "SPLIT_INTO",
  "EXTRACTED_FROM",
  "SUPPORTED_BY",
  "CONTRADICTED_BY",
  "EVALUATED_BY",
  "DECIDES",
  "INCLUDED_IN",
] as const;

export type EdgeType = (typeof EdgeTypes)[number];

export type EdgePair = readonly [from: NodeKind, to: NodeKind];

/**
 * Which `(fromKind, toKind)` pairs each edge type permits.
 *
 * This is data, not validator branches, because three consumers have to agree
 * on it: the validator (G3), the in-memory store, and any database adapter that
 * enforces the same shape in its own query language. A matrix they all read is
 * one contract; three hand-written switch statements are three contracts that
 * drift.
 *
 * Direction is fixed per type and is part of the contract. `SUPPORTED_BY` runs
 * claim to evidence, never the reverse, so a traversal that follows it backward
 * is asking "what did this claim rest on" and can never be read as "what does
 * this chunk prove".
 */
export const EDGE_MATRIX: Readonly<Record<EdgeType, readonly EdgePair[]>> = {
  /** Producer to product. */
  PRODUCED: [
    ["Run", "Step"],
    ["Step", "Artifact"],
    ["Step", "Output"],
    ["Source", "Artifact"],
  ],
  /** Consumer to the thing it read. */
  CONSUMED: [
    ["Step", "Chunk"],
    ["Step", "Artifact"],
  ],
  /** Derived thing to its origin. Acyclic. */
  DERIVED_FROM: [
    ["Artifact", "Artifact"],
    ["Artifact", "Source"],
    ["Chunk", "Chunk"],
  ],
  /** Whole to part. Acyclic. */
  SPLIT_INTO: [["Artifact", "Chunk"]],
  /** Extracted fragment to its container. */
  EXTRACTED_FROM: [["Claim", "Output"]],
  /** Claim to the evidence offered for it. */
  SUPPORTED_BY: [["Claim", "Chunk"]],
  /** Claim to evidence against it. */
  CONTRADICTED_BY: [["Claim", "Chunk"]],
  /** Subject to the immutable policy version applied to it. */
  EVALUATED_BY: [
    ["Chunk", "Policy"],
    ["Claim", "Policy"],
    ["Output", "Policy"],
  ],
  /** Verdict to the subject it decided. */
  DECIDES: [
    ["Verdict", "Chunk"],
    ["Verdict", "Claim"],
    ["Verdict", "Output"],
  ],
  /** Admitted chunk to the assembly step that took it into context. */
  INCLUDED_IN: [["Chunk", "Step"]],
};

/**
 * Edge types that may not contain a cycle.
 *
 * Both express containment or descent: an artifact cannot be derived from
 * itself through any chain, and a chunk cannot be part of something that is
 * part of it. A cycle here is not an unusual graph, it is a corrupt record, and
 * it would make backward traversal non-terminating.
 */
export const ACYCLIC_EDGE_TYPES: readonly EdgeType[] = ["DERIVED_FROM", "SPLIT_INTO"];

/**
 * Edge types whose endpoints must belong to the same run when both have one.
 *
 * `DERIVED_FROM` is deliberately absent: an artifact legitimately derives from
 * one produced by an earlier run, and that cross-run link is what makes impact
 * analysis useful. `EVALUATED_BY` is absent because a policy has no run.
 */
export const RUN_LOCAL_EDGE_TYPES: readonly EdgeType[] = [
  "PRODUCED",
  "CONSUMED",
  "SPLIT_INTO",
  "EXTRACTED_FROM",
  "SUPPORTED_BY",
  "CONTRADICTED_BY",
  "DECIDES",
  "INCLUDED_IN",
];

export const GraphEdgeSchema = z.object({
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
  id: z.string().min(1),
  tenantId: z.string().min(1),
  type: z.enum(EdgeTypes),
  from: z.string().min(1),
  to: z.string().min(1),
  observedAt: z.string().datetime({ offset: true }),
  /** Free-form provenance about the edge itself, such as which stage decided it. */
  note: z.string().min(1).optional(),
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export type GraphEdgeInput = Omit<GraphEdge, "id" | "schemaVersion">;

export function isEdgePairPermitted(type: EdgeType, from: NodeKind, to: NodeKind): boolean {
  return EDGE_MATRIX[type].some((pair) => pair[0] === from && pair[1] === to);
}

export function isAcyclicEdgeType(type: EdgeType): boolean {
  return ACYCLIC_EDGE_TYPES.includes(type);
}

export function isRunLocalEdgeType(type: EdgeType): boolean {
  return RUN_LOCAL_EDGE_TYPES.includes(type);
}

/**
 * Builds an edge, deriving its ID from `(type, from, to)` within the tenant.
 *
 * Recording the same relationship twice is therefore idempotent, which is what
 * makes replaying an audit log converge on the same graph instead of
 * accumulating parallel edges.
 */
export function createEdge(input: GraphEdgeInput): GraphEdge {
  const id = deriveGraphId(input.tenantId, `edge.${input.type}`, {
    from: input.from,
    to: input.to,
  });

  const parsed = GraphEdgeSchema.safeParse({ ...input, id, schemaVersion: GRAPH_SCHEMA_VERSION });
  if (!parsed.success) {
    throw new GraphError(
      "GRAPH_SCHEMA_INVALID",
      `invalid ${input.type} edge`,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  return parsed.data;
}

/** Recomputes an edge's ID from its own fields, for detecting tampering. */
export function expectedEdgeId(edge: GraphEdge): string {
  return deriveGraphId(edge.tenantId, `edge.${edge.type}`, { from: edge.from, to: edge.to });
}
