import { describe, expect, it } from "vitest";
import type { Claim } from "@provguard/schema";
import { assessClaim, extractClaims, groundClaim } from "../src/index.js";
import { chunk } from "./helpers.js";

function claimOf(text: string): Claim {
  const claims = extractClaims(text);
  expect(claims, `expected exactly one claim from: ${text}`).toHaveLength(1);
  return claims[0]!;
}

describe("groundClaim: the deterministic ladder", () => {
  it('grounds a verbatim claim with method "exact"', () => {
    const chunks = [
      chunk({ id: "c1", text: "The checkout service returned 503 for 4% of requests." }),
    ];
    const grounding = groundClaim(
      claimOf("The checkout service returned 503 for 4% of requests."),
      chunks,
    );

    expect(grounding).toMatchObject({
      claimId: "claim-0",
      status: "grounded",
      method: "exact",
      supportingChunkIds: ["c1"],
    });
    expect(grounding.score).toBe(1);
  });

  it("falls back to a normalized match when only case, spacing and punctuation differ", () => {
    const chunks = [
      chunk({ id: "c1", text: "the  CHECKOUT service returned 503 -- for 4% of requests" }),
    ];
    const assessment = assessClaim(
      claimOf("The checkout service returned 503 for 4% of requests."),
      chunks,
    );

    expect(assessment.grounding.status).toBe("grounded");
    expect(assessment.grounding.method).toBe("fuzzy");
    expect(assessment.decidedBy).toBe("normalized");
  });

  it("falls back to entity overlap when the claim is reworded but every specific is present", () => {
    const chunks = [
      chunk({
        id: "c1",
        text: "Incident report: Checkout began emitting 503 responses at 14:02 UTC.",
      }),
      chunk({ id: "c2", text: "Checkout error budget for the quarter is 4%." }),
    ];
    const assessment = assessClaim(
      claimOf("Checkout emitted 503 errors, consuming 4% of the budget."),
      chunks,
    );

    expect(assessment.grounding.status).toBe("grounded");
    expect(assessment.grounding.method).toBe("fuzzy");
    expect(assessment.decidedBy).toBe("entity");
    expect(assessment.grounding.supportingChunkIds.sort()).toEqual(["c1", "c2"]);
  });

  it("decides on numeric overlap when the only specifics are numbers", () => {
    const chunks = [chunk({ id: "c1", text: "the run took 42 seconds and moved 1,024 rows" })];
    const assessment = assessClaim(claimOf("the run moved 1024 rows in 42 seconds"), chunks);

    expect(assessment.grounding.status).toBe("grounded");
    expect(assessment.decidedBy).toBe("numeric");
  });

  it("records the deciding stage on every assessment, including the failures", () => {
    const chunks = [chunk({ id: "c1", text: "The deploy finished cleanly." })];
    for (const text of [
      "The deploy finished cleanly.",
      "Kubernetes evicted the Redis pod in cluster prod-7.",
    ]) {
      expect(assessClaim(claimOf(text), chunks).decidedBy).toBeTruthy();
    }
  });
});

describe("groundClaim: rejection", () => {
  it("rejects a claim whose specifics are absent from context", () => {
    const chunks = [
      chunk({ id: "c1", text: "The checkout service returned 503 for 4% of requests." }),
    ];
    const assessment = assessClaim(
      claimOf("Kubernetes evicted the Redis pod in cluster prod-7."),
      chunks,
    );

    expect(assessment.grounding.status).toBe("ungrounded");
    expect(assessment.grounding.score).toBe(0);
    expect(assessment.reason?.code).toBe("CLAIM_UNGROUNDED");
  });

  it("rejects a claim that is half-sourced and half-invented", () => {
    const chunks = [
      chunk({ id: "c1", text: "The checkout service returned 503 for some requests." }),
    ];
    const assessment = assessClaim(
      claimOf("The checkout service returned 503 and paged Rivera at 3am."),
      chunks,
    );

    expect(assessment.grounding.status).toBe("ungrounded");
    expect(assessment.reason?.code).toBe("CLAIM_UNGROUNDED");
    expect(assessment.detail).toMatch(/Rivera/);
  });

  it("rejects an unsupported number even when the surrounding prose is sourced", () => {
    const chunks = [
      chunk({ id: "c1", text: "The checkout service returned 503 for some requests." }),
    ];
    const assessment = assessClaim(
      claimOf("The checkout service returned 503 for 87% of requests."),
      chunks,
    );

    expect(assessment.grounding.status).toBe("ungrounded");
    expect(assessment.detail).toMatch(/87/);
  });

  it("rejects everything when context is empty", () => {
    const assessment = assessClaim(claimOf("The checkout service returned 503."), []);
    expect(assessment.grounding.status).toBe("ungrounded");
  });

  it("defers a claim with no specifics that still shares context vocabulary", () => {
    const chunks = [
      chunk({
        id: "c1",
        text: "The checkout service handles payment authorization and refund requests.",
      }),
    ];
    const assessment = assessClaim(
      claimOf("the checkout service handles refund requests carefully"),
      chunks,
    );

    expect(assessment.grounding.status).toBe("unverifiable");
    expect(assessment.decidedBy).toBe("none");
    expect(assessment.reason?.code).toBe("CLAIM_UNVERIFIABLE");
  });
});

