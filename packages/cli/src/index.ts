#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";

import { DEFAULT_POLICY, checkSlot, classifyChunk } from "@provguard/inbound";
import { listScenarios, type Scenario, type ScenarioExpectation } from "@provguard/harness";
import { auditOutput } from "@provguard/outbound";
import type { Chunk, ContextSlot, Provenance, Reason, ReasonCode, SlotPolicy } from "@provguard/schema";

type Outcome = "allow" | "block";
type GuardStage = "inbound" | "outbound" | "none";
type BaselineOutcome = "catch" | "miss";

interface CheckInputChunk {
  id?: string;
  text?: string;
  raw?: string;
  provenance?: Partial<Provenance>;
}

interface CheckInput {
  chunks: Array<string | CheckInputChunk>;
  output?: string;
  candidateOutput?: string;
  slot?: string;
  policy?: SlotPolicy;
}

interface PipelineResult {
  outcome: Outcome;
  wouldBlock: boolean;
  monitor: boolean;
  stage: GuardStage;
  reasonCode: ReasonCode | null;
  reasons: Reason[];
  classifiedChunks: Chunk[];
  deliveredChunks: Chunk[];
  inboundVerdicts: Array<{ chunkId: string; verdict: ReturnType<typeof checkSlot> }>;
  outboundVerdict: ReturnType<typeof auditOutput>["verdict"];
}

export interface BenchScenarioResult {
  id: string;
  provenance: Scenario["provenance"];
  expected: ScenarioExpectation;
  actual: Outcome;
  passed: boolean;
  stage: GuardStage;
  reasonCode: ReasonCode | null;
  disabledBaseline: BaselineOutcome;
  shapeBaseline: BaselineOutcome;
  wouldBlock: boolean;
}

export interface BenchSummary {
  rates: {
    derived: string;
    constructed: string;
  };
  falsePositives: number;
  stageBreakdown: Record<GuardStage, number>;
  reasonBreakdown: Partial<Record<ReasonCode, number>>;
  disabledBaselineCatches: number;
  shapeBaselineCatches: number;
}

export interface BenchResult {
  monitor: boolean;
  scenarios: BenchScenarioResult[];
  summary: BenchSummary;
}

const DEFAULT_SLOT_NAME = "signals";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, args, flags } = parseArgs(argv);

  try {
    if (command === "check") {
      return await runCheckCommand(args, flags);
    }

    if (command === "bench") {
      return await runBenchCommand(flags);
    }

    printUsage();
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export async function runCheckFile(
  filePath: string,
  options: { monitor?: boolean } = {},
): Promise<PipelineResult> {
  const payload = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  const input = parseCheckInput(payload);
  return runPipeline(input.chunks, input.output, {
    policy: input.policy ?? DEFAULT_POLICY,
    slotName: input.slot ?? DEFAULT_SLOT_NAME,
    monitor: options.monitor ?? false,
  });
}

export function runBench(options: { monitor?: boolean } = {}): BenchResult {
  const monitor = options.monitor ?? false;
  const scenarios = listScenarios().map((scenario) => runBenchScenario(scenario, monitor));

  return {
    monitor,
    scenarios,
    summary: summarizeBench(scenarios),
  };
}

export function formatBenchTable(result: BenchResult): string {
  const headers = [
    "id",
    "provenance",
    "expected",
    "actual",
    "pass",
    "reason",
    "stage",
    "guards_disabled",
    "shape_check",
  ];
  const rows = result.scenarios.map((scenario) => [
    scenario.id,
    scenario.provenance,
    scenario.expected,
    scenario.actual,
    scenario.passed ? "pass" : "fail",
    scenario.reasonCode ?? "-",
    scenario.stage,
    scenario.disabledBaseline,
    scenario.shapeBaseline,
  ]);

  const summaryRows = [
    "",
    `derived catch rate: ${result.summary.rates.derived}`,
    `constructed catch rate: ${result.summary.rates.constructed}`,
    `false positives: ${result.summary.falsePositives}`,
    `stage breakdown: ${formatBreakdown(result.summary.stageBreakdown)}`,
    `reason breakdown: ${formatBreakdown(result.summary.reasonBreakdown)}`,
    `disabled baseline catches: ${result.summary.disabledBaselineCatches}`,
    `shape-check baseline catches: ${result.summary.shapeBaselineCatches}`,
  ];

  return [...formatRows([headers, ...rows]), ...summaryRows].join("\n");
}

export function formatCheckResult(result: PipelineResult): string {
  const inbound = result.inboundVerdicts
    .map(({ chunkId, verdict }) => {
      const codes = verdict.reasons.map((reason) => reason.code).join(", ") || "-";
      return `inbound ${chunkId}: ${verdict.decision} [${codes}]`;
    })
    .join("\n");
  const outboundCodes = result.outboundVerdict.reasons.map((reason) => reason.code).join(", ") || "-";

  return [
    `outcome: ${result.outcome}`,
    `monitor: ${result.monitor ? "on" : "off"}`,
    `would_block: ${result.wouldBlock ? "yes" : "no"}`,
    inbound,
    `outbound: ${result.outboundVerdict.decision} [${outboundCodes}]`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function runBenchScenario(scenario: Scenario, monitor: boolean): BenchScenarioResult {
  const pipeline = runPipeline(
    scenario.chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      provenance: chunk.provenance,
    })),
    scenario.simulatedOutput,
    { policy: DEFAULT_POLICY, slotName: DEFAULT_SLOT_NAME, monitor },
  );
  const expectedOutcome = scenario.expectation === "should_block" ? "block" : "allow";
  const actual = monitor ? "allow" : pipeline.outcome;

  return {
    id: scenario.id,
    provenance: scenario.provenance,
    expected: scenario.expectation,
    actual,
    passed: pipeline.outcome === expectedOutcome,
    stage: pipeline.stage,
    reasonCode: pipeline.reasonCode,
    disabledBaseline: "miss",
    shapeBaseline: shapeCheckCatches(scenario.simulatedOutput) ? "catch" : "miss",
    wouldBlock: pipeline.wouldBlock,
  };
}

