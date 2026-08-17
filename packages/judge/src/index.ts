import { createHash } from "node:crypto";

import type { Chunk, Claim } from "@provguard/schema";
import type { JudgeHook } from "@provguard/outbound";
import { DEFAULT_FIXTURES, type JudgeFixture } from "./fixtures.js";

export type JudgeMode = "fixture" | "live";

export interface FixtureJudgeOptions {
  fixtures?: readonly JudgeFixture[];
  mode?: JudgeMode;
  liveJudge?: JudgeHook;
}

export { DEFAULT_FIXTURES, type JudgeFixture } from "./fixtures.js";

export function fixtureKey(claim: Claim, chunks: readonly Chunk[]): string {
  const payload = {
    claim: {
      text: claim.text,
      spanStart: claim.spanStart,
      spanEnd: claim.spanEnd,
    },
    chunks: chunks
      .map((chunk) => ({
        id: chunk.id,
        text: chunk.text,
        provenance: {
          sourceId: chunk.provenance.sourceId,
          channel: chunk.provenance.channel,
          tier: chunk.provenance.tier,
          retrievedAt: chunk.provenance.retrievedAt,
          contentHash: chunk.provenance.contentHash,
          ...(chunk.provenance.upstreamStatus === undefined
            ? {}
            : { upstreamStatus: chunk.provenance.upstreamStatus }),
          ...(chunk.provenance.parentSourceId === undefined
            ? {}
            : { parentSourceId: chunk.provenance.parentSourceId }),
        },
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };

  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function createFixtureJudge(options: FixtureJudgeOptions = {}): JudgeHook {
  const mode = options.mode ?? "fixture";
  if (mode === "live") {
    if (options.liveJudge === undefined) {
      throw new Error("live judge mode requires an explicit liveJudge hook");
    }
    return options.liveJudge;
  }

  const fixtures = new Map(
    (options.fixtures ?? DEFAULT_FIXTURES).map((fixture) => [fixture.key, fixture]),
  );
  return async (claim, chunks) => {
    const fixture = fixtures.get(fixtureKey(claim, chunks));
    if (fixture === undefined) {
      return {
        claimId: claim.id,
        status: "unverifiable",
        supportingChunkIds: [],
        method: "judge",
        score: 0,
      };
    }

    return {
      claimId: claim.id,
      status: fixture.grounding.status,
      supportingChunkIds: [...fixture.grounding.supportingChunkIds],
      method: "judge",
      score: fixture.grounding.score,
    };
  };
}
