/**
 * @provguard/outbound -- the outbound provenance guard.
 *
 * One question: does every factual claim in this output trace back to a chunk
 * that was actually in context?
 *
 * Deterministic by construction. No network, no clock, no randomness and no
 * LLM call -- if you want a model's opinion, inject it as a judge hook and it
 * is treated as advice, not as evidence.
 */
import type { OutboundGuard } from "@provguard/schema";
import { extractClaims } from "./extract.js";
import { checkGrounding } from "./audit.js";

export { extractClaims } from "./extract.js";
export { assessClaim, groundClaim, type GroundOptions } from "./ground.js";
export {
  auditOutput,
  auditOutputWithJudge,
  checkGrounding,
  verdictFor,
  type AuditOptions,
  type AuditResult,
  type AuditWithJudgeOptions,
} from "./audit.js";
export {
  UNTRUSTED_TIERS,
  isUntrustedSupport,
  isUntrustedTier,
  type ClaimAssessment,
  type DecisionMethod,
  type JudgeAdvisory,
  type JudgeHook,
} from "./types.js";
export { contentTokens, extractEntities, extractNumbers, normalize, tokenize } from "./text.js";

/** This package's implementation of the shared `OutboundGuard` contract. */
export const outboundGuard: OutboundGuard = {
  extractClaims,
  checkGrounding: (claims, chunks) => checkGrounding(claims, chunks),
};
