#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  CliError,
  EXIT_USAGE,
  asCliError,
  formatCliError,
  parseJsonInput,
  readInputFile,
} from "./errors.js";
import { basename } from "node:path";
import process from "node:process";

import { ScenarioDifficulties } from "@provguard/schema";
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
type ControlOutcome = "delivered" | "withheld";

/**
 * What a control execution must hand back to prove it processed the scenario.
 *
 * Every field is derived from the input. An invocation counter proves a
 * function was called; this proves it read the chunks it was given, in order,
 * without altering them. That distinction is the whole point: the previous
 * design was satisfied by `controlInvocations += 1; return CONSTANT`.
 */
export interface ControlEvidence {
  readonly scenarioId: string;
  readonly control: ControlOutcome;
  readonly chunkCount: number;
  /** Delivered chunk ids, in delivery order. */
  readonly chunkIds: readonly string[];
  /** Hash of each delivered chunk's text, in delivery order. */
  readonly contentHashes: readonly string[];
  /** `channel:tier` for each delivered chunk, in delivery order. */
  readonly provenanceLabels: readonly string[];
  readonly outputHash: string;
}

/** A control implementation. Injectable so the suite can test broken ones. */
export type DisabledControl = (runtime: Runtime, scenario: Scenario) => ControlEvidence;
/** Whether the guard changed this scenario's outcome versus the executed control. */
type GuardEffect = "changed" | "none";
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
  /**
   * Outcome of executing this scenario with the guards bypassed. Always
   * `delivered`: an unguarded pipeline withholds nothing. Reported per scenario
   * only as evidence the control ran, never as a result.
   */
  control: ControlOutcome;
  /** Chunks that reached context under the control. Evidence it ran. */
  controlAdmittedChunks: number;
  /**
   * The measured quantity: did the guard change this scenario's outcome
   * relative to the executed control?
   *
   * This is what the disabled control is for. "The control caught nothing" is
   * true by construction and worth no column. "The guard changed the outcome
   * here and not there" is measured, varies across the corpus, and can fail --
   * every scenario the guards miss shows `none`.
   */
  guardEffect: GuardEffect;
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
  /**
   * How many block-scenarios actually delivered their polluted output when the
   * guards were bypassed. This can fail: a scenario whose pollution does not
   * reach context is not testing what it claims.
   */
  guardChangedOutcome: BenchRate;
  /** Times the disabled control was actually invoked. Guards against an empty loop. */
  controlInvocations: number;
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
    return EXIT_USAGE;
  } catch (error) {
    const failure = asCliError(
      error,
      "INPUT_INVALID_CHECK",
      "Check the command arguments and input file.",
    );

    // --json gets a stable object so a pipeline can branch on `code` without
    // parsing English. Everything else gets two readable lines and no stack.
    // Re-read only the two output flags, from a parse that cannot throw: the
    // failure may itself be a malformed-argument error, and the handler must
    // not fail while reporting a failure.
    if (argv.includes("--json")) {
      console.error(JSON.stringify(failure.toJSON(), null, 2));
    } else {
      console.error(formatCliError(failure, argv.includes("--debug")));
    }

    return EXIT_USAGE;
  }
}

export async function runCheckFile(
  filePath: string,
  options: { monitor?: boolean } = {},
): Promise<PipelineResult> {
  const text = await readInputFile(filePath, "check input");
  const payload = parseJsonInput(text, filePath, "check input");
  const input = parseCheckInput(payload);
  const runtime = await loadRuntime();
  return runPipeline(runtime, input.chunks, input.output, {
    policy: input.policy ?? runtime.inbound.DEFAULT_POLICY,
    slotName: input.slot ?? DEFAULT_SLOT_NAME,
    monitor: options.monitor ?? false,
  });
}

