import { describe, expect, it } from "vitest";

import { formatBenchTable, runBench } from "../src/index.js";

describe("provguard bench", () => {
  it("matches every harness scenario expectation", async () => {
    const result = await runBench();

    expect(result.scenarios).toHaveLength(10);
    for (const scenario of result.scenarios) {
      expect(scenario.passed, scenario.id).toBe(true);
      expect(scenario.actual).toBe(scenario.expected === "should_block" ? "block" : "allow");
    }
  });

  it("reports derived and constructed catch rates separately", async () => {
    const result = await runBench();
    const table = formatBenchTable(result);

    expect(result.summary.rates.derived).toMatch(/^\d+\/\d+ \(\d+\.\d%\)$/);
    expect(result.summary.rates.constructed).toMatch(/^\d+\/\d+ \(\d+\.\d%\)$/);
    expect(table).toContain("derived catch rate:");
    expect(table).toContain("constructed catch rate:");
    expect(table).not.toContain("overall catch rate");
  });

  it("keeps monitor mode from blocking delivery while preserving would-block results", async () => {
    const result = await runBench({ monitor: true });

    expect(result.monitor).toBe(true);
    expect(result.scenarios.filter((scenario) => scenario.wouldBlock)).toHaveLength(8);
    expect(result.scenarios.every((scenario) => scenario.actual === "allow")).toBe(true);
  });
});
