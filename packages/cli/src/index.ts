#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";

import type {
  Scenario,
  ScenarioDifficulty,
  ScenarioExpectedGate,
  ScenarioExpectation,
  ScenarioProvenance,
} from "@provguard/harness";
import type {
  Chunk,
  Claim,
  ContextSlot,
  Grounding,
  Provenance,
  Reason,
  ReasonCode,
  SlotPolicy,
  Verdict,
} from "@provguard/schema";

import {
  auditFromPipeline,
  formatExplain,
  formatImpact,
  formatTrace,
  formatValidation,
  type GraphRuntime,
} from "./graph.js";

type Outcome = "allow" | "block";
type GuardStage = "inbound" | "outbound" | "none";
type BaselineOutcome = "catch" | "miss";
type RateKind = "recall" | "false_positive";

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
  inboundVerdicts: Array<{ chunkId: string; verdict: Verdict }>;
  outboundVerdict: Verdict;
  /** Per-claim grounding results, carried so the lineage graph can record them. */
  groundings: Grounding[];
  claims: Claim[];
  output: string;
  slotName: string;
}

interface InboundRuntime {
  DEFAULT_POLICY: SlotPolicy;
  checkSlot(chunk: Chunk, slot: ContextSlot): Verdict;
  classifyChunk(raw: string, hints?: Partial<Provenance>): Chunk;
}

interface HarnessRuntime {
  listScenarios(): Scenario[];
}

interface OutboundRuntime {
  auditOutput(
    output: string,
    chunks: Chunk[],
  ): { verdict: Verdict; groundings: Grounding[]; assessments: { claim: Claim }[] };
}

interface Runtime {
  inbound: InboundRuntime;
  harness: HarnessRuntime;
  outbound: OutboundRuntime;
}

export interface BenchScenarioResult {
  id: string;
  provenance: Scenario["provenance"];
  difficulty: ScenarioDifficulty;
  expectedGate: ScenarioExpectedGate;
  actualGate: GuardStage;
  expected: ScenarioExpectation;
  actual: Outcome;
  passed: boolean;
  stage: GuardStage;
  reasonCode: ReasonCode | null;
  disabledBaseline: BaselineOutcome;
  shapeBaseline: BaselineOutcome;
  wouldBlock: boolean;
}

export interface BenchRate {
  kind: RateKind;
  difficulty: ScenarioDifficulty;
  provenance?: ScenarioProvenance;
  numerator: number;
  denominator: number;
  percent: number | null;
  label: string;
}

export interface BenchGateBreakdown {
  expected: Record<ScenarioExpectedGate, number>;
  actual: Record<GuardStage, number>;
  expectedActual: Record<string, number>;
  outboundValidated: number;
}

