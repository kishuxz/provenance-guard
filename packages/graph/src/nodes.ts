import { z } from "zod";

import { ChannelTypeSchema, CredibilityTierSchema, ReasonCodeSchema } from "@provguard/schema";

import { GraphError } from "./codes.js";
import { GRAPH_SCHEMA_VERSION, deriveGraphId, type IdentityFields } from "./ids.js";

export const NodeKinds = [
  "Source",
  "Run",
  "Step",
  "Artifact",
  "Chunk",
  "Claim",
  "Policy",
  "Verdict",
  "Output",
] as const;

export type NodeKind = (typeof NodeKinds)[number];

const timestamp = z.string().datetime({ offset: true });
const nonEmpty = z.string().min(1);

/**
 * Fields every node carries.
 *
 * `observedAt` is when this fact entered the ledger, not when the underlying
 * event happened. Kinds that have their own event time carry it separately
 * (`Chunk.retrievedAt`, `Run.startedAt`, `Verdict.decidedAt`). Keeping the two
 * apart is what makes the graph temporal rather than merely timestamped: a
 * chunk retrieved in 2023 and observed today is a different fact from one
 * retrieved today, and collapsing them is exactly the confusion behind the
 * `hard-fresh-timestamp-stale-body` scenario.
 */
const base = {
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
  id: nonEmpty,
  tenantId: nonEmpty,
  observedAt: timestamp,
};

export const SourceNodeSchema = z.object({
  ...base,
  kind: z.literal("Source"),
  uri: nonEmpty,
  sourceKind: z.enum(["tool", "retrieval", "user", "cache", "system", "unknown"]),
});

export const RunNodeSchema = z.object({
  ...base,
  kind: z.literal("Run"),
  runKey: nonEmpty,
  startedAt: timestamp,
});

export const StepNodeSchema = z.object({
  ...base,
  kind: z.literal("Step"),
  runId: nonEmpty,
  index: z.number().int().nonnegative(),
  name: nonEmpty,
  stepKind: z.enum(["retrieve", "tool_call", "transform", "assemble", "generate"]),
});

export const ArtifactNodeSchema = z.object({
  ...base,
  kind: z.literal("Artifact"),
  runId: nonEmpty,
  contentHash: nonEmpty,
  mediaType: nonEmpty.optional(),
  byteLength: z.number().int().nonnegative().optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
});

export const ChunkNodeSchema = z.object({
  ...base,
  kind: z.literal("Chunk"),
  runId: nonEmpty,
  contentHash: nonEmpty,
  ordinal: z.number().int().nonnegative(),
  text: z.string(),
  channel: ChannelTypeSchema,
  tier: CredibilityTierSchema,
  retrievedAt: timestamp,
  /**
   * Whether the inbound guard admitted this chunk into a context slot. The
   * graph records rejected chunks too — a rejected chunk that something later
   * claims support from is the violation `GRAPH_SUPPORT_FROM_BLOCKED_CHUNK`
   * exists to catch, and it cannot be caught if rejections are not stored.
   */
  admitted: z.boolean(),
  slot: nonEmpty.optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
});

export const ClaimNodeSchema = z.object({
  ...base,
  kind: z.literal("Claim"),
  runId: nonEmpty,
  outputRef: nonEmpty,
  text: nonEmpty,
  spanStart: z.number().int().nonnegative(),
  spanEnd: z.number().int().nonnegative(),
  /**
   * A material claim is one the policy treats as load-bearing. Non-material
   * claims (hedges, questions) are recorded but are not required to have
   * support, so the distinction has to survive into the graph.
   */
  material: z.boolean(),
});

export const PolicyNodeSchema = z.object({
  ...base,
  kind: z.literal("Policy"),
  name: nonEmpty,
  /** Immutable version identifier. A changed policy is a new node, never an edit. */
  version: nonEmpty,
  contentHash: nonEmpty,
  mode: z.enum(["monitor", "enforce"]),
});

export const VerdictNodeSchema = z.object({
  ...base,
  kind: z.literal("Verdict"),
  runId: nonEmpty,
  targetRef: nonEmpty,
  policyRef: nonEmpty,
  decision: z.enum(["allow", "quarantine", "block"]),
  reasonCodes: z.array(ReasonCodeSchema),
  /**
   * Which mechanism produced this verdict. A judge-decided verdict is recorded
   * as such and can never be relabelled deterministic, so a model-assisted
   * decision is always distinguishable from a derived fact.
   */
  method: z.enum(["deterministic", "judge"]),
  /**
   * True when the policy was in monitor mode: the verdict was recorded and the
   * material was delivered anyway. `decision` still says what would have
   * happened, so switching to enforcement does not change decision semantics.
   */
  monitored: z.boolean(),
  decidedAt: timestamp,
  inputHash: nonEmpty,
});

export const OutputNodeSchema = z.object({
  ...base,
  kind: z.literal("Output"),
  runId: nonEmpty,
  contentHash: nonEmpty,
  text: z.string(),
  delivered: z.boolean(),
});

export const GraphNodeSchema = z.discriminatedUnion("kind", [
  SourceNodeSchema,
  RunNodeSchema,
  StepNodeSchema,
  ArtifactNodeSchema,
  ChunkNodeSchema,
  ClaimNodeSchema,
  PolicyNodeSchema,
  VerdictNodeSchema,
  OutputNodeSchema,
]);