function summarizeBench(results: BenchScenarioResult[]): BenchSummary {
  const shouldBlock = results.filter((result) => result.expected === "should_block");
  const falsePositives = results.filter(
    (result) => result.expected === "should_allow" && result.wouldBlock,
  ).length;
  const stageBreakdown: Record<GuardStage, number> = {
    inbound: 0,
    outbound: 0,
    none: 0,
  };
  const reasonBreakdown: Partial<Record<ReasonCode, number>> = {};

  for (const result of results) {
    if (!result.wouldBlock) continue;
    stageBreakdown[result.stage] += 1;
    if (result.reasonCode !== null) {
      reasonBreakdown[result.reasonCode] = (reasonBreakdown[result.reasonCode] ?? 0) + 1;
    }
  }

  return {
    rates: {
      derived: catchRate(shouldBlock.filter((result) => result.provenance === "derived")),
      constructed: catchRate(shouldBlock.filter((result) => result.provenance === "constructed")),
    },
    falsePositives,
    stageBreakdown,
    reasonBreakdown,
    disabledBaselineCatches: 0,
    shapeBaselineCatches: shouldBlock.filter((result) => result.shapeBaseline === "catch").length,
  };
}

function catchRate(results: BenchScenarioResult[]): string {
  const caught = results.filter((result) => result.wouldBlock).length;
  const total = results.length;
  const pct = total === 0 ? 0 : (caught / total) * 100;
  return `${caught}/${total} (${pct.toFixed(1)}%)`;
}

