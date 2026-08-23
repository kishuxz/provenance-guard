import { describe, expect, it } from "vitest";

import { measure, perfFixture, validateGraph } from "../src/index.js";

const ENVIRONMENT = { node: "test", platform: "test", arch: "test", cpus: 1 };

describe("perf fixtures", () => {
  it("builds a graph that satisfies every invariant", () => {
    // A fixture that does not validate would make every measurement a
    // measurement of something the system would never accept.
    expect(validateGraph(perfFixture(10, 3).graph).violations).toEqual([]);
  });

  it("scales with its parameters", () => {
    const small = perfFixture(10, 3);
    const large = perfFixture(100, 3);

    expect(large.nodes).toBeGreaterThan(small.nodes);
    expect(large.edges).toBeGreaterThan(small.edges);
  });

  it("makes depth mean derivation depth", () => {
    const shallow = perfFixture(10, 2);
    const deep = perfFixture(10, 6);

    expect(deep.nodes).toBeGreaterThan(shallow.nodes);
  });

  it("is deterministic", () => {
    expect(perfFixture(10, 3).graph).toEqual(perfFixture(10, 3).graph);
  });
});

describe("measure", () => {
  const report = measure([perfFixture(10, 2)], 3, ENVIRONMENT);

  it("reports every operation with its fixture and iteration count", () => {
    expect(report.measurements.length).toBeGreaterThan(0);
    for (const measurement of report.measurements) {
      expect(measurement.fixture).toBe("chunks=10 depth=2");
      expect(measurement.iterations).toBe(3);
    }
  });

  it("reports both median and p95, never a bare mean", () => {
    // A mean hides the tail, and the tail is what a request-path component is
    // judged on. The spec requires both.
    for (const measurement of report.measurements) {
      expect(typeof measurement.medianMs).toBe("number");
      expect(typeof measurement.p95Ms).toBe("number");
      expect(measurement.p95Ms).toBeGreaterThanOrEqual(measurement.medianMs);
    }
  });

  it("carries the environment, so a number is never quoted without one", () => {
    expect(report.environment).toEqual(ENVIRONMENT);
  });

  it("declares the size of every fixture it measured", () => {
    expect(report.fixtures).toEqual([
      expect.objectContaining({ name: "chunks=10 depth=2", depth: 2 }),
    ]);
    expect(report.fixtures[0]?.nodes).toBeGreaterThan(0);
    expect(report.fixtures[0]?.edges).toBeGreaterThan(0);
  });

  it("covers the operations the performance doc reports", () => {
    const operations = new Set(report.measurements.map((measurement) => measurement.operation));

    for (const expected of [
      "validate",
      "serialize",
      "deserialize",
      "store.load",
      "trace",
      "impact",
    ]) {
      expect(operations.has(expected), expected).toBe(true);
    }
  });
});
