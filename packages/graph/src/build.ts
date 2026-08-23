import type { Chunk, Claim, Grounding, ReasonCode, Verdict } from "@provguard/schema";

import { createEdge, type GraphEdge } from "./edges.js";
import { contentDigest } from "./ids.js";
import { createNode, type GraphNode, type SourceNode } from "./nodes.js";
import type { GraphInput } from "./validate.js";

/**
 * One chunk as the inbound guard left it.
 *
 * `admitted` is the guard's answer, not an inference from `verdict`: a caller
 * may run in monitor mode, where the verdict says block and the chunk was
 * delivered anyway. Deriving one from the other would erase that distinction.
 */
export interface RunAuditChunk {
  readonly chunk: Chunk;
  readonly admitted: boolean;
  readonly slot?: string;
  /** The inbound verdict recorded for this chunk, if one was produced. */
  readonly verdict?: Verdict;
  /** Where the material came from. Defaults to the chunk's own sourceId. */
  readonly sourceUri?: string;
  readonly sourceKind?: SourceNode["sourceKind"];
}

/** One claim as the outbound guard left it. */
export interface RunAuditClaim {
  readonly claim: Claim;
  readonly grounding: Grounding;
  /**
   * Whether policy treats this claim as load-bearing. Hedges and questions are
   * recorded but are not required to have support.
   */
  readonly material: boolean;
  readonly reasonCodes?: readonly ReasonCode[];
}

export interface RunAuditPolicy {
  readonly name: string;
  readonly version: string;
  readonly contentHash: string;
  readonly mode: "monitor" | "enforce";
}

/**
 * A single run's guard activity, in shared schema types.
 *
 * Deliberately neutral: `@provguard/graph` does not import the guards. The
 * graph records what they decided, and a dependency in that direction would
 * make the model track their internals.
 */
export interface RunAudit {
  readonly tenantId: string;
  /** Stable key identifying this run. Two audits with the same key are one run. */
  readonly runKey: string;
  readonly startedAt: string;
  /** When these facts entered the ledger. */
  readonly observedAt: string;
  readonly policy: RunAuditPolicy;
  readonly chunks: readonly RunAuditChunk[];
  readonly output: { readonly text: string; readonly delivered: boolean };
  readonly claims: readonly RunAuditClaim[];
}

const RETRIEVE_STEP = 0;
const ASSEMBLE_STEP = 1;
const GENERATE_STEP = 2;

/**
 * Turns one run's audit into a lineage graph.
 *
 * The builder records what happened, including when what happened was wrong. A
 * claim grounded on a chunk the guard refused produces exactly that shape, and
 * `validateGraph` reports it — the builder must not quietly drop the edge to
 * make its own output validate, because the whole point of the ledger is to
 * make that failure visible.
 */