export interface BenchSummary {
  recall: Record<ScenarioDifficulty, Record<ScenarioProvenance, BenchRate>>;
  falsePositiveRate: Record<ScenarioDifficulty, BenchRate>;
  gateBreakdown: BenchGateBreakdown;
  saturationWarnings: string[];
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
  try {
    // Inside the try: argument parsing can reject a malformed flag, and a CLI
    // that throws a stack trace at the user for a typo is a broken CLI.
    const { command, args, flags } = parseArgs(argv);

    if (command === "check") {
      return await runCheckCommand(args, flags);
    }

    if (command === "bench") {
      return await runBenchCommand(flags);
    }

    if (command === "trace" || command === "explain" || command === "impact") {
      return await runTraversalCommand(command, args, flags);
    }

    if (command === "graph") {
      return await runGraphCommand(args, flags);
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
  const runtime = await loadRuntime();
  return runPipeline(runtime, input.chunks, input.output, {
    policy: input.policy ?? runtime.inbound.DEFAULT_POLICY,
    slotName: input.slot ?? DEFAULT_SLOT_NAME,
    monitor: options.monitor ?? false,
  });
}

export async function runBench(options: { monitor?: boolean } = {}): Promise<BenchResult> {
  const runtime = await loadRuntime();
  const monitor = options.monitor ?? false;
  const scenarios = runtime.harness
    .listScenarios()
    .map((scenario) => runBenchScenario(runtime, scenario, monitor));

  return {
    monitor,
    scenarios,
    summary: summarizeBench(scenarios),
  };
}

export function formatBenchTable(result: BenchResult): string {
  const headers = [
    "id",
    "difficulty",
    "provenance",
    "expected",
    "actual",
    "pass",
    "expected_gate",
    "actual_gate",
    "reason",
    "stage",
    "guards_disabled",
    "shape_check",
  ];
  const rows = result.scenarios.map((scenario) => [
    scenario.id,
    scenario.difficulty,
    scenario.provenance,
    scenario.expected,
    scenario.actual,
    scenario.passed ? "pass" : "fail",
    scenario.expectedGate,
    scenario.actualGate,
    scenario.reasonCode ?? "-",
    scenario.stage,
    scenario.disabledBaseline,
    scenario.shapeBaseline,
  ]);

  const summaryRows = [
    "",
    "recall on block scenarios:",
    ...formatRecallRows(result.summary.recall),
    "false-positive rate on controls:",
    ...formatFalsePositiveRows(result.summary.falsePositiveRate),
    `outbound gate validations: ${result.summary.gateBreakdown.outboundValidated}`,
    `expected gate breakdown: ${formatBreakdown(result.summary.gateBreakdown.expected)}`,
    `actual gate breakdown: ${formatBreakdown(result.summary.gateBreakdown.actual)}`,
    `expected->actual gate breakdown: ${formatBreakdown(result.summary.gateBreakdown.expectedActual)}`,
    `stage breakdown: ${formatBreakdown(result.summary.stageBreakdown)}`,
    `reason breakdown: ${formatBreakdown(result.summary.reasonBreakdown)}`,
    `disabled baseline catches: ${result.summary.disabledBaselineCatches}`,
    `shape-check baseline catches: ${result.summary.shapeBaselineCatches}`,
    ...formatSaturationWarnings(result.summary.saturationWarnings),
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
  const outboundCodes =
    result.outboundVerdict.reasons.map((reason) => reason.code).join(", ") || "-";

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

function runBenchScenario(
  runtime: Runtime,
  scenario: Scenario,
  monitor: boolean,
): BenchScenarioResult {
  const pipeline = runPipeline(
    runtime,
    scenario.chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      provenance: chunk.provenance,
    })),
    scenario.simulatedOutput,
    { policy: runtime.inbound.DEFAULT_POLICY, slotName: DEFAULT_SLOT_NAME, monitor },
  );
  const expectedOutcome = scenario.expectation === "should_block" ? "block" : "allow";
  const actual = monitor ? "allow" : pipeline.outcome;

  return {
    id: scenario.id,
    provenance: scenario.provenance,
    difficulty: scenario.difficulty,
    expectedGate: scenario.expectedGate,
    actualGate: pipeline.stage,
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
  const controls = results.filter((result) => result.expected === "should_allow");
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

  const recall = buildRecallRates(shouldBlock);
  const falsePositiveRate = buildFalsePositiveRates(controls);
  const gateBreakdown = buildGateBreakdown(results);

  return {
    recall,
    falsePositiveRate,
    gateBreakdown,
    saturationWarnings: saturationWarnings(recall, falsePositiveRate),
    stageBreakdown,
    reasonBreakdown,
    disabledBaselineCatches: 0,
    shapeBaselineCatches: shouldBlock.filter((result) => result.shapeBaseline === "catch").length,
  };
}

function buildRecallRates(
  shouldBlock: BenchScenarioResult[],
): Record<ScenarioDifficulty, Record<ScenarioProvenance, BenchRate>> {
  return {
    basic: {
      derived: recallRate(
        "basic",
        "derived",
        shouldBlock.filter(
          (result) => result.difficulty === "basic" && result.provenance === "derived",
        ),
      ),
      constructed: recallRate(
        "basic",
        "constructed",
        shouldBlock.filter(
          (result) => result.difficulty === "basic" && result.provenance === "constructed",
        ),
      ),
    },
    hard: {
      derived: recallRate(
        "hard",
        "derived",
        shouldBlock.filter(
          (result) => result.difficulty === "hard" && result.provenance === "derived",
        ),
      ),
      constructed: recallRate(
        "hard",
        "constructed",
        shouldBlock.filter(
          (result) => result.difficulty === "hard" && result.provenance === "constructed",
        ),
      ),
    },
  };
}

function buildFalsePositiveRates(
  controls: BenchScenarioResult[],
): Record<ScenarioDifficulty, BenchRate> {
  return {
    basic: falsePositiveRate(
      "basic",
      controls.filter((result) => result.difficulty === "basic"),
    ),
    hard: falsePositiveRate(
      "hard",
      controls.filter((result) => result.difficulty === "hard"),
    ),
  };
}

function buildGateBreakdown(results: BenchScenarioResult[]): BenchGateBreakdown {
  const expected: Record<ScenarioExpectedGate, number> = {
    inbound: 0,
    outbound: 0,
    either: 0,
  };
  const actual: Record<GuardStage, number> = {
    inbound: 0,
    outbound: 0,
    none: 0,
  };
  const expectedActual: Record<string, number> = {};

  for (const result of results) {
    expected[result.expectedGate] += 1;
    actual[result.actualGate] += 1;
    const pair = `${result.expectedGate}->${result.actualGate}`;
    expectedActual[pair] = (expectedActual[pair] ?? 0) + 1;
  }

  return {
    expected,
    actual,
    expectedActual,
    outboundValidated: results.filter(
      (result) =>
        result.expected === "should_block" &&
        result.expectedGate === "outbound" &&
        result.actualGate === "outbound",
    ).length,
  };
}

function recallRate(
  difficulty: ScenarioDifficulty,
  provenance: ScenarioProvenance,
  results: BenchScenarioResult[],
): BenchRate {
  return makeRate({
    kind: "recall",
    difficulty,
    provenance,
    numerator: results.filter((result) => result.wouldBlock).length,
    denominator: results.length,
  });
}

function falsePositiveRate(
  difficulty: ScenarioDifficulty,
  results: BenchScenarioResult[],
): BenchRate {
  return makeRate({
    kind: "false_positive",
    difficulty,
    numerator: results.filter((result) => result.wouldBlock).length,
    denominator: results.length,
  });
}

function makeRate(input: {
  kind: RateKind;
  difficulty: ScenarioDifficulty;
  provenance?: ScenarioProvenance;
  numerator: number;
  denominator: number;
}): BenchRate {
  const percent = input.denominator === 0 ? null : (input.numerator / input.denominator) * 100;

  return {
    ...input,
    percent,
    label:
      percent === null
        ? "n/a (0 scenarios)"
        : `${input.numerator}/${input.denominator} (${percent.toFixed(1)}%)`,
  };
}

function saturationWarnings(
  recall: BenchSummary["recall"],
  falsePositiveRate: BenchSummary["falsePositiveRate"],
): string[] {
  const rates = [
    recall.basic.derived,
    recall.basic.constructed,
    recall.hard.derived,
    recall.hard.constructed,
    falsePositiveRate.basic,
    falsePositiveRate.hard,
  ];

  return rates
    .filter((rate) => rate.percent === 100 && rate.denominator < 5)
    .map((rate) => {
      const provenance = rate.provenance === undefined ? "" : ` ${rate.provenance}`;
      const label =
        rate.kind === "recall"
          ? `${rate.difficulty}${provenance} recall`
          : `${rate.difficulty} false-positive rate`;
      return `Saturation warning: ${label} is 100% with only ${rate.denominator} scenarios; this result detects regressions but does not measure adequacy.`;
    });
}

function runPipeline(
  runtime: Runtime,
  chunks: CheckInput["chunks"],
  output: string,
  options: { policy: SlotPolicy; slotName: string; monitor: boolean },
): PipelineResult {
  const slot = resolveSlot(options.policy, options.slotName);
  const classifiedChunks = chunks.map((chunk) => toChunk(runtime, chunk));
  const inboundVerdicts = classifiedChunks.map((chunk) => ({
    chunkId: chunk.id,
    verdict: runtime.inbound.checkSlot(chunk, slot),
  }));
  const inboundBlock = inboundVerdicts.find(({ verdict }) => verdict.decision === "block");
  const deliveredChunks = inboundVerdicts
    .filter(({ verdict }) => verdict.decision === "allow")
    .map(({ chunkId }) => requiredChunk(classifiedChunks, chunkId));
  const outbound = runtime.outbound.auditOutput(output, deliveredChunks);
  const outboundBlocks = outbound.verdict.decision === "block";
  const blocked = inboundBlock !== undefined || outboundBlocks;
  const stage: GuardStage =
    inboundBlock !== undefined ? "inbound" : outboundBlocks ? "outbound" : "none";
  const reasonCode =
    inboundBlock?.verdict.reasons[0]?.code ??
    (outboundBlocks ? (outbound.verdict.reasons[0]?.code ?? null) : null);
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
    groundings: outbound.groundings,
    claims: outbound.assessments.map((assessment) => assessment.claim),
    output,
    slotName: options.slotName,
  };
}

function toChunk(runtime: Runtime, input: string | CheckInputChunk): Chunk {
  if (typeof input === "string") {
    return runtime.inbound.classifyChunk(input);
  }

  const text = input.text ?? input.raw;
  if (typeof text !== "string") {
    throw new Error("Each chunk object must include text or raw.");
  }

  const chunk = runtime.inbound.classifyChunk(text, input.provenance);
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

async function runCheckCommand(args: string[], flags: CliFlags): Promise<number> {
  const file = args[0];
  if (file === undefined) {
    throw new Error("check requires <file.json>.");
  }

  const result = await runCheckFile(file, { monitor: flags.monitor });

  if (flags.graphPath !== null) {
    await writeGraphForRun(result, flags);
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCheckResult(result));
  }
  return result.wouldBlock && !flags.monitor ? 1 : 0;
}

/**
 * Writes the lineage graph for a completed check.
 *
 * Redacted by default. The graph carries the raw chunk and output text, which
 * is the material the guard was protecting; an export is exactly where it would
 * escape, so including it has to be asked for.
 */
async function writeGraphForRun(result: PipelineResult, flags: CliFlags): Promise<void> {
  const graphRuntime = await loadGraphRuntime();
  const observedAt = flags.observedAt ?? new Date().toISOString();

  const audit = auditFromPipeline(
    graphRuntime,
    {
      classifiedChunks: result.classifiedChunks,
      deliveredChunks: result.deliveredChunks,
      inboundVerdicts: result.inboundVerdicts,
      outboundVerdict: result.outboundVerdict,
      groundings: result.groundings,
      claims: result.claims,
      output: result.output,
      // In monitor mode the output is delivered even when it would have been
      // blocked, which is the distinction the ledger has to preserve.
      delivered: flags.monitor || !result.wouldBlock,
      monitor: flags.monitor,
      slotName: result.slotName,
    },
    {
      tenantId: flags.tenant,
      observedAt,
      policyVersion: "1",
    },
  );

  const graph = graphRuntime.buildGraph(audit);
  await writeFile(
    flags.graphPath as string,
    `${graphRuntime.toCanonicalJSON(graph, { redact: !flags.unredacted })}\n`,
  );
}

/**
 * `trace`, `explain` and `impact` are read-only reporting. They exit 0 even
 * when they find nothing: "this claim rests on no evidence" is an answer, not
 * a command failure, and exiting non-zero would make it indistinguishable from
 * an unreadable file in a shell pipeline.
 */
async function runTraversalCommand(
  command: "trace" | "explain" | "impact",
  args: string[],
  flags: CliFlags,
): Promise<number> {
  const [graphPath, nodeId] = args;
  if (graphPath === undefined || nodeId === undefined) {
    throw new Error(`${command} requires <graph.json> <node-id>.`);
  }

  const graphRuntime = await loadGraphRuntime();
  const graph = graphRuntime.fromCanonicalJSON(await readFile(graphPath, "utf8"));
  const store = new graphRuntime.MemoryGraphStore(graph);

  if (command === "trace") {
    const result = graphRuntime.trace(store, flags.tenant, nodeId);
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatTrace(store, result));
    return 0;
  }