export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type SourceNode = z.infer<typeof SourceNodeSchema>;
export type RunNode = z.infer<typeof RunNodeSchema>;
export type StepNode = z.infer<typeof StepNodeSchema>;
export type ArtifactNode = z.infer<typeof ArtifactNodeSchema>;
export type ChunkNode = z.infer<typeof ChunkNodeSchema>;
export type ClaimNode = z.infer<typeof ClaimNodeSchema>;
export type PolicyNode = z.infer<typeof PolicyNodeSchema>;
export type VerdictNode = z.infer<typeof VerdictNodeSchema>;
export type OutputNode = z.infer<typeof OutputNodeSchema>;

/** A node as a caller supplies it: identity and schema version are derived. */
export type GraphNodeInput = GraphNode extends infer Node
  ? Node extends GraphNode
    ? Omit<Node, "id" | "schemaVersion">
    : never
  : never;

/**
 * Attributes that carry raw material rather than metadata about it.
 *
 * Export redacts these by default. The map is exhaustive over `NodeKind` at the
 * type level, so adding a node kind without deciding what of it is sensitive is
 * a compile error rather than a silent leak.
 */
export const REDACTABLE_ATTRIBUTES: Readonly<Record<NodeKind, readonly string[]>> = {
  // Not redactable, and deliberately so. `uri` is a Source identity field, so
  // blanking it on export would leave the node's id un-derivable and every
  // redacted export failing GRAPH_ID_MISMATCH. Credentials are handled at the
  // other end instead: `stripCredentials` removes URI userinfo when the node is
  // created, so the secret is never recorded rather than recorded and hidden.
  // Every attribute listed below is a non-identity field, which is what lets a
  // redacted export still validate.
  Source: [],
  Run: [],
  Step: [],
  // Artifacts are recorded by hash and status only; there is no body to leak.
  Artifact: [],
  Chunk: ["text"],
  Claim: ["text"],
  Policy: [],
  Verdict: [],
  Output: ["text"],
};

/**
 * The fields that determine a node's identity.
 *
 * Everything else is an attribute: an observation about the node that may be
 * enriched later without making it a different node. Getting this split wrong
 * in either direction is costly — too many fields and replaying the same run
 * produces duplicate nodes, too few and two distinct facts collide.
 */
export function identityFields(node: GraphNodeInput): IdentityFields {
  switch (node.kind) {
    case "Source":
      return { uri: node.uri, sourceKind: node.sourceKind };
    case "Run":
      return { runKey: node.runKey };
    case "Step":
      return { runId: node.runId, index: node.index };
    case "Artifact":
      return { runId: node.runId, contentHash: node.contentHash };
    case "Chunk":
      return { runId: node.runId, contentHash: node.contentHash, ordinal: node.ordinal };
    case "Claim":
      return {
        runId: node.runId,
        outputRef: node.outputRef,
        spanStart: node.spanStart,
        spanEnd: node.spanEnd,
      };
    case "Policy":
      return { name: node.name, version: node.version };
    case "Verdict":
      return { runId: node.runId, targetRef: node.targetRef, policyRef: node.policyRef };
    case "Output":
      return { runId: node.runId, contentHash: node.contentHash };
  }
}

/**
 * Builds a node, deriving its ID from its identity fields.
 *
 * Callers cannot supply an ID. That is the point: an ID a caller chose is a
 * claim about identity, and the graph only records identity it derived itself.
 */
export function createNode(input: GraphNodeInput): GraphNode {
  const normalized =
    input.kind === "Source" ? { ...input, uri: stripCredentials(input.uri) } : input;
  const id = deriveGraphId(normalized.tenantId, normalized.kind, identityFields(normalized));
  const candidate = { ...normalized, id, schemaVersion: GRAPH_SCHEMA_VERSION };

  const parsed = GraphNodeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new GraphError(
      "GRAPH_SCHEMA_INVALID",
      `invalid ${input.kind} node`,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  return parsed.data;
}

/**
 * Removes the userinfo component of a URI, so credentials are never recorded.
 *
 * Done at creation rather than at export because a secret that reaches storage
 * has already leaked — an export filter only protects the copies that go
 * through it, not the database, the logs, or a debugger.
 *
 * The query string is deliberately kept. It routinely distinguishes two
 * genuinely different documents, and dropping it would collapse distinct
 * sources onto one node: a correctness loss traded for a partial secrecy gain.
 * A URI that is not parseable is returned unchanged rather than discarded,
 * since a source we cannot parse is still a source we must record.
 */
export function stripCredentials(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.username === "" && parsed.password === "") {
      return uri;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return uri;
  }
}

/** Recomputes a node's ID from its own fields, for detecting tampering. */
export function expectedNodeId(node: GraphNode): string {
  return deriveGraphId(node.tenantId, node.kind, identityFields(node));
}

/** The run a node belongs to, or `null` for kinds that outlive a single run. */
export function runOf(node: GraphNode): string | null {
  switch (node.kind) {
    case "Source":
    case "Policy":
      return null;
    case "Run":
      return node.id;
    default:
      return node.runId;
  }
}