export function buildGraph(audit: RunAudit): GraphInput {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const at = audit.observedAt;
  const tenantId = audit.tenantId;

  const edge = (type: GraphEdge["type"], from: string, to: string): void => {
    edges.push(createEdge({ tenantId, type, from, to, observedAt: at }));
  };

  const run = createNode({
    kind: "Run",
    tenantId,
    observedAt: at,
    runKey: audit.runKey,
    startedAt: audit.startedAt,
  });
  nodes.push(run);

  const policy = createNode({
    kind: "Policy",
    tenantId,
    observedAt: at,
    name: audit.policy.name,
    version: audit.policy.version,
    contentHash: audit.policy.contentHash,
    mode: audit.policy.mode,
  });
  nodes.push(policy);

  const steps = (
    [
      [RETRIEVE_STEP, "retrieve", "retrieve"],
      [ASSEMBLE_STEP, "assemble-context", "assemble"],
      [GENERATE_STEP, "generate-output", "generate"],
    ] as const
  ).map(([index, name, stepKind]) => {
    const step = createNode({
      kind: "Step",
      tenantId,
      observedAt: at,
      runId: run.id,
      index,
      name,
      stepKind,
    });
    nodes.push(step);
    edge("PRODUCED", run.id, step.id);
    return step;
  });

  const [retrieveStep, assembleStep, generateStep] = steps as [GraphNode, GraphNode, GraphNode];

  const monitored = audit.policy.mode === "monitor";
  const chunkIdByAuditId = new Map<string, string>();
  const seenSources = new Set<string>();

  audit.chunks.forEach((entry, ordinal) => {
    const provenance = entry.chunk.provenance;

    const source = createNode({
      kind: "Source",
      tenantId,
      observedAt: at,
      uri: entry.sourceUri ?? provenance.sourceId,
      sourceKind: entry.sourceKind ?? sourceKindForChannel(provenance.channel),
    });
    if (!seenSources.has(source.id)) {
      seenSources.add(source.id);
      nodes.push(source);
    }

    const artifact = createNode({
      kind: "Artifact",
      tenantId,
      observedAt: at,
      runId: run.id,
      contentHash: provenance.contentHash,
      ...(provenance.upstreamStatus === undefined
        ? {}
        : { upstreamStatus: provenance.upstreamStatus }),
    });
    nodes.push(artifact);

    const chunk = createNode({
      kind: "Chunk",
      tenantId,
      observedAt: at,
      runId: run.id,
      contentHash: provenance.contentHash,
      ordinal,
      text: entry.chunk.text,
      channel: provenance.channel,
      tier: provenance.tier,
      retrievedAt: provenance.retrievedAt,
      admitted: entry.admitted,
      ...(entry.slot === undefined ? {} : { slot: entry.slot }),
      ...(provenance.upstreamStatus === undefined
        ? {}
        : { upstreamStatus: provenance.upstreamStatus }),
    });
    nodes.push(chunk);
    chunkIdByAuditId.set(entry.chunk.id, chunk.id);

    // PRODUCED only. Also emitting DERIVED_FROM artifact -> source would state
    // the same relationship twice in opposite directions, and backward
    // traversal would then return two paths that differ by nothing a reader
    // can see. The edge matrix still permits Artifact -> Source derivation for
    // the case where an artifact descends from a source that did not produce
    // it; this builder simply has no such case.
    edge("PRODUCED", source.id, artifact.id);
    edge("PRODUCED", retrieveStep.id, artifact.id);
    edge("SPLIT_INTO", artifact.id, chunk.id);
    edge("EVALUATED_BY", chunk.id, policy.id);

    // Only an admitted chunk entered context. A refused chunk stays in the
    // graph so a claim that later cites it has something to point at, but it
    // never gets the edge that says it was assembled.
    if (entry.admitted) {
      edge("CONSUMED", assembleStep.id, chunk.id);
      edge("INCLUDED_IN", chunk.id, assembleStep.id);
    }

    if (entry.verdict !== undefined) {
      const verdict = createNode({
        kind: "Verdict",
        tenantId,
        observedAt: at,
        runId: run.id,
        targetRef: chunk.id,
        policyRef: policy.id,
        decision: entry.verdict.decision,
        reasonCodes: entry.verdict.reasons.map((reason) => reason.code),
        method: "deterministic",
        monitored,
        decidedAt: at,
        inputHash: contentDigest(entry.chunk.text),
      });
      nodes.push(verdict);
      edge("DECIDES", verdict.id, chunk.id);
    }
  });

  const output = createNode({
    kind: "Output",
    tenantId,
    observedAt: at,
    runId: run.id,
    contentHash: contentDigest(audit.output.text),
    text: audit.output.text,
    delivered: audit.output.delivered,
  });
  nodes.push(output);
  edge("PRODUCED", generateStep.id, output.id);
  edge("EVALUATED_BY", output.id, policy.id);

  for (const entry of audit.claims) {
    const claim = createNode({
      kind: "Claim",
      tenantId,
      observedAt: at,
      runId: run.id,
      outputRef: output.id,
      text: entry.claim.text,
      spanStart: entry.claim.spanStart,
      spanEnd: entry.claim.spanEnd,
      material: entry.material,
    });
    nodes.push(claim);

    edge("EXTRACTED_FROM", claim.id, output.id);
    edge("EVALUATED_BY", claim.id, policy.id);

    // Exactly the chunks the grounding named. Widening this to "every admitted
    // chunk" would manufacture support the guard never found.
    for (const supportingId of entry.grounding.supportingChunkIds) {
      const target = chunkIdByAuditId.get(supportingId);
      if (target !== undefined) {
        edge("SUPPORTED_BY", claim.id, target);
      }
    }

    const verdict = createNode({
      kind: "Verdict",
      tenantId,
      observedAt: at,
      runId: run.id,
      targetRef: claim.id,
      policyRef: policy.id,
      decision: decisionForGrounding(entry.grounding.status),
      reasonCodes: [...(entry.reasonCodes ?? [])],
      // A judge-decided claim is recorded as such and can never be relabelled
      // deterministic, so a model-assisted decision stays distinguishable.
      method: entry.grounding.method === "judge" ? "judge" : "deterministic",
      monitored,
      decidedAt: at,
      inputHash: contentDigest(entry.claim.text),
    });
    nodes.push(verdict);
    edge("DECIDES", verdict.id, claim.id);
  }

  return { nodes: dedupeById(nodes), edges: dedupeById(edges) };
}

function decisionForGrounding(status: Grounding["status"]): Verdict["decision"] {
  if (status === "grounded") {
    return "allow";
  }
  return status === "unverifiable" ? "quarantine" : "block";
}

/**
 * Best-effort mapping from the channel a chunk was classified into to the kind
 * of source it came from. Only used when the caller did not say.
 */
function sourceKindForChannel(channel: Chunk["provenance"]["channel"]): SourceNode["sourceKind"] {
  switch (channel) {
    case "RETRIEVED_DOC":
      return "retrieval";
    case "TOOL_RESULT":
      return "tool";
    case "USER_MESSAGE":
      return "user";
    case "CACHE":
      return "cache";
    case "SYSTEM_ALERT":
    case "DIAGNOSTIC_LOG":
      return "system";
    default:
      return "unknown";
  }
}

/**
 * Identity is derived, so recording the same fact twice yields the same ID and
 * collapsing duplicates is safe. Two chunks from one artifact, or two runs of
 * the same audit, converge instead of accumulating parallel elements.
 */
function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}