describe("groundClaim: the T4/T5 tier gate", () => {
  const errorChunk = chunk({
    id: "err-1",
    tier: "T4",
    channel: "DIAGNOSTIC_LOG",
    text: "HTTP 502 Bad Gateway: upstream connect error or disconnect",
  });

  it("refuses to ground an exact match when every supporting chunk is untrusted", () => {
    const assessment = assessClaim(claimOf("upstream connect error or disconnect was logged."), [
      chunk({
        id: "u1",
        tier: "T5",
        channel: "UNLABELED",
        text: "log: upstream connect error or disconnect was logged. retrying now.",
      }),
    ]);

    expect(assessment.grounding.status).toBe("ungrounded");
    expect(assessment.grounding.method).toBe("exact");
    expect(assessment.decidedBy).toBe("exact");
    expect(assessment.reason?.code).toBe("CLAIM_SUPPORT_LOW_TIER");
    expect(assessment.grounding.supportingChunkIds).toEqual(["u1"]);
  });

  it("uses a reason code distinct from an ordinary miss", () => {
    const claim = claimOf("The gateway reported a 502 error.");
    const untrusted = assessClaim(claim, [errorChunk]);
    const missing = assessClaim(claim, [
      chunk({ id: "c1", text: "Unrelated notes about the billing exporter." }),
    ]);

    expect(untrusted.grounding.status).toBe("ungrounded");
    expect(missing.grounding.status).toBe("ungrounded");
    expect(untrusted.reason?.code).toBe("CLAIM_SUPPORT_LOW_TIER");
    expect(missing.reason?.code).toBe("CLAIM_UNGROUNDED");
    expect(untrusted.reason?.code).not.toBe(missing.reason?.code);
  });

  it("grounds the claim when a trusted chunk supports it alongside an untrusted one", () => {
    const text = "HTTP 502 Bad Gateway: upstream connect error or disconnect happened.";
    const assessment = assessClaim(claimOf(text), [
      errorChunk,
      chunk({ id: "c2", tier: "T1", text }),
    ]);

    expect(assessment.grounding.status).toBe("grounded");
    expect(assessment.grounding.method).toBe("exact");
    expect(assessment.grounding.supportingChunkIds).toContain("c2");
  });

  it("prefers a trusted weaker match over an untrusted verbatim one", () => {
    // The untrusted chunk matches verbatim; the trusted chunk only covers the
    // specifics. Trusted support wins and the claim grounds.
    const assessment = assessClaim(claimOf("Postgres replica lag reached 12 seconds."), [
      chunk({
        id: "t5",
        tier: "T5",
        channel: "UNLABELED",
        text: "Postgres replica lag reached 12 seconds.",
      }),
      chunk({
        id: "t1",
        tier: "T1",
        text: "Monitoring for Postgres shows replica lag peaking near 12 seconds today.",
      }),
    ]);

    expect(assessment.grounding.status).toBe("grounded");
    expect(assessment.decidedBy).toBe("entity");
    expect(assessment.grounding.supportingChunkIds).toContain("t1");
  });
});
