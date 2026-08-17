import type { Chunk, Claim, Grounding, Reason, Verdict } from "@provguard/schema";
import type { ClaimAssessment, JudgeAdvisory, JudgeHook } from "./types.js";
import { extractClaims } from "./extract.js";
import { assessClaim, type GroundOptions } from "./ground.js";

export type UnverifiablePolicy = "block" | "quarantine";

export interface AuditOptions extends GroundOptions {
  /**
   * Default is strict: unverifiable claims are non-shippable. Set to
   * `quarantine` only when the caller has a separate quarantine path and wants
   * the legacy permissive rollup.
   */
  unverifiablePolicy?: UnverifiablePolicy;
}

export interface AuditWithJudgeOptions extends AuditOptions {
  /**
   * Caller-injected second opinion for claims no deterministic check could
   * settle. This package never calls an LLM itself.
   */
  judge?: JudgeHook;
}

export interface AuditResult {
  groundings: Grounding[];
  verdict: Verdict;
  /** Per-claim reasoning behind each grounding, in the same order. */
  assessments: ClaimAssessment[];
}

/**
 * Roll per-claim outcomes into one decision. Ungrounded claims always block.
 * Unverifiable claims are also non-shippable by default: the guard could not
 * confirm the output, so the output must not be delivered as though it were
 * sourced. Callers with an explicit quarantine lane can opt into quarantine.
 * An output with no factual claims in it has nothing to be wrong about, so it
 * is allowed.
 */
export function verdictFor(
  assessments: readonly ClaimAssessment[],
  options: { unverifiablePolicy?: UnverifiablePolicy } = {},
): Verdict {
  const reasons: Reason[] = [];
  for (const assessment of assessments) {
    if (assessment.reason) reasons.push(assessment.reason);
  }

  const statuses = new Set(assessments.map((a) => a.grounding.status));
  const decision: Verdict["decision"] = statuses.has("ungrounded")
    ? "block"
    : statuses.has("unverifiable")
      ? (options.unverifiablePolicy ?? "block")
      : "allow";

  return { decision, reasons };
}

function toResult(
  assessments: ClaimAssessment[],
  options: { unverifiablePolicy?: UnverifiablePolicy } = {},
): AuditResult {
  return {
    groundings: assessments.map((a) => a.grounding),
    verdict: verdictFor(assessments, options),
    assessments,
  };
}

/**
 * Audit an output against the chunks that were actually in context.
 *
 * Fully deterministic and synchronous: the same output and the same chunks
 * always produce the same verdict. Use {@link auditOutputWithJudge} to hand
 * undecidable claims to a model.
 */
export function auditOutput(
  output: string,
  chunks: Chunk[],
  options: AuditOptions = {},
): AuditResult {
  return toResult(
    extractClaims(output).map((claim) => assessClaim(claim, chunks, options)),
    options,
  );
}

/**
 * Ground a set of claims that were extracted elsewhere. This is the shape the
 * shared `OutboundGuard` interface asks for.
 */
export function checkGrounding(
  claims: Claim[],
  chunks: Chunk[],
  options: AuditOptions = {},
): AuditResult {
  return toResult(
    claims.map((claim) => assessClaim(claim, chunks, options)),
    options,
  );
}

/** Coerce whatever the judge returned into an advisory worth recording. */
function toAdvisory(result: unknown): JudgeAdvisory | null {
  if (typeof result !== "object" || result === null) return null;
  const candidate = result as Partial<Grounding>;
  if (
    candidate.status !== "grounded" &&
    candidate.status !== "ungrounded" &&
    candidate.status !== "unverifiable"
  ) {
    return null;
  }
  return {
    status: candidate.status,
    supportingChunkIds: Array.isArray(candidate.supportingChunkIds)
      ? [...candidate.supportingChunkIds]
      : [],
    score: typeof candidate.score === "number" ? candidate.score : 0,
    applied: false,
  };
}

/**
 * Audit an output, consulting an injected judge on the claims that no
 * deterministic check could settle.
 *
 * The judge is advisory, and advisory in one direction only. It runs solely on
 * `unverifiable` claims -- wherever a deterministic result exists, that result
 * stays load-bearing and the judge is never asked. On the claims it does see,
 * it can escalate `unverifiable` to `ungrounded`, because a model saying "this
 * is fabricated" is safe to act on; it can never mark anything `grounded`,
 * because a model's say-so is not provenance. Its opinion is recorded on
 * `advisory` either way.
 *
 * Judges run one at a time so an injected network call cannot fan out into a
 * burst, and a judge that throws degrades to the deterministic verdict rather
 * than failing the audit.
 */
export async function auditOutputWithJudge(
  output: string,
  chunks: Chunk[],
  options: AuditWithJudgeOptions = {},
): Promise<AuditResult> {
  const { judge, ...groundOptions } = options;
  const assessments = extractClaims(output).map((claim) =>
    assessClaim(claim, chunks, groundOptions),
  );
  if (!judge) return toResult(assessments, options);

  for (const assessment of assessments) {
    if (assessment.grounding.status !== "unverifiable") continue;

    let advisory: JudgeAdvisory;
    try {
      advisory = toAdvisory(await judge(assessment.claim, chunks)) ?? {
        status: assessment.grounding.status,
        supportingChunkIds: [],
        score: 0,
        applied: false,
        error: "judge returned an unusable result",
      };
    } catch (error) {
      advisory = {
        status: assessment.grounding.status,
        supportingChunkIds: [],
        score: 0,
        applied: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (advisory.status === "ungrounded" && advisory.error === undefined) {
      advisory.applied = true;
      assessment.grounding = {
        claimId: assessment.claim.id,
        status: "ungrounded",
        supportingChunkIds: advisory.supportingChunkIds,
        method: "judge",
        score: 0,
      };
      assessment.decidedBy = "judge";
      assessment.detail = "judge assessed this claim as unsupported by context";
      assessment.reason = {
        code: "CLAIM_UNGROUNDED",
        message: "judge assessed this claim as unsupported by context",
        claimId: assessment.claim.id,
      };
    }
    assessment.advisory = advisory;
  }

  return toResult(assessments, options);
}
