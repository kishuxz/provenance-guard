import type {
  Explanation,
  GraphInput,
  ImpactResult,
  MemoryGraphStore,
  RunAudit,
  TraceResult,
  ValidationReport,
} from "@provguard/graph";
import type { Chunk, Grounding, Verdict } from "@provguard/schema";

/**
 * The subset of `@provguard/graph` the CLI uses.
 *
 * Declared as an interface and loaded dynamically, matching how the CLI already
 * loads the guards, so one build works both from `src` under vitest and from
 * `dist` as an installed binary.
 */
export interface GraphRuntime {
  buildGraph(audit: RunAudit): GraphInput;
  validateGraph(graph: GraphInput): ValidationReport;
  toCanonicalJSON(graph: GraphInput, options?: { redact?: boolean }): string;
  fromCanonicalJSON(text: string): GraphInput;
  contentDigest(value: string): string;
  MemoryGraphStore: new (graph?: GraphInput) => MemoryGraphStore;
  trace(store: MemoryGraphStore, tenantId: string, targetId: string): TraceResult;
  explain(store: MemoryGraphStore, tenantId: string, targetId: string): Explanation;
  impact(store: MemoryGraphStore, tenantId: string, originId: string): ImpactResult;
}

export interface GraphAuditSource {
  readonly classifiedChunks: readonly Chunk[];
  readonly deliveredChunks: readonly Chunk[];
  readonly inboundVerdicts: readonly { chunkId: string; verdict: Verdict }[];
  readonly outboundVerdict: Verdict;
  readonly groundings: readonly Grounding[];
  readonly claims: readonly { id: string; text: string; spanStart: number; spanEnd: number }[];
  readonly output: string;
  readonly delivered: boolean;
  readonly monitor: boolean;
  readonly slotName: string;
}

export interface BuildAuditOptions {
  readonly tenantId: string;
  readonly observedAt: string;
  readonly policyVersion: string;
}

/**
 * Turns a completed pipeline run into a `RunAudit`.
 *
 * `runKey` is derived from the checked input rather than from a clock or a
 * counter, so re-checking the same file converges on the same `Run` node
 * instead of accumulating a new one per invocation. That is what makes
 * `provguard check` idempotent from the graph's point of view.
 */
export function auditFromPipeline(
  runtime: GraphRuntime,
  source: GraphAuditSource,
  options: BuildAuditOptions,
): RunAudit {
  const delivered = new Set(source.deliveredChunks.map((chunk) => chunk.id));
  const verdictByChunk = new Map(
    source.inboundVerdicts.map(({ chunkId, verdict }) => [chunkId, verdict]),
  );

  const runKey = runtime.contentDigest(
    JSON.stringify([
      source.output,
      source.slotName,
      source.classifiedChunks.map((chunk) => [chunk.id, chunk.provenance.contentHash]),
    ]),
  );

  const groundingByClaim = new Map(
    source.groundings.map((grounding) => [grounding.claimId, grounding]),
  );

  return {
    tenantId: options.tenantId,
    runKey,
    startedAt: options.observedAt,
    observedAt: options.observedAt,
    policy: {
      name: "default",
      version: options.policyVersion,
      contentHash: runtime.contentDigest(`slot-policy:${source.slotName}`),
      mode: source.monitor ? "monitor" : "enforce",
    },
    chunks: source.classifiedChunks.map((chunk) => {
      const verdict = verdictByChunk.get(chunk.id);
      return {
        chunk,
        admitted: delivered.has(chunk.id),
        slot: source.slotName,
        ...(verdict === undefined ? {} : { verdict }),
      };
    }),
    output: { text: source.output, delivered: source.delivered },
    claims: source.claims.map((claim) => {
      const grounding = groundingByClaim.get(claim.id) ?? {
        claimId: claim.id,
        status: "unverifiable" as const,
        supportingChunkIds: [],
        method: "exact" as const,
        score: 0,
      };

      return {
        claim,
        grounding,
        // Every extracted claim is material: extraction already excludes
        // questions, hedges and fenced code, so what survives is an assertion.
        material: true,
        reasonCodes: source.outboundVerdict.reasons
          .filter((reason) => reason.claimId === claim.id)
          .map((reason) => reason.code),
      };
    }),
  };
}