  if (command === "explain") {
    const result = graphRuntime.explain(store, flags.tenant, nodeId);
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatExplain(store, result));
    return 0;
  }

  const result = graphRuntime.impact(store, flags.tenant, nodeId);
  console.log(flags.json ? JSON.stringify(result, null, 2) : formatImpact(result));
  return 0;
}

/**
 * `graph validate` exits 1 when the graph has violations, so it can gate CI in
 * the same way `check` does.
 */
async function runGraphCommand(args: string[], flags: CliFlags): Promise<number> {
  const [subcommand, graphPath] = args;
  if (subcommand !== "validate") {
    throw new Error("graph supports one subcommand: validate.");
  }

  if (graphPath === undefined) {
    throw new Error("graph validate requires <graph.json>.");
  }

  const graphRuntime = await loadGraphRuntime();
  const graph = graphRuntime.fromCanonicalJSON(await readFile(graphPath, "utf8"));
  const report = graphRuntime.validateGraph(graph);

  console.log(flags.json ? JSON.stringify(report, null, 2) : formatValidation(report));
  return report.valid ? 0 : 1;
}

async function runBenchCommand(flags: { monitor: boolean; json: boolean }): Promise<number> {
  const result = await runBench({ monitor: flags.monitor });
  console.log(formatBenchTable(result));

  if (flags.json) {
    await writeFile("bench-results.json", `${JSON.stringify(result, null, 2)}\n`);
  }

  return result.scenarios.every((scenario) => scenario.difficulty === "hard" || scenario.passed)
    ? 0
    : 1;
}

