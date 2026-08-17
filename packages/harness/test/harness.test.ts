import { describe, expect, it } from "vitest";
import type { Chunk, Claim, GuardPair, Verdict } from "@provguard/schema";
import { SCENARIOS, getScenario, listScenarios, runScenario } from "../src/index.js";

const allowVerdict = {
  decision: "allow",
  reasons: [],
} as const satisfies Verdict;

const deterministicGuards = {
  inbound: {
    classifyChunk(raw: string): Chunk {
      return {
        id: "test-classified-chunk",
        text: raw,
        provenance: {
          sourceId: "test-source",
          channel: "TOOL_RESULT",
          tier: "T2",
          retrievedAt: "2026-08-17T00:00:00.000Z",
          contentHash: "sha256:test",
          upstreamStatus: 200,
        },
      };
    },
    checkSlot(): Verdict {
      return allowVerdict;
    },
    assembleContext(chunks: Chunk[]) {
      return {
        assembled: { default: chunks },
        verdicts: [allowVerdict],
      };
    },
  },
  outbound: {
    extractClaims(text: string): Claim[] {
      return [
        {
          id: "claim-0",
          text,
          spanStart: 0,
          spanEnd: text.length,
        },
      ];
    },
    checkGrounding(_claims: Claim[], chunks: Chunk[]) {
      const scenarioId = chunks[0]?.id.split(":chunk:")[0] ?? "unknown";
      const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId);
      const decision = scenario?.expectation === "should_block" ? "block" : "allow";

      return {
        groundings: [],
        verdict: {
          decision,
          reasons:
            decision === "block"
              ? [
                  {
                    code: "CLAIM_UNGROUNDED",
                    message: "The claim is not supported by context.",
                    claimId: "claim-0",
                  },
                ]
              : [],
        } satisfies Verdict,
      };
    },
  },
} as const satisfies GuardPair;

describe("SCENARIOS", () => {
  it("exports the required eight pollution scenarios and two controls", () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "stdout-capture",
      "http-error-body",
      "alert-in-history",
      "truncated-json",
      "mechanical-fallback",
      "unlabeled-enrichment",
      "stale-cache",
      "empty-not-denied",
      "clean-labeled-retrieval",
      "clean-authorized-empty",
    ]);
    expect(SCENARIOS.filter((scenario) => scenario.expectation === "should_block")).toHaveLength(8);
    expect(SCENARIOS.filter((scenario) => scenario.expectation === "should_allow")).toHaveLength(2);
  });

  it("records provenance and source notes for every scenario", () => {
    for (const scenario of SCENARIOS) {
      expect(["derived", "constructed"]).toContain(scenario.provenance);
      expect(scenario.sourceNote).toContain(scenario.provenance);
    }
  });

  it("returns cloned scenario data from list and lookup helpers", () => {
    const listed = listScenarios();
    const fetched = getScenario("stdout-capture");

    expect(listed).toEqual(SCENARIOS);
    expect(fetched).toEqual(SCENARIOS[0]);
    expect(listed).not.toBe(SCENARIOS);
    expect(fetched).not.toBe(SCENARIOS[0]);
    expect(fetched?.chunks).not.toBe(SCENARIOS[0]?.chunks);
  });
});

describe("runScenario", () => {
  it("produces byte-identical chunks and simulated output across repeated runs", async () => {
    for (const scenario of SCENARIOS) {
      const first = await runScenario(scenario, deterministicGuards);
      const second = await runScenario(scenario, deterministicGuards);

      expect(JSON.stringify(first.scenario.chunks)).toBe(JSON.stringify(second.scenario.chunks));
      expect(first.scenario.simulatedOutput).toBe(second.scenario.simulatedOutput);
    }
  });

  it("evaluates scenario expectations against guard verdicts", async () => {
    for (const scenario of SCENARIOS) {
      const result = await runScenario(scenario, deterministicGuards);

      expect(result.passed).toBe(true);
      expect(result.verdict.decision).toBe(
        scenario.expectation === "should_block" ? "block" : "allow",
      );
    }
  });
});