export function formatTrace(store: MemoryGraphStore, result: TraceResult): string {
  const lines = [`target: ${result.target.id}`, `kind: ${result.target.kind}`];

  if (result.paths.length === 0 || result.paths.every((path) => path.nodes.length === 1)) {
    // Not an error. A claim that rests on nothing is a finding, and saying so
    // plainly beats an empty section the reader has to interpret.
    lines.push("no supporting path: this target does not rest on any recorded evidence");
  } else {
    lines.push(`paths: ${result.paths.length}`);
    for (const [index, path] of result.paths.entries()) {
      lines.push(`  path ${index + 1}:`);
      for (const [position, nodeId] of path.nodes.entries()) {
        const described = describe(store, result.target.tenantId, nodeId);
        if (position === 0) {
          lines.push(`    ${described}`);
          continue;
        }

        // The edge type is printed, not just the nodes. Two paths can share a
        // node sequence and differ only in the relationship traversed, and
        // rendering nodes alone would show them as duplicates.
        const edgeId = path.edges[position - 1];
        const edge = edgeId === undefined ? undefined : store.edge(result.target.tenantId, edgeId);
        lines.push(`      -[${edge?.type ?? "?"}]-> ${described}`);
      }
    }
  }

  lines.push(
    `sources: ${result.sources.length === 0 ? "-" : result.sources.map((source) => source.uri).join(", ")}`,
  );

  if (result.truncated) {
    lines.push("truncated: yes (bounds reached; these paths are not exhaustive)");
  }

  return lines.join("\n");
}

export function formatExplain(store: MemoryGraphStore, result: Explanation): string {
  const lines = [`target: ${result.target.id}`, `kind: ${result.target.kind}`];

  if (result.verdict === null) {
    lines.push("verdict: none recorded");
  } else {
    lines.push(`decision: ${result.verdict.decision}`);
    lines.push(`method: ${result.method ?? "-"}`);
    lines.push(`mode: ${result.monitored === true ? "monitor" : "enforce"}`);
    if (result.monitored === true && result.verdict.decision !== "allow") {
      lines.push("note: recorded in monitor mode, so this decision was not enforced");
    }
    lines.push(`reasons: ${result.reasonCodes.length === 0 ? "-" : result.reasonCodes.join(", ")}`);
  }

  lines.push(
    result.policy === null
      ? "policy: none recorded"
      : `policy: ${result.policy.name}@${result.policy.version} (${result.policy.contentHash})`,
  );

  if (result.decisionPaths.length === 0) {
    lines.push("evidence: none recorded");
  } else {
    lines.push("evidence:");
    for (const path of result.decisionPaths) {
      for (const nodeId of path.nodes) {
        lines.push(`  ${describe(store, result.target.tenantId, nodeId)}`);
      }
    }
  }

  return lines.join("\n");
}

export function formatImpact(result: ImpactResult): string {
  return [
    `origin: ${result.origin.id}`,
    `kind: ${result.origin.kind}`,
    `affected claims: ${result.claims.length}`,
    ...result.claims.map((entry) => `  ${entry.node.id} (distance ${entry.distance})`),
    `affected outputs: ${result.outputs.length}`,
    ...result.outputs.map(
      (entry) =>
        `  ${entry.node.id} (distance ${entry.distance}, ${entry.node.delivered ? "delivered" : "not delivered"})`,
    ),
    `delivered outputs: ${result.deliveredOutputs.length}`,
    `affected runs: ${result.runs.length}`,
    ...result.runs.map((entry) => `  ${entry.node.id} (distance ${entry.distance})`),
    ...(result.truncated ? ["truncated: yes (bounds reached; this list is not exhaustive)"] : []),
  ].join("\n");
}

export function formatValidation(report: ValidationReport): string {
  if (report.valid) {
    return "graph valid: no violations";
  }

  return [
    `graph invalid: ${report.violations.length} violation${report.violations.length === 1 ? "" : "s"}`,
    ...report.violations.map(
      (violation) =>
        `  ${violation.code} ${violation.elementType} ${violation.elementId}: ${violation.message}`,
    ),
  ].join("\n");
}

/** One line describing a node, enough to read a path without another lookup. */
function describe(store: MemoryGraphStore, tenantId: string, nodeId: string): string {
  const node = store.node(tenantId, nodeId);
  if (node === undefined) {
    return `${nodeId} (missing)`;
  }

  switch (node.kind) {
    case "Source":
      return `Source ${node.uri}`;
    case "Chunk":
      return `Chunk ${node.channel}/${node.tier} ${node.admitted ? "admitted" : "REFUSED"} ${node.id}`;
    case "Claim":
      return `Claim ${node.id}`;
    case "Artifact":
      return `Artifact ${node.contentHash}`;
    case "Output":
      return `Output ${node.delivered ? "delivered" : "not delivered"} ${node.id}`;
    case "Step":
      return `Step ${node.stepKind} ${node.name}`;
    default:
      return `${node.kind} ${node.id}`;
  }
}
