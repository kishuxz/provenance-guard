import { describe, expect, it } from "vitest";
import { ScenarioDifficulties } from "@provguard/schema";
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

const basic = SCENARIOS.filter((scenario) => scenario.difficulty === "basic");
const hard = SCENARIOS.filter((scenario) => scenario.difficulty === "hard");

describe("SCENARIOS", () => {
  it("exports the original eight pollution scenarios and two controls as basic", () => {
    expect(basic.map((scenario) => scenario.id)).toEqual([
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
    expect(basic.filter((scenario) => scenario.expectation === "should_block")).toHaveLength(8);
    expect(basic.filter((scenario) => scenario.expectation === "should_allow")).toHaveLength(2);
  });

  it("carries at least eight hard near misses and four hard clean controls", () => {
    expect(
      hard.filter((scenario) => scenario.expectation === "should_block").length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      hard.filter((scenario) => scenario.expectation === "should_allow").length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("gives every scenario a unique id", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("records provenance and source notes for every scenario", () => {
    for (const scenario of SCENARIOS) {
      expect(["derived", "constructed"]).toContain(scenario.provenance);
      expect(scenario.sourceNote, scenario.id).toContain(scenario.provenance);
      expect(ScenarioDifficulties as readonly string[]).toContain(scenario.difficulty);
      expect(["inbound", "outbound", "either"]).toContain(scenario.expectedGate);
    }
  });

  it("only claims a derived provenance where a source note cites an incident", () => {
    // A constructed scenario probes a mechanism; a derived one reproduces a
    // documented incident. Nothing may claim the second without a citation.
    for (const scenario of SCENARIOS.filter((item) => item.provenance === "derived")) {
      expect(scenario.sourceNote, scenario.id).toMatch(/arXiv:\d{4}\.\d{4,5}/);
    }
    for (const scenario of hard) {
      expect(scenario.provenance, scenario.id).toBe("constructed");
    }
  });

  it("expects every basic block scenario to be caught by the inbound gate", () => {
    for (const scenario of basic.filter((item) => item.expectation === "should_block")) {
      expect(scenario.expectedGate).toBe("inbound");
    }
  });

  it("names a specific gate for every hard block scenario", () => {
    for (const scenario of hard.filter((item) => item.expectation === "should_block")) {
      expect(["inbound", "outbound"], scenario.id).toContain(scenario.expectedGate);
    }
  });

  it("gives hard outbound near misses context that inbound should admit", () => {
    // These scenarios isolate the outbound gate, which only means anything if
    // the chunks are ones inbound has no legitimate reason to reject: a data
    // channel, a healthy tier, a non-empty payload, and any status 2xx.
    const outboundCases = hard.filter((scenario) => scenario.expectedGate === "outbound");
    expect(outboundCases.length).toBeGreaterThanOrEqual(5);

    for (const scenario of outboundCases) {
      for (const item of scenario.chunks) {
        expect(["RETRIEVED_DOC", "TOOL_RESULT"], scenario.id).toContain(item.provenance.channel);
        expect(["T2", "T3"], scenario.id).toContain(item.provenance.tier);
        expect(item.text.trim().length, scenario.id).toBeGreaterThan(0);
        if (item.provenance.upstreamStatus !== undefined) {
          expect(item.provenance.upstreamStatus, scenario.id).toBeGreaterThanOrEqual(200);
          expect(item.provenance.upstreamStatus, scenario.id).toBeLessThan(300);
        }
      }
    }
  });

  it("keeps chunk ids namespaced to their scenario", () => {
    for (const scenario of SCENARIOS) {
      for (const [index, item] of scenario.chunks.entries()) {
        expect(item.id, scenario.id).toBe(`${scenario.id}:chunk:${String(index)}`);
      }
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

      expect(JSON.stringify(first.scenario.chunks), scenario.id).toBe(
        JSON.stringify(second.scenario.chunks),
      );
      expect(first.scenario.simulatedOutput, scenario.id).toBe(second.scenario.simulatedOutput);
    }
  });

  it("is deterministic for every hard scenario in particular", async () => {
    expect(hard.length).toBeGreaterThanOrEqual(12);

    for (const scenario of hard) {
      const runs = await Promise.all([
        runScenario(scenario, deterministicGuards),
        runScenario(scenario, deterministicGuards),
        runScenario(scenario, deterministicGuards),
      ]);

      const serialized = runs.map((run) => JSON.stringify(run.scenario));
      expect(new Set(serialized).size, scenario.id).toBe(1);
    }
  });

  it("pins the fixed retrievedAt on every chunk, including re-timestamped ones", async () => {
    // A scenario may carry its own retrievedAt to dramatize staleness, but it
    // must still be a fixed literal, or the corpus stops being reproducible.
    for (const scenario of SCENARIOS) {
      const first = await runScenario(scenario, deterministicGuards);
      const second = await runScenario(scenario, deterministicGuards);

      for (const [index, item] of first.scenario.chunks.entries()) {
        expect(item.provenance.retrievedAt, scenario.id).toBe(
          second.scenario.chunks[index]?.provenance.retrievedAt,
        );
        expect(item.provenance.retrievedAt, scenario.id).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
      }
    }
  });

  it("does not mutate the frozen scenario corpus", async () => {
    const before = JSON.stringify(SCENARIOS);
    for (const scenario of SCENARIOS) await runScenario(scenario, deterministicGuards);
    expect(JSON.stringify(SCENARIOS)).toBe(before);
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
