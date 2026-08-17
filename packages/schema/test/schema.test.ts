import { describe, expect, it } from "vitest";
import {
  ChannelTypeSchema,
  ChunkSchema,
  ClaimSchema,
  ContextSlotSchema,
  CredibilityTierSchema,
  DefaultDenyRuleSchema,
  GroundingSchema,
  ProvenanceSchema,
  ReasonCodeSchema,
  ReasonCodes,
  ReasonSchema,
  SlotPolicySchema,
  VerdictSchema,
} from "../src/index.js";

const validProvenance = {
  sourceId: "source-1",
  channel: "TOOL_RESULT",
  tier: "T2",
  retrievedAt: "2026-08-17T18:30:00.000Z",
  contentHash: "sha256:4f8b6d9c",
  upstreamStatus: 200,
  parentSourceId: "source-root",
} as const;

const validChunk = {
  id: "chunk-1",
  text: "Observed value: 42.",
  provenance: validProvenance,
} as const;

const validReason = {
  code: "CHANNEL_NOT_PERMITTED",
  message: "The chunk channel is not allowed in this slot.",
  chunkId: "chunk-1",
} as const;

describe("ChannelTypeSchema", () => {
  it("parses valid channel values", () => {
    expect(ChannelTypeSchema.parse("USER_MESSAGE")).toBe("USER_MESSAGE");
  });

  it("rejects unknown channel values with enum details", () => {
    const result = ChannelTypeSchema.safeParse("PRIMARY_SOURCE");

    expect(result.success).toBe(false);
    expectIssue(result, "invalid_value");
  });
});

describe("CredibilityTierSchema", () => {
  it("parses valid tier values", () => {
    expect(CredibilityTierSchema.parse("T1")).toBe("T1");
  });

  it("rejects tiers outside T1 through T5", () => {
    const result = CredibilityTierSchema.safeParse("T0");

    expect(result.success).toBe(false);
    expectIssue(result, "invalid_value");
  });
});

describe("ProvenanceSchema", () => {
  it("parses valid provenance objects", () => {
    expect(ProvenanceSchema.parse(validProvenance)).toEqual(validProvenance);
  });

  it("rejects invalid upstream status values with a useful path", () => {
    const result = ProvenanceSchema.safeParse({ ...validProvenance, upstreamStatus: 99 });

    expect(result.success).toBe(false);
    expectIssue(result, "too_small", ["upstreamStatus"]);
  });

  it("rejects timestamps that are not datetimes", () => {
    const result = ProvenanceSchema.safeParse({ ...validProvenance, retrievedAt: "today" });

    expect(result.success).toBe(false);
    expectIssue(result, "invalid_format", ["retrievedAt"]);
  });
});

describe("ChunkSchema", () => {
  it("parses valid chunks", () => {
    expect(ChunkSchema.parse(validChunk)).toEqual(validChunk);
  });

  it("rejects chunks without ids", () => {
    const result = ChunkSchema.safeParse({ ...validChunk, id: "" });

    expect(result.success).toBe(false);
    expectIssue(result, "too_small", ["id"]);
  });
});

describe("ContextSlotSchema", () => {
  it("parses valid context slots", () => {
    const slot = {
      name: "signals",
      allowedChannels: ["USER_MESSAGE", "TOOL_RESULT"],
      minTier: "T3",
    };

    expect(ContextSlotSchema.parse(slot)).toEqual(slot);
  });

  it("rejects invalid allowed channel entries", () => {
    const result = ContextSlotSchema.safeParse({
      name: "signals",
      allowedChannels: ["SYSTEM_ALERT", "UNKNOWN"],
      minTier: "T3",
    });

    expect(result.success).toBe(false);
    expectIssue(result, "invalid_value", ["allowedChannels", 1]);
  });
});

