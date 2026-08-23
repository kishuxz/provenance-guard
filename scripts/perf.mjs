#!/usr/bin/env node
// Measures the graph operations and writes perf-results.json.
//
// Offline and dependency-free. Every number is reported with its fixture and
// the environment that produced it, because a performance figure quoted
// without those is not a measurement.
import { writeFile } from "node:fs/promises";
import { cpus, arch, platform } from "node:os";
import process from "node:process";

import { measure, perfFixture } from "@provguard/graph";

const iterations = Number(process.env.PROVGUARD_PERF_ITERATIONS ?? 25);
const fixtures = [perfFixture(10, 3), perfFixture(100, 3), perfFixture(500, 5)];

const report = measure(fixtures, iterations, {
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpus: cpus().length,
});

const rows = [
  ["operation", "fixture", "iterations", "median_ms", "p95_ms"],
  ...report.measurements.map((m) => [
    m.operation,
    m.fixture,
    String(m.iterations),
    m.medianMs.toFixed(3),
    m.p95Ms.toFixed(3),
  ]),
];
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const row of rows) {
  console.log(
    row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd(),
  );
}

console.log("");
console.log(
  `environment: node ${report.environment.node} ${report.environment.platform}/${report.environment.arch}, ${report.environment.cpus} cpus`,
);
for (const fixture of report.fixtures) {
  console.log(`fixture ${fixture.name}: ${fixture.nodes} nodes, ${fixture.edges} edges`);
}
console.log("");
console.log(
  "These are measurements on synthetic fixtures on one machine. They are not a performance guarantee.",
);

if (process.argv.includes("--json")) {
  await writeFile("perf-results.json", `${JSON.stringify(report, null, 2)}\n`);
}