interface CliFlags {
  monitor: boolean;
  json: boolean;
  tenant: string;
  graphPath: string | null;
  unredacted: boolean;
  /**
   * Pins the ledger observation time. IDs never depend on it, so this only
   * affects the recorded `observedAt` — but pinning it makes `--json` output
   * byte-reproducible, which is what a CI diff needs.
   */
  observedAt: string | null;
}

const DEFAULT_TENANT = "local";

function parseArgs(argv: string[]): {
  command: string | undefined;
  args: string[];
  flags: CliFlags;
} {
  const flags: CliFlags = {
    monitor: false,
    json: false,
    tenant: DEFAULT_TENANT,
    graphPath: null,
    unredacted: false,
    observedAt: null,
  };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;

    if (arg === "--monitor") {
      flags.monitor = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--unredacted") {
      flags.unredacted = true;
    } else if (arg === "--tenant" || arg === "--graph" || arg === "--observed-at") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      if (arg === "--tenant") flags.tenant = value;
      else if (arg === "--graph") flags.graphPath = value;
      else flags.observedAt = value;
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
  provguard check <file.json> [--monitor] [--json] [--graph <out.json>] [--unredacted]
  provguard bench [--monitor] [--json]
  provguard trace <graph.json> <node-id> [--json] [--tenant <id>]
  provguard explain <graph.json> <node-id> [--json] [--tenant <id>]
  provguard impact <graph.json> <node-id> [--json] [--tenant <id>]
  provguard graph validate <graph.json> [--json]

Common flags:
  --tenant <id>        tenant to read (default: ${DEFAULT_TENANT})
  --observed-at <iso>  pin the ledger observation time for reproducible output
  --unredacted         include raw chunk, claim and output text in an exported graph`);
}

function formatRows(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  if (widths === undefined) return [];

  return rows.map((row) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

function formatRecallRows(rates: BenchSummary["recall"]): string[] {
  return [
    `  basic derived: ${rates.basic.derived.label}`,
    `  basic constructed: ${rates.basic.constructed.label}`,
    `  hard derived: ${rates.hard.derived.label}`,
    `  hard constructed: ${rates.hard.constructed.label}`,
  ];
}

function formatFalsePositiveRows(rates: BenchSummary["falsePositiveRate"]): string[] {
  return [`  basic: ${rates.basic.label}`, `  hard: ${rates.hard.label}`];
}

function formatSaturationWarnings(warnings: string[]): string[] {
  if (warnings.length === 0) {
    return [];
  }

  return ["", ...warnings];
}

function formatBreakdown<T extends string>(breakdown: Partial<Record<T, number>>): string {
  return Object.entries(breakdown)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

async function loadRuntime(): Promise<Runtime> {
  if (process.env.VITEST_WORKER_ID !== undefined) {
    const [inbound, harness, outbound] = await Promise.all([
      import(/* @vite-ignore */ new URL("../../inbound/src/index.js", import.meta.url).href),
      import(/* @vite-ignore */ new URL("../../harness/src/index.js", import.meta.url).href),
      import(/* @vite-ignore */ new URL("../../outbound/src/index.js", import.meta.url).href),
    ]);
    return {
      inbound: inbound as InboundRuntime,
      harness: harness as HarnessRuntime,
      outbound: outbound as OutboundRuntime,
    };
  }

  const [inbound, harness, outbound] = await Promise.all([
    importPackage("@provguard/inbound"),
    importPackage("@provguard/harness"),
    importPackage("@provguard/outbound"),
  ]);
  return {
    inbound: inbound as InboundRuntime,
    harness: harness as HarnessRuntime,
    outbound: outbound as OutboundRuntime,
  };
}

async function importPackage(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}

/**
 * Loads `@provguard/graph` the same way the guards are loaded, so one build
 * works both from `src` under vitest and from `dist` as an installed binary.
 */
async function loadGraphRuntime(): Promise<GraphRuntime> {
  if (process.env.VITEST_WORKER_ID !== undefined) {
    return (await import(
      /* @vite-ignore */ new URL("../../graph/src/index.js", import.meta.url).href
    )) as GraphRuntime;
  }

  return (await importPackage("@provguard/graph")) as GraphRuntime;
}

if (
  process.argv[1] !== undefined &&
  (basename(process.argv[1]) === "index.js" || basename(process.argv[1]) === "provguard.js")
) {
  const code = await main();
  process.exitCode = code;
}
