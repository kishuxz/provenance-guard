import { describe, expect, it } from "vitest";
import type { Chunk, Claim, Grounding } from "@provguard/schema";
import { auditOutput, auditOutputWithJudge, outboundGuard } from "../src/index.js";
import { chunk, HTTP_400_PAGE, SOCKET_ERROR } from "./helpers.js";

/**
 * A confident, fluent, entirely invented paragraph. Nothing in it is hedged
 * and nothing in it is true -- which is exactly what makes it dangerous.
 */
const FABRICATED_PARAGRAPH = [
  "The Kestrel Reservoir supplies 62% of Ashford's drinking water.",
  "Engineers completed the spillway retrofit in 2019 at a cost of 14 million dollars.",
  "The reservoir holds 3.2 billion gallons at full capacity.",
].join(" ");

describe("sabotage: a fabricated paragraph over a context of pure error text", () => {
  const context: Chunk[] = [HTTP_400_PAGE, SOCKET_ERROR];

  it("blocks the output", () => {
    const result = auditOutput(FABRICATED_PARAGRAPH, context);
    expect(result.verdict.decision).toBe("block");
  });

  it("finds no claim groundable", () => {
    const result = auditOutput(FABRICATED_PARAGRAPH, context);

    expect(result.groundings).toHaveLength(3);
    for (const grounding of result.groundings) {
      expect(grounding.status).toBe("ungrounded");
      expect(grounding.score).toBe(0);
      expect(grounding.supportingChunkIds).toEqual([]);
    }
  });

  it("reports a reason for every claim, naming the claim it came from", () => {
    const result = auditOutput(FABRICATED_PARAGRAPH, context);
    const claimIds = result.groundings.map((g) => g.claimId);

    expect(result.verdict.reasons).toHaveLength(3);
    for (const reason of result.verdict.reasons) {
      expect(reason.code).toBe("CLAIM_UNGROUNDED");
      expect(reason.message.length).toBeGreaterThan(0);
      expect(claimIds).toContain(reason.claimId);
    }
  });

  it("is not rescued by the error text merely being long", () => {
    // The 400 page mentions Apache, Ubuntu and a port number. None of that
    // supports a claim about a reservoir, and volume of text must not blur it.
    const result = auditOutput(FABRICATED_PARAGRAPH, context);
    expect(result.verdict.decision).toBe("block");
    expect(result.assessments.every((a) => a.grounding.status === "ungrounded")).toBe(true);
  });
});

describe("sabotage: a paragraph whose only support is a T5 chunk", () => {
  const paragraph = [
    "The billing exporter dropped 218 records during the migration.",
    "The backfill job replayed them from the write-ahead log.",
  ].join(" ");

  const unlabeled = chunk({
    id: "blob-1",
    tier: "T5",
    channel: "UNLABELED",
    sourceId: "unknown",
    text: paragraph,
  });

  it("blocks even though every claim matches verbatim", () => {
    const result = auditOutput(paragraph, [unlabeled]);

    expect(result.verdict.decision).toBe("block");
    for (const grounding of result.groundings) {
      expect(grounding.status).toBe("ungrounded");
      // The match was verbatim -- the method records that, the status refuses it.
      expect(grounding.method).toBe("exact");
      expect(grounding.supportingChunkIds).toEqual(["blob-1"]);
    }
  });

  it("uses CLAIM_SUPPORT_LOW_TIER rather than a generic ungrounded code", () => {
    const result = auditOutput(paragraph, [unlabeled]);

    expect(result.verdict.reasons.map((r) => r.code)).toEqual([
      "CLAIM_SUPPORT_LOW_TIER",
      "CLAIM_SUPPORT_LOW_TIER",
    ]);
  });

  it("allows the same paragraph once the same text carries real provenance", () => {
    const sourced = chunk({ id: "doc-1", tier: "T2", channel: "RETRIEVED_DOC", text: paragraph });
    const result = auditOutput(paragraph, [sourced]);

    expect(result.verdict.decision).toBe("allow");
  });
});

describe("a correctly grounded paragraph", () => {
  const paragraph = [
    "The checkout service returned HTTP 503 for 4% of requests during the incident.",
    "The on-call engineer restarted the payment worker at 14:02 UTC.",
    "Error rates returned to baseline within nine minutes.",
  ].join(" ");

  const context = [
    chunk({
      id: "doc-1",
      tier: "T1",
      channel: "RETRIEVED_DOC",
      text: `Incident 4417 postmortem. ${paragraph}`,
    }),
  ];

  it('passes with method "exact"', () => {
    const result = auditOutput(paragraph, context);

    expect(result.verdict.decision).toBe("allow");
    expect(result.groundings).toHaveLength(3);
    for (const grounding of result.groundings) {
      expect(grounding.status).toBe("grounded");
      expect(grounding.method).toBe("exact");
      expect(grounding.score).toBe(1);
      expect(grounding.supportingChunkIds).toEqual(["doc-1"]);
    }
  });

  it("records no reasons on an allow", () => {
    expect(auditOutput(paragraph, context).verdict.reasons).toEqual([]);
  });

  it("blocks the moment one sentence is swapped for an invented one", () => {
    const poisoned = paragraph.replace(
      "Error rates returned to baseline within nine minutes.",
      "The Frankfurt region absorbed the overflow via the Meridian failover.",
    );

    const result = auditOutput(poisoned, context);
    expect(result.verdict.decision).toBe("block");
    expect(result.groundings.filter((g) => g.status === "ungrounded")).toHaveLength(1);
  });
});