export async function runBench(
  options: { monitor?: boolean; control?: DisabledControl } = {},
): Promise<BenchResult> {
  const runtime = await loadRuntime();
  resetControlInvocations();
  const control = options.control ?? defaultDisabledControl;
  const monitor = options.monitor ?? false;
  const scenarios = runtime.harness
    .listScenarios()
    .map((scenario) => runBenchScenario(runtime, scenario, monitor, control));

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
    "guard_effect",
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
    scenario.guardEffect,
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
    `guard changed the outcome on: ${result.summary.guardChangedOutcome.label} of block scenarios`,
    `disabled-control invocations: ${result.summary.controlInvocations}`,
    `shape-check baseline catches: ${result.summary.shapeBaselineCatches}`,
    "not measured, true by construction: an unguarded pipeline withholds nothing",
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

/**
 * Counts every disabled-control execution.
 *
 * Without this, a loop that never ran would report a clean zero and look
 * identical to a loop that ran and found nothing. The bench asserts the count
 * matches the scenario count.
 */
let controlInvocations = 0;

export function resetControlInvocations(): void {
  controlInvocations = 0;
}

export function controlInvocationCount(): number {
  return controlInvocations;
}

/**
 * A runtime with the guards bypassed, wrapping the real one.
 *
 * Explicit rather than a flag threaded through the guard itself: the guard has
 * no "off" mode, and giving it one would put a bypass in production code to
 * serve a benchmark. Classification still runs, so chunks are still described;
 * only the admission and grounding *decisions* are replaced.
 */
function disabledRuntime(runtime: Runtime): Runtime {
  return {
    inbound: {
      DEFAULT_POLICY: runtime.inbound.DEFAULT_POLICY,
      classifyChunk: (raw, hints) => runtime.inbound.classifyChunk(raw, hints),
      // Admits everything. This is what an unguarded pipeline does.
      checkSlot: () => ({ decision: "allow", reasons: [] }),
    },
    harness: runtime.harness,
    outbound: {
      // Delivers everything, with no claims extracted and nothing grounded.
      auditOutput: () => ({
        verdict: { decision: "allow", reasons: [] },
        groundings: [],
        assessments: [],
      }),
    },
  };
}

/**
 * Runs one scenario with the guards bypassed and reports what happened.
 *
 * The question is not "did it catch anything" — a disabled pipeline catches
 * nothing by definition, and measuring that would be an executed tautology.
 * The question is whether the pollution actually reaches context and the output
 * actually ships, which is a property of the scenario and can be false.
 */
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The real control: runs the scenario through a bypassed pipeline. */
export const defaultDisabledControl: DisabledControl = (runtime, scenario) => {
  const pipeline = runPipeline(
    disabledRuntime(runtime),
    scenario.chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      provenance: chunk.provenance,
    })),
    scenario.simulatedOutput,
    { policy: runtime.inbound.DEFAULT_POLICY, slotName: DEFAULT_SLOT_NAME, monitor: false },
  );

  return {
    scenarioId: scenario.id,
    control: pipeline.wouldBlock ? "withheld" : "delivered",
    chunkCount: pipeline.deliveredChunks.length,
    chunkIds: pipeline.deliveredChunks.map((chunk) => chunk.id),
    contentHashes: pipeline.deliveredChunks.map((chunk) => hashText(chunk.text)),
    provenanceLabels: pipeline.deliveredChunks.map(
      (chunk) => `${chunk.provenance.channel}:${chunk.provenance.tier}`,
    ),
    outputHash: hashText(pipeline.output),
  };
};

/**
 * Rejects any control whose output does not correspond to its input.
 *
 * Runs inside the benchmark on **every** execution, not only in tests. A check
 * that lives only in the test suite can be bypassed by changing the
 * implementation without running it; this way the benchmark refuses to report a
 * number it could not verify.
 *
 * The control contract: an unguarded pipeline admits every chunk and alters
 * nothing. Any deviation means a differential was measured against a control
 * that did not run, which is not a measurement.
 */
