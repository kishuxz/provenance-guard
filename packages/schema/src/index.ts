import { z } from "zod";

export const ChannelTypeSchema = z.enum([
  "USER_MESSAGE",
  "RETRIEVED_DOC",
  "TOOL_RESULT",
  "SYSTEM_ALERT",
  "DIAGNOSTIC_LOG",
  "AGENT_OUTPUT",
  "CACHE",
  "UNLABELED",
]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const CredibilityTierSchema = z.enum(["T1", "T2", "T3", "T4", "T5"]);
export type CredibilityTier = z.infer<typeof CredibilityTierSchema>;

export const CredibilityTierDescriptions = {
  T1: "verified primary",
  T2: "tool result with explicit ok status",
  T3: "third-party retrieved",
  T4: "stale or cached",
  T5: "unlabeled/unknown",
} as const satisfies Record<CredibilityTier, string>;

export const ProvenanceSchema = z.object({
  sourceId: z.string().min(1),
  channel: ChannelTypeSchema,
  tier: CredibilityTierSchema,
  retrievedAt: z.string().datetime({ offset: true }),
  contentHash: z.string().min(1),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
  parentSourceId: z.string().min(1).optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ChunkSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  provenance: ProvenanceSchema,
});
export type Chunk = z.infer<typeof ChunkSchema>;

export const ContextSlotSchema = z.object({
  name: z.string().min(1),
  allowedChannels: z.array(ChannelTypeSchema),
  minTier: CredibilityTierSchema,
});
export type ContextSlot = z.infer<typeof ContextSlotSchema>;

export const DefaultDenyRuleSchema = z.object({
  decision: z.literal("deny"),
  appliesWhen: z.literal("no_slot_match"),
});
export type DefaultDenyRule = z.infer<typeof DefaultDenyRuleSchema>;

export const SlotPolicySchema = z.object({
  slots: z.array(ContextSlotSchema),
  defaultRule: DefaultDenyRuleSchema,
});
export type SlotPolicy = z.infer<typeof SlotPolicySchema>;

export const ReasonCodes = [
  "CHANNEL_NOT_PERMITTED",
  "TIER_BELOW_MINIMUM",
  "UPSTREAM_STATUS_NOT_OK",
  "PAYLOAD_EMPTY",
  "PAYLOAD_TRUNCATED",
  "CLAIM_UNGROUNDED",
  "CLAIM_SUPPORT_LOW_TIER",
  "CLAIM_UNVERIFIABLE",
  /** The declared channel, tier or status disagrees with what the payload contains. */
  "PROVENANCE_LABEL_MISMATCH",
  /** The payload reports success while carrying a fallback, placeholder or degraded result. */
  "RESULT_DEGRADED",
] as const;

export const ReasonCodeSchema = z.enum(ReasonCodes);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const ReasonSchema = z.object({
  code: ReasonCodeSchema,
  message: z.string().min(1),
  chunkId: z.string().min(1).optional(),
  claimId: z.string().min(1).optional(),
});
export type Reason = z.infer<typeof ReasonSchema>;

export const VerdictSchema = z.object({
  decision: z.enum(["allow", "quarantine", "block"]),
  reasons: z.array(ReasonSchema),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const ClaimSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    spanStart: z.number().int().nonnegative(),
    spanEnd: z.number().int().nonnegative(),
  })
  .refine((claim) => claim.spanEnd >= claim.spanStart, {
    message: "spanEnd must be greater than or equal to spanStart",
    path: ["spanEnd"],
  });
export type Claim = z.infer<typeof ClaimSchema>;

export const GroundingSchema = z.object({
  claimId: z.string().min(1),
  status: z.enum(["grounded", "ungrounded", "unverifiable"]),
  supportingChunkIds: z.array(z.string().min(1)),
  method: z.enum(["exact", "fuzzy", "judge"]),
  score: z.number().min(0).max(1),
});
export type Grounding = z.infer<typeof GroundingSchema>;

export const ScenarioExpectationSchema = z.enum(["should_block", "should_allow"]);
export type ScenarioExpectation = z.infer<typeof ScenarioExpectationSchema>;

export const ScenarioProvenanceSchema = z.enum(["derived", "constructed"]);
export type ScenarioProvenance = z.infer<typeof ScenarioProvenanceSchema>;

/**
 * `basic` is pollution visible in the shape of the payload. `hard` is a
 * near miss: well formed, correctly labelled, and wrong in what it means.
 * `mixed` is one chunk carrying genuine data *and* pollution, which is what a
 * real retrieval pipeline actually produces.
 *
 * Exported as an array so consumers can iterate rather than hardcode the tier
 * names; adding a tier should not require editing every report builder.
 */
export const ScenarioDifficulties = ["basic", "hard", "mixed"] as const;
export const ScenarioDifficultySchema = z.enum(ScenarioDifficulties);
export type ScenarioDifficulty = z.infer<typeof ScenarioDifficultySchema>;

export const ScenarioExpectedGateSchema = z.enum(["inbound", "outbound", "either"]);
export type ScenarioExpectedGate = z.infer<typeof ScenarioExpectedGateSchema>;

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mechanism: z.string().min(1),
  description: z.string().min(1),
  provenance: ScenarioProvenanceSchema,
  sourceNote: z.string().min(1),
  chunks: z.array(ChunkSchema),
  simulatedOutput: z.string(),
  expectation: ScenarioExpectationSchema,
  difficulty: ScenarioDifficultySchema,
  expectedGate: ScenarioExpectedGateSchema,
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export interface InboundGuard {
  classifyChunk(raw: string, hints?: Partial<Provenance>): Chunk;
  checkSlot(chunk: Chunk, slot: ContextSlot): Verdict;
  assembleContext(
    chunks: Chunk[],
    policy: SlotPolicy,
  ): {
    assembled: Record<string, Chunk[]>;
    verdicts: Verdict[];
  };
}

export interface OutboundGuard {
  extractClaims(text: string): Claim[];
  checkGrounding(
    claims: Claim[],
    chunks: Chunk[],
  ): {
    groundings: Grounding[];
    verdict: Verdict;
  };
}

export interface GuardPair {
  inbound: InboundGuard;
  outbound: OutboundGuard;
}
