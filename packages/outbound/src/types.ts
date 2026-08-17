import type { Chunk, Claim, CredibilityTier, Grounding, Reason } from "@provguard/schema";

/**
 * Tiers that can never ground a claim on their own: T4 is stale or cached and
 * T5 is unlabeled or unknown. Both are real text that really was in context,
 * so both will happily satisfy a substring match -- but a claim standing only
 * on them is not actually sourced.
 */
export const UNTRUSTED_TIERS = ["T4", "T5"] as const satisfies readonly CredibilityTier[];

/** True when a chunk's tier is too low to carry a claim by itself. */
export function isUntrustedTier(tier: CredibilityTier): boolean {
  return tier === "T4" || tier === "T5";
}

/** True when every chunk supporting a claim is too low-tier to count. */
export function isUntrustedSupport(chunks: readonly Chunk[]): boolean {
  return chunks.length > 0 && chunks.every((chunk) => isUntrustedTier(chunk.provenance.tier));
}

/**
 * The deterministic check that actually decided a claim, at full resolution.
 *
 * The shared `Grounding.method` union is deliberately coarse (`exact` |
 * `fuzzy` | `judge`), so it cannot say whether a match came from normalized
 * substring comparison or from entity overlap. CLAUDE.md requires recording
 * which method produced each result, so the finer stage is preserved here and
 * mapped down when the shared `Grounding` is built.
 */
export type DecisionMethod =
  /** Claim text found verbatim inside a chunk. */
  | "exact"
  /** Found once case, whitespace and punctuation are normalized away. */
  | "normalized"
  /** Every named entity in the claim appears in context. */
  | "entity"
  /** Every numeric literal in the claim appears in context. */
  | "numeric"
  /** Decided on content-word overlap alone, which can only ever reject. */
  | "lexical"
  /** No deterministic check reached a conclusion. */
  | "none"
  /** An injected judge decided, advisory only. */
  | "judge";

/**
 * A claim's outcome with the evidence behind it.
 *
 * `grounding` is the schema-conformant result that crosses package
 * boundaries; the remaining fields are this package's own reasoning, kept so a
 * caller can explain a decision without re-deriving it.
 */
export interface ClaimAssessment {
  claim: Claim;
  grounding: Grounding;
  /** The check that decided, before being flattened into `grounding.method`. */
  decidedBy: DecisionMethod;
  /** Present whenever the claim did not cleanly ground. */
  reason?: Reason;
  /** Human-readable evidence for the decision. */
  detail: string;
  /** Attached when a judge hook ran on this claim. Never load-bearing alone. */
  advisory?: JudgeAdvisory;
}

/**
 * A judge's opinion, recorded alongside the deterministic outcome. `applied`
 * says whether it actually changed anything -- it only ever can when no
 * deterministic check reached a conclusion, and only ever toward stricter.
 */
export interface JudgeAdvisory {
  status: Grounding["status"];
  supportingChunkIds: string[];
  score: number;
  applied: boolean;
  /** Set when the judge hook threw or returned something unusable. */
  error?: string;
}

/**
 * Caller-injected judge. This package never calls an LLM itself; if you want a
 * model in the loop, you own the call, the key and the latency.
 */
export type JudgeHook = (claim: Claim, chunks: Chunk[]) => Promise<Grounding>;