export function verifyControlEvidence(scenario: Scenario, evidence: ControlEvidence): void {
  const fail = (detail: string): never => {
    throw new Error(
      `disabled control produced evidence inconsistent with scenario ${scenario.id}: ${detail}`,
    );
  };

  if (evidence.scenarioId !== scenario.id) {
    fail(`reported scenario ${evidence.scenarioId}`);
  }

  const expectedIds = scenario.chunks.map((chunk) => chunk.id);
  const expectedHashes = scenario.chunks.map((chunk) => hashText(chunk.text));

  if (evidence.chunkCount !== scenario.chunks.length) {
    fail(`saw ${evidence.chunkCount} chunks, scenario supplies ${scenario.chunks.length}`);
  }

  if (evidence.chunkIds.length !== expectedIds.length) {
    fail(`reported ${evidence.chunkIds.length} chunk ids for ${expectedIds.length} chunks`);
  }

  // Order matters: chunk ordinal is part of graph identity, and a control that
  // reorders is not reproducing the pipeline it stands in for.
  for (const [index, id] of expectedIds.entries()) {
    if (evidence.chunkIds[index] !== id) {
      fail(`chunk ${index} is ${String(evidence.chunkIds[index])}, expected ${id}`);
    }
  }

  for (const [index, hash] of expectedHashes.entries()) {
    if (evidence.contentHashes[index] !== hash) {
      fail(`chunk ${index} content was altered in transit`);
    }
  }

  if (evidence.provenanceLabels.length !== expectedIds.length) {
    fail(`reported ${evidence.provenanceLabels.length} provenance labels`);
  }

  for (const [index, label] of evidence.provenanceLabels.entries()) {
    if (!/^[A-Z_]+:T[1-5]$/.test(label)) {
      fail(`chunk ${index} has an unusable provenance label ${JSON.stringify(label)}`);
    }
  }

  if (evidence.outputHash !== hashText(scenario.simulatedOutput)) {
    fail("output was altered in transit");
  }

  // Bypass semantics: with the guards off, nothing is withheld.
  if (evidence.control !== "delivered") {
    fail(`reported ${evidence.control}, but an unguarded pipeline withholds nothing`);
  }
}

function runBenchScenario(
  runtime: Runtime,
  scenario: Scenario,
  monitor: boolean,
  control: DisabledControl,
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
  controlInvocations += 1;
  const evidence = control(runtime, scenario);
  // Verified before it is allowed to influence any reported number.
  verifyControlEvidence(scenario, evidence);

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
    control: evidence.control,
    controlAdmittedChunks: evidence.chunkCount,
    // Measured both ways, then compared. Not derived from the scenario's
    // declared expectation.
    guardEffect: pipeline.wouldBlock === (evidence.control === "withheld") ? "none" : "changed",
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
    guardChangedOutcome: makeRate({
      kind: "recall",
      difficulty: "basic",
      numerator: shouldBlock.filter((result) => result.guardEffect === "changed").length,
      denominator: shouldBlock.length,
    }),
    controlInvocations: controlInvocationCount(),
    shapeBaselineCatches: shouldBlock.filter((result) => result.shapeBaseline === "catch").length,
  };
}

/**
 * Built by iterating the difficulty enum rather than naming tiers.
 *
 * Adding a tier used to mean editing this function, the false-positive
 * builder, and both formatters, with nothing to catch a tier left out of one
 * of them. Now a new tier appears everywhere or nowhere.
 */
function buildRecallRates(
  shouldBlock: BenchScenarioResult[],
): Record<ScenarioDifficulty, Record<ScenarioProvenance, BenchRate>> {
  const rates = {} as Record<ScenarioDifficulty, Record<ScenarioProvenance, BenchRate>>;

  for (const difficulty of ScenarioDifficulties) {
    rates[difficulty] = {
      derived: recallRate(
        difficulty,
        "derived",
        shouldBlock.filter(
          (result) => result.difficulty === difficulty && result.provenance === "derived",
        ),
      ),
      constructed: recallRate(
        difficulty,
        "constructed",
        shouldBlock.filter(
          (result) => result.difficulty === difficulty && result.provenance === "constructed",
        ),
      ),
    };
  }

  return rates;
}

