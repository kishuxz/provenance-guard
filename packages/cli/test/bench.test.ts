import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { formatBenchTable, main, runBench } from "../src/index.js";

describe("provguard bench", () => {
  it("matches basic harness scenario expectations", async () => {
    const result = await runBench();

    expect(result.scenarios).toHaveLength(22);
    for (const scenario of result.scenarios.filter((item) => item.difficulty === "basic")) {
      expect(scenario.passed, scenario.id).toBe(true);
      expect(scenario.actual).toBe(scenario.expected === "should_block" ? "block" : "allow");
      if (scenario.expected === "should_allow") {
        expect(scenario.reasonCode).toBeNull();
      }
    }
  });

  it("snapshots hard scenario outcomes without requiring them to pass", async () => {
    const result = await runBench();
    const hardOutcomes = result.scenarios
      .filter((scenario) => scenario.difficulty === "hard")
      .map((scenario) => ({
        id: scenario.id,
        expected: scenario.expected,
        actual: scenario.actual,
        expectedGate: scenario.expectedGate,
        actualGate: scenario.actualGate,
        passed: scenario.passed,
      }));

    expect(hardOutcomes).toMatchInlineSnapshot(`
      [
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_block",
          "expectedGate": "outbound",
          "id": "hard-paraphrased-fabrication",
          "passed": false,
        },
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_block",
          "expectedGate": "outbound",
          "id": "hard-recombined-entities",
          "passed": false,
        },
        {
          "actual": "block",
          "actualGate": "outbound",
          "expected": "should_block",
          "expectedGate": "outbound",
          "id": "hard-split-conjunction",
          "passed": true,
        },
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_block",
          "expectedGate": "outbound",
          "id": "hard-unit-shift",
          "passed": false,
        },
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_block",
          "expectedGate": "outbound",
          "id": "hard-appended-qualifier",
          "passed": false,
        },
        {
          "actual": "block",
          "actualGate": "inbound",
          "expected": "should_block",
          "expectedGate": "inbound",
          "id": "hard-ok-status-error-body",
          "passed": true,
        },
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_block",
          "expectedGate": "inbound",
          "id": "hard-fresh-timestamp-stale-body",
          "passed": false,
        },
        {
          "actual": "block",
          "actualGate": "inbound",
          "expected": "should_block",
          "expectedGate": "inbound",
          "id": "hard-json-shaped-diagnostic",
          "passed": true,
        },
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_allow",
          "expectedGate": "either",
          "id": "hard-clean-error-vocabulary",
          "passed": true,
        },
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_allow",
          "expectedGate": "either",
          "id": "hard-clean-t3-support",
          "passed": true,
        },
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_allow",
          "expectedGate": "either",
          "id": "hard-clean-entity-overlap",
          "passed": true,
        },
        {
          "actual": "allow",
          "actualGate": "none",
          "expected": "should_allow",
          "expectedGate": "either",
          "id": "hard-clean-authorized-empty",
          "passed": true,
        },
      ]
    `);
  });

  it("reports recall and false-positive rates by difficulty", async () => {
    const result = await runBench();
    const table = formatBenchTable(result);

    expect(result.summary.recall.basic.derived.label).toMatch(/^\d+\/\d+ \(\d+\.\d%\)$/);
    expect(result.summary.recall.basic.constructed.label).toMatch(/^\d+\/\d+ \(\d+\.\d%\)$/);
    expect(result.summary.recall.hard.derived.label).toBe("n/a (0 scenarios)");
    expect(result.summary.falsePositiveRate.basic.label).toMatch(/^\d+\/\d+ \(\d+\.\d%\)$/);
    expect(table).toContain("recall on block scenarios:");
    expect(table).toContain("  basic derived:");
    expect(table).toContain("  hard constructed:");
    expect(table).toContain("false-positive rate on controls:");
    expect(table).not.toContain("overall catch rate");
  });

  it("reports expected and actual gate attribution", async () => {
    const result = await runBench();
    const table = formatBenchTable(result);

    expect(result.scenarios[0]).toEqual(
      expect.objectContaining({
        expectedGate: "inbound",
        actualGate: "inbound",
      }),
    );
    expect(result.summary.gateBreakdown.outboundValidated).toBe(1);
    expect(result.summary.gateBreakdown.expected.inbound).toBe(11);
    expect(result.summary.gateBreakdown.actual.outbound).toBe(1);
    expect(table).toContain("expected_gate");
    expect(table).toContain("actual_gate");
    expect(table).toContain("outbound gate validations: 1");
  });

  it("prints saturation warnings for undersized perfect categories", async () => {
    const result = await runBench();
    const table = formatBenchTable(result);

    expect(result.summary.saturationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("basic constructed recall is 100% with only 2 scenarios"),
      ]),
    );
    expect(table).toContain("this result detects regressions but does not measure adequacy");
  });

  it("keeps monitor mode from blocking delivery while preserving would-block results", async () => {
    const result = await runBench({ monitor: true });

    expect(result.monitor).toBe(true);
    expect(result.scenarios.filter((scenario) => scenario.wouldBlock)).toHaveLength(10);
    expect(result.scenarios.every((scenario) => scenario.actual === "allow")).toBe(true);
  });

  it("writes difficulty and gate breakdowns to bench-results.json", async () => {
    const previousCwd = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), "provguard-bench-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.chdir(directory);

      await expect(main(["bench", "--json"])).resolves.toBe(0);
      const result = JSON.parse(await readFile("bench-results.json", "utf8")) as {
        scenarios: Array<{ difficulty: string; expectedGate: string; actualGate: string }>;
        summary: {
          recall: unknown;
          falsePositiveRate: unknown;
          gateBreakdown: { outboundValidated: number };
          saturationWarnings: string[];
        };
      };

      expect(result.scenarios[0]).toEqual(
        expect.objectContaining({
          difficulty: "basic",
          expectedGate: "inbound",
          actualGate: "inbound",
        }),
      );
      expect(result.summary.recall).toHaveProperty("basic");
      expect(result.summary.recall).toHaveProperty("hard");
      expect(result.summary.falsePositiveRate).toHaveProperty("basic");
      expect(result.summary.gateBreakdown.outboundValidated).toBe(1);
      expect(result.summary.saturationWarnings.length).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      process.chdir(previousCwd);
    }
  });
});