describe("verdict rollup", () => {
  const grounded = chunk({ id: "g1", tier: "T1", text: "The nightly job compacted 12 segments." });

  it("allows when every claim grounds", () => {
    const result = auditOutput("The nightly job compacted 12 segments.", [grounded]);
    expect(result.verdict.decision).toBe("allow");
  });

  it("quarantines when a claim is merely unverifiable", () => {
    const context = [
      chunk({
        id: "c1",
        text: "The checkout service handles payment authorization and refund requests.",
      }),
    ];
    const result = auditOutput("the checkout service handles refund requests carefully", context);

    expect(result.groundings.map((g) => g.status)).toEqual(["unverifiable"]);
    expect(result.verdict.decision).toBe("quarantine");
    expect(result.verdict.reasons.map((r) => r.code)).toEqual(["CLAIM_UNVERIFIABLE"]);
  });

  it("blocks when any claim is ungrounded, even alongside grounded ones", () => {
    const output = "The nightly job compacted 12 segments. Voyager Analytics signed the renewal.";
    const result = auditOutput(output, [grounded]);

    expect(result.groundings.map((g) => g.status)).toEqual(["grounded", "ungrounded"]);
    expect(result.verdict.decision).toBe("block");
  });

  it("allows an output that asserts nothing", () => {
    const result = auditOutput("Does the job compact segments?", [grounded]);
    expect(result.groundings).toEqual([]);
    expect(result.verdict.decision).toBe("allow");
  });

  it("is deterministic across repeated runs", () => {
    const first = auditOutput(FABRICATED_PARAGRAPH, [HTTP_400_PAGE]);
    const second = auditOutput(FABRICATED_PARAGRAPH, [HTTP_400_PAGE]);
    expect(second).toEqual(first);
  });
});

describe("the injected judge", () => {
  const context = [
    chunk({
      id: "c1",
      text: "The checkout service handles payment authorization and refund requests.",
    }),
  ];
  const undecidable = "the checkout service handles refund requests carefully";

  const judgeReturning =
    (status: Grounding["status"]) =>
    async (claim: Claim): Promise<Grounding> =>
      Promise.resolve({
        claimId: claim.id,
        status,
        supportingChunkIds: status === "grounded" ? ["c1"] : [],
        method: "judge",
        score: status === "grounded" ? 0.9 : 0,
      });

  it("is never consulted where a deterministic result exists", async () => {
    const seen: string[] = [];
    const judge = async (claim: Claim): Promise<Grounding> => {
      seen.push(claim.id);
      return judgeReturning("ungrounded")(claim);
    };

    await auditOutputWithJudge(
      "The nightly job compacted 12 segments.",
      [chunk({ id: "g1", tier: "T1", text: "The nightly job compacted 12 segments." })],
      { judge },
    );

    expect(seen).toEqual([]);
  });

  it("can escalate an unverifiable claim to ungrounded", async () => {
    const result = await auditOutputWithJudge(undecidable, context, {
      judge: judgeReturning("ungrounded"),
    });

    expect(result.groundings[0]?.status).toBe("ungrounded");
    expect(result.groundings[0]?.method).toBe("judge");
    expect(result.verdict.decision).toBe("block");
    expect(result.assessments[0]?.advisory?.applied).toBe(true);
  });

  it("cannot ground a claim on its own say-so", async () => {
    const result = await auditOutputWithJudge(undecidable, context, {
      judge: judgeReturning("grounded"),
    });

    expect(result.groundings[0]?.status).toBe("unverifiable");
    expect(result.verdict.decision).toBe("quarantine");
    expect(result.assessments[0]?.advisory).toMatchObject({ status: "grounded", applied: false });
  });

  it("degrades to the deterministic verdict when the judge throws", async () => {
    const result = await auditOutputWithJudge(undecidable, context, {
      judge: () => Promise.reject(new Error("judge upstream timed out")),
    });

    expect(result.groundings[0]?.status).toBe("unverifiable");
    expect(result.verdict.decision).toBe("quarantine");
    expect(result.assessments[0]?.advisory?.error).toMatch(/timed out/);
  });

  it("ignores a judge that returns something unusable", async () => {
    const result = await auditOutputWithJudge(undecidable, context, {
      judge: () => Promise.resolve({ nonsense: true } as unknown as Grounding),
    });

    expect(result.groundings[0]?.status).toBe("unverifiable");
    expect(result.assessments[0]?.advisory?.error).toBeTruthy();
  });
});

describe("shared OutboundGuard conformance", () => {
  it("grounds claims handed to it by an external extractor", () => {
    const context = [chunk({ id: "doc-1", tier: "T1", text: "The retry budget is 4% per hour." })];
    const claims = outboundGuard.extractClaims("The retry budget is 4% per hour.");
    const result = outboundGuard.checkGrounding(claims, context);

    expect(result.groundings.map((g) => g.status)).toEqual(["grounded"]);
    expect(result.verdict.decision).toBe("allow");
  });
});