describe("SlotPolicySchema", () => {
  it("parses policies with an explicit default-deny rule", () => {
    const policy = {
      slots: [
        {
          name: "signals",
          allowedChannels: ["USER_MESSAGE", "TOOL_RESULT"],
          minTier: "T3",
        },
      ],
      defaultRule: {
        decision: "deny",
        appliesWhen: "no_slot_match",
      },
    };

    expect(SlotPolicySchema.parse(policy)).toEqual(policy);
  });

  it("rejects policies that do not explicitly deny by default", () => {
    const result = SlotPolicySchema.safeParse({
      slots: [],
      defaultRule: {
        decision: "allow",
        appliesWhen: "no_slot_match",
      },
    });

    expect(result.success).toBe(false);
    expectIssue(result, "invalid_value", ["defaultRule", "decision"]);
  });
});

describe("DefaultDenyRuleSchema", () => {
  it("parses the default-deny rule", () => {
    expect(
      DefaultDenyRuleSchema.parse({
        decision: "deny",
        appliesWhen: "no_slot_match",
      }),
    ).toEqual({
      decision: "deny",
      appliesWhen: "no_slot_match",
    });
  });

  it("rejects implicit or differently scoped defaults", () => {
    const result = DefaultDenyRuleSchema.safeParse({
      decision: "deny",
      appliesWhen: "low_confidence",
    });

    expect(result.success).toBe(false);
    expectIssue(result, "invalid_value", ["appliesWhen"]);
  });
});

describe("ReasonCodeSchema", () => {
  it("parses every stable reason code", () => {
    expect(ReasonCodes.map((code) => ReasonCodeSchema.parse(code))).toEqual([...ReasonCodes]);
  });

  it("rejects ad hoc reason codes", () => {
    const result = ReasonCodeSchema.safeParse("BAD_THING_HAPPENED");

    expect(result.success).toBe(false);
    expectIssue(result, "invalid_value");
  });
});

describe("ReasonSchema", () => {
  it("parses valid reasons", () => {
    expect(ReasonSchema.parse(validReason)).toEqual(validReason);
  });

  it("rejects empty reason messages", () => {
    const result = ReasonSchema.safeParse({ ...validReason, message: "" });

    expect(result.success).toBe(false);
    expectIssue(result, "too_small", ["message"]);
  });
});

describe("VerdictSchema", () => {
  it("parses valid verdicts", () => {
    const verdict = {
      decision: "block",
      reasons: [validReason],
    };

    expect(VerdictSchema.parse(verdict)).toEqual(verdict);
  });

  it("rejects invalid decision values", () => {
    const result = VerdictSchema.safeParse({
      decision: "skip",
      reasons: [],
    });

    expect(result.success).toBe(false);
    expectIssue(result, "invalid_value", ["decision"]);
  });
});

describe("ClaimSchema", () => {
  it("parses valid claims", () => {
    const claim = {
      id: "claim-1",
      text: "Revenue increased.",
      spanStart: 0,
      spanEnd: 18,
    };

    expect(ClaimSchema.parse(claim)).toEqual(claim);
  });

  it("rejects impossible spans", () => {
    const result = ClaimSchema.safeParse({
      id: "claim-1",
      text: "Revenue increased.",
      spanStart: 18,
      spanEnd: 4,
    });

    expect(result.success).toBe(false);
    expectIssue(result, "custom", ["spanEnd"]);
  });
});

describe("GroundingSchema", () => {
  it("parses valid grounding records", () => {
    const grounding = {
      claimId: "claim-1",
      status: "grounded",
      supportingChunkIds: ["chunk-1"],
      method: "exact",
      score: 0.98,
    };

    expect(GroundingSchema.parse(grounding)).toEqual(grounding);
  });

  it("rejects scores outside the normalized range", () => {
    const result = GroundingSchema.safeParse({
      claimId: "claim-1",
      status: "grounded",
      supportingChunkIds: ["chunk-1"],
      method: "exact",
      score: 1.2,
    });

    expect(result.success).toBe(false);
    expectIssue(result, "too_big", ["score"]);
  });
});

function expectIssue(
  result: { success: true } | { success: false; error: { issues: { code: string; path: unknown[] }[] } },
  code: string,
  path?: unknown[],
): void {
  if (result.success) {
    throw new Error("Expected schema parsing to fail.");
  }

  expect(result.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code,
        ...(path ? { path } : {}),
      }),
    ]),
  );
}
