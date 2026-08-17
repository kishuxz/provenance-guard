import { describe, expect, it } from "vitest";
import type { Chunk, Claim, Grounding } from "@provguard/schema";
import { auditOutputWithJudge } from "@provguard/outbound";
import { createFixtureJudge, fixtureKey } from "../src/index.js";

const context: Chunk[] = [
  {
    id: "hard-split-conjunction:chunk:0",
    text: "Incident 5512 was closed on 12 May. A separate configuration change was deployed on 12 May.",
    provenance: {
      sourceId: "hard-split-conjunction:source:incident-log",
      channel: "RETRIEVED_DOC",
      tier: "T3",
      retrievedAt: "2026-08-17T00:00:00.000Z",
      contentHash: "sha256:hard-split-conjunction-00000000000000000000",
    },
  },
];

const claim: Claim = {
  id: "claim-1",
  text: "The configuration change deployed that day is what resolved it.",
  spanStart: 36,
  spanEnd: 99,
};

describe("fixtureKey", () => {
  it("is byte-stable for a claim plus context", () => {
    expect(fixtureKey(claim, context)).toBe(
      "sha256:20be4d8a2ac355137c72bfd66b26569a9c7825a39e2f00381fcf96a82a60e392",
    );
    expect(fixtureKey(claim, context)).toBe(fixtureKey(claim, context));
  });
});

describe("createFixtureJudge", () => {
  it("replays committed fixtures without live access", async () => {
    const judge = createFixtureJudge();
    const grounding = await judge(claim, context);

    expect(grounding).toEqual({
      claimId: "claim-1",
      status: "ungrounded",
      supportingChunkIds: [],
      method: "judge",
      score: 0,
    });
  });

  it("returns unverifiable for missing fixtures", async () => {
    const judge = createFixtureJudge({ fixtures: [] });
    const grounding = await judge(claim, context);

    expect(grounding).toEqual({
      claimId: "claim-1",
      status: "unverifiable",
      supportingChunkIds: [],
      method: "judge",
      score: 0,
    });
  });

  it("requires an explicit live hook for live mode", () => {
    expect(() => createFixtureJudge({ mode: "live" })).toThrow(/liveJudge/);
  });

  it("delegates to the explicit live hook in live mode", async () => {
    const liveJudge = async (input: Claim): Promise<Grounding> => ({
      claimId: input.id,
      status: "unverifiable",
      supportingChunkIds: [],
      method: "judge",
      score: 0.25,
    });
    const judge = createFixtureJudge({ mode: "live", liveJudge });

    await expect(judge(claim, context)).resolves.toMatchObject({ score: 0.25 });
  });

  it("can be injected into outbound without grounding on judge say-so", async () => {
    const result = await auditOutputWithJudge(
      "Incident 5512 was closed on 12 May. The configuration change deployed that day is what resolved it.",
      context,
      { judge: createFixtureJudge() },
    );

    expect(result.groundings.map((grounding) => grounding.method)).toEqual(["exact", "judge"]);
    expect(result.groundings.map((grounding) => grounding.status)).toEqual([
      "grounded",
      "ungrounded",
    ]);
    expect(result.verdict.decision).toBe("block");
    expect(result.verdict.reasons.map((reason) => reason.code)).toEqual(["CLAIM_UNGROUNDED"]);
  });
});
