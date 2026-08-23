import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { formatBenchTable, main, runBench } from "../src/index.js";

describe("provguard bench", () => {
  it("matches basic harness scenario expectations", async () => {
    const result = await runBench();

    expect(result.scenarios).toHaveLength(28);
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
    expect(result.summary.gateBreakdown.actual.outbound).toBe(2);
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

  it("records the first measured false positive rather than hiding it", async () => {
    // mixed-clean-quoted-error is a genuine incident postmortem that quotes an
    // HTTP error. It is blocked. docs/LIMITATIONS.md predicted exactly this
    // over-blocking failure before any scenario exercised it, and the number
    // is pinned here so a future change cannot quietly lose or worsen it.
    const result = await runBench();
    const control = result.scenarios.find((scenario) => scenario.id === "mixed-clean-quoted-error");

    expect(control?.expected).toBe("should_allow");
    expect(control?.actual).toBe("block");
    expect(control?.reasonCode).toBe("CLAIM_UNGROUNDED");
    expect(result.summary.falsePositiveRate.mixed.label).toBe("1/2 (50.0%)");
  });

  it("leaves the basic and hard rates untouched by the mixed tier", async () => {
    // Adding a tier must not move an existing measurement. Folding mixed into
    // hard would have done exactly that.
    const result = await runBench();

    expect(result.summary.recall.basic.derived.label).toBe("6/6 (100.0%)");
    expect(result.summary.recall.basic.constructed.label).toBe("2/2 (100.0%)");
    expect(result.summary.recall.hard.constructed.label).toBe("3/8 (37.5%)");
    expect(result.summary.recall.mixed.constructed.label).toBe("2/4 (50.0%)");
  });

  it("executes the disabled control once per scenario", async () => {
    // The assertion that stops a zero-result loop that never ran from looking
    // identical to a loop that ran and found nothing.
    const result = await runBench();

    expect(result.summary.controlInvocations).toBe(result.scenarios.length);
    expect(result.summary.controlInvocations).toBe(28);
  });

  it("derives guard effect from execution, not from the declared expectation", async () => {
    // Every scenario below is declared should_block. The guards catch some and
    // miss others, and guard_effect follows what actually happened. If it were
    // read off the declaration, all of these would say "changed".
    const result = await runBench();
    const caught = result.scenarios.find((s) => s.id === "stdout-capture");
    const missed = result.scenarios.find((s) => s.id === "mixed-cross-sentence-both-grounded");

    expect(caught?.expected).toBe("should_block");
    expect(missed?.expected).toBe("should_block");
    expect(caught?.guardEffect).toBe("changed");
    expect(missed?.guardEffect).toBe("none");
  });

  it("reports a guard effect that actually varies across the corpus", async () => {
    // A constant column is a decorative column. This is the check that would
    // have failed on the hardcoded baseline this replaced.
    const effects = new Set((await runBench()).scenarios.map((s) => s.guardEffect));

    expect([...effects].sort()).toEqual(["changed", "none"]);
  });

  it("measures the differential rather than counting what the control caught", async () => {
    const result = await runBench();

    // 13 of 20 block scenarios had their outcome changed by the guards.
    expect(result.summary.guardChangedOutcome.label).toBe("13/20 (65.0%)");
    // And the summary carries no hardcoded baseline field any more.
    expect(result.summary).not.toHaveProperty("disabledBaselineCatches");
  });

  it("runs the control with the guards genuinely bypassed", async () => {
    // Under the control every chunk reaches context, including ones the real
    // inbound guard refuses. If the control were secretly running the real
    // guard, a refused-chunk scenario would admit zero.
    const result = await runBench();
    const polluted = result.scenarios.find((s) => s.id === "stdout-capture");

    expect(polluted?.control).toBe("delivered");
    expect(polluted?.controlAdmittedChunks).toBeGreaterThan(0);
  });

  it("labels the by-construction statement as not measured", async () => {
    const table = formatBenchTable(await runBench());

    expect(table).toContain("not measured, true by construction");
    expect(table).not.toContain("disabled baseline catches");
  });

  it("keeps monitor mode from blocking delivery while preserving would-block results", async () => {
    const result = await runBench({ monitor: true });

    expect(result.monitor).toBe(true);
    expect(result.scenarios.filter((scenario) => scenario.wouldBlock)).toHaveLength(14);
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
      expect(result.summary.recall).toHaveProperty("mixed");
      expect(result.summary.falsePositiveRate).toHaveProperty("basic");
      expect(result.summary.gateBreakdown.outboundValidated).toBe(1);
      expect(result.summary.saturationWarnings.length).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      process.chdir(previousCwd);
    }
  });
});