function buildFalsePositiveRates(
  controls: BenchScenarioResult[],
): Record<ScenarioDifficulty, BenchRate> {
  const rates = {} as Record<ScenarioDifficulty, BenchRate>;

  for (const difficulty of ScenarioDifficulties) {
    rates[difficulty] = falsePositiveRate(
      difficulty,
      controls.filter((result) => result.difficulty === difficulty),
    );
  }

  return rates;
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
  const graph = readGraphDocument(graphRuntime, await readInputFile(graphPath, "graph"), graphPath);
  const store = loadGraphStore(graphRuntime, graph, graphPath);

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
 * Parses a graph document, distinguishing "not JSON" from "not a graph".
 *
 * A caller who hands over a truncated file and a caller who hands over a
 * well-formed document of the wrong shape have different problems, and one
 * message for both leaves each of them guessing.
 */
function readGraphDocument(
  graphRuntime: GraphRuntime,
  text: string,
  path: string,
): ReturnType<GraphRuntime["fromCanonicalJSON"]> {
  try {
    return graphRuntime.fromCanonicalJSON(text);
  } catch (error) {
    const looksLikeJson = (() => {
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    })();

    throw new CliError(
      looksLikeJson ? "INPUT_INVALID_GRAPH" : "INPUT_MALFORMED_JSON",
      looksLikeJson
        ? `graph file is not a valid graph document: ${path}`
        : `graph file is not valid JSON: ${path}`,
      error instanceof Error ? error.message : "Check the file contents.",
      error,
    );
  }
}

/** Loads a validated store, reporting a refused document as an input error. */
function loadGraphStore(
  graphRuntime: GraphRuntime,
  graph: ReturnType<GraphRuntime["fromCanonicalJSON"]>,
  path: string,
): InstanceType<GraphRuntime["MemoryGraphStore"]> {
  try {
    return new graphRuntime.MemoryGraphStore(graph);
  } catch (error) {
    throw new CliError(
      "INPUT_INVALID_GRAPH",
      `graph file was refused: ${path}`,
      error instanceof Error ? error.message : "Run `provguard graph validate` for details.",
      error,
    );
  }
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
  const graph = readGraphDocument(graphRuntime, await readInputFile(graphPath, "graph"), graphPath);
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

  // Only the basic tier gates. `hard` and `mixed` are measurement tiers that
  // are expected to contain failures -- those failures are the most useful
  // thing the bench produces, and a command that exits non-zero on them could
  // not be run in CI without either being ignored or being "fixed" by deleting
  // the scenarios that fail. The regression gate for those tiers is `pnpm
  // test`, which pins their rates.
  return result.scenarios.every((scenario) => scenario.difficulty !== "basic" || scenario.passed)
    ? 0
    : 1;
}

interface CliFlags {
  monitor: boolean;
  json: boolean;
  tenant: string;
  graphPath: string | null;
  unredacted: boolean;
  /** Surfaces the underlying cause and its stack. Off by default. */
  debug: boolean;
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
    debug: false,
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
    } else if (arg === "--debug") {
      flags.debug = true;
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
  return ScenarioDifficulties.flatMap((difficulty) => [
    `  ${difficulty} derived: ${rates[difficulty].derived.label}`,
    `  ${difficulty} constructed: ${rates[difficulty].constructed.label}`,
  ]);
}

function formatFalsePositiveRows(rates: BenchSummary["falsePositiveRate"]): string[] {
  return ScenarioDifficulties.map((difficulty) => `  ${difficulty}: ${rates[difficulty].label}`);
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