function runPipeline(
  chunks: CheckInput["chunks"],
  output: string,
  options: { policy: SlotPolicy; slotName: string; monitor: boolean },
): PipelineResult {
  const slot = resolveSlot(options.policy, options.slotName);
  const classifiedChunks = chunks.map(toChunk);
  const inboundVerdicts = classifiedChunks.map((chunk) => ({
    chunkId: chunk.id,
    verdict: checkSlot(chunk, slot),
  }));
  const inboundBlock = inboundVerdicts.find(({ verdict }) => verdict.decision === "block");
  const deliveredChunks = inboundVerdicts
    .filter(({ verdict }) => verdict.decision === "allow")
    .map(({ chunkId }) => requiredChunk(classifiedChunks, chunkId));
  const outbound = auditOutput(output, deliveredChunks);
  const outboundBlocks = outbound.verdict.decision === "block";
  const blocked = inboundBlock !== undefined || outboundBlocks;
  const stage: GuardStage =
    inboundBlock !== undefined ? "inbound" : outboundBlocks ? "outbound" : "none";
  const reasonCode =
    inboundBlock?.verdict.reasons[0]?.code ?? outbound.verdict.reasons[0]?.code ?? null;
  const reasons = [
    ...inboundVerdicts.flatMap(({ verdict }) => verdict.reasons),
    ...outbound.verdict.reasons,
  ];

  return {
    outcome: options.monitor ? "allow" : blocked ? "block" : "allow",
    wouldBlock: blocked,
    monitor: options.monitor,
    stage,
    reasonCode,
    reasons,
    classifiedChunks,
    deliveredChunks,
    inboundVerdicts,
    outboundVerdict: outbound.verdict,
  };
}

function toChunk(input: string | CheckInputChunk): Chunk {
  if (typeof input === "string") {
    return classifyChunk(input);
  }

  const text = input.text ?? input.raw;
  if (typeof text !== "string") {
    throw new Error("Each chunk object must include text or raw.");
  }

  const chunk = classifyChunk(text, input.provenance);
  return input.id === undefined ? chunk : { ...chunk, id: input.id };
}

function requiredChunk(chunks: Chunk[], id: string): Chunk {
  const chunk = chunks.find((candidate) => candidate.id === id);
  if (chunk === undefined) {
    throw new Error(`Internal error: missing delivered chunk ${id}.`);
  }
  return chunk;
}

function resolveSlot(policy: SlotPolicy, slotName: string): ContextSlot {
  const slot = policy.slots.find((candidate) => candidate.name === slotName);
  if (slot === undefined) {
    throw new Error(`Policy does not include slot ${slotName}.`);
  }
  return slot;
}

function parseCheckInput(payload: unknown): CheckInput & { output: string } {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Input JSON must be an object.");
  }

  const record = payload as Partial<CheckInput>;
  if (!Array.isArray(record.chunks)) {
    throw new Error("Input JSON must include chunks as an array.");
  }

  const output = record.output ?? record.candidateOutput;
  if (typeof output !== "string") {
    throw new Error("Input JSON must include output or candidateOutput as a string.");
  }

  return {
    chunks: record.chunks,
    output,
    ...(typeof record.slot === "string" ? { slot: record.slot } : {}),
    ...(record.policy === undefined ? {} : { policy: record.policy }),
  };
}

function shapeCheckCatches(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return true;
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

async function runCheckCommand(
  args: string[],
  flags: { monitor: boolean; json: boolean },
): Promise<number> {
  const file = args[0];
  if (file === undefined) {
    throw new Error("check requires <file.json>.");
  }

  const result = await runCheckFile(file, { monitor: flags.monitor });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCheckResult(result));
  }
  return result.wouldBlock && !flags.monitor ? 1 : 0;
}

async function runBenchCommand(flags: { monitor: boolean; json: boolean }): Promise<number> {
  const result = runBench({ monitor: flags.monitor });
  console.log(formatBenchTable(result));

  if (flags.json) {
    await writeFile("bench-results.json", `${JSON.stringify(result, null, 2)}\n`);
  }

  return result.scenarios.every((scenario) => scenario.passed) ? 0 : 1;
}

function parseArgs(argv: string[]): {
  command: string | undefined;
  args: string[];
  flags: { monitor: boolean; json: boolean };
} {
  const flags = {
    monitor: false,
    json: false,
  };
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--monitor") {
      flags.monitor = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    args: positional.slice(1),
    flags,
  };
}

function printUsage(): void {
  console.error(`Usage:
  provguard check <file.json> [--monitor] [--json]
  provguard bench [--monitor] [--json]`);
}

function formatRows(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  if (widths === undefined) return [];

  return rows.map((row) =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd(),
  );
}

function formatBreakdown<T extends string>(breakdown: Partial<Record<T, number>>): string {
  return Object.entries(breakdown)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

if (process.argv[1] !== undefined && basename(process.argv[1]) === "index.js") {
  const code = await main();
  process.exitCode = code;
}
