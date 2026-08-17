import assert from "node:assert/strict";
import test from "node:test";

import { SCENARIOS, runScenario } from "../src/index.js";

const allowAllGuards = {
  checkChunks() {
    return { blocked: false, ruleId: "test.allow_chunks" };
  },
  checkOutput() {
    return { blocked: false, ruleId: "test.allow_output" };
  }
};

test("exports the required pollution-chain scenarios and clean controls", () => {
  assert.equal(SCENARIOS.length, 10);
  assert.deepEqual(
    SCENARIOS.map((scenario) => scenario.id),
    [
      "stdout-capture",
      "http-error-body",
      "alert-in-history",
      "truncated-json",
      "mechanical-fallback",
      "unlabeled-enrichment",
      "stale-cache",
      "empty-not-denied",
      "clean-labeled-retrieval",
      "clean-authorized-empty"
    ]
  );
  assert.equal(
    SCENARIOS.filter((scenario) => scenario.expectation === "should_block").length,
    8
  );
  assert.equal(
    SCENARIOS.filter((scenario) => scenario.expectation === "should_allow").length,
    2
  );
});

test("every scenario returns byte-identical chunks and output across runs", async () => {
  for (const scenario of SCENARIOS) {
    const first = await runScenario(scenario, allowAllGuards);
    const second = await runScenario(scenario, allowAllGuards);

    assert.equal(
      JSON.stringify(first.chunks),
      JSON.stringify(second.chunks),
      `${scenario.id} chunks changed between runs`
    );
    assert.equal(
      first.simulatedOutput,
      second.simulatedOutput,
      `${scenario.id} output changed between runs`
    );
  }
});

test("runScenario clones data before returning it", async () => {
  const scenario = SCENARIOS[0];
  const first = await runScenario(scenario, allowAllGuards);

  first.chunks[0].text = "mutated by caller";

  const second = await runScenario(scenario, allowAllGuards);
  assert.notEqual(second.chunks[0].text, "mutated by caller");
});
