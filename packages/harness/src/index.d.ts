import type { Chunk } from "@provguard/schema";

export type ScenarioExpectation = "should_block" | "should_allow";

export interface Scenario {
  id: string;
  name: string;
  mechanism: string;
  description: string;
  chunks: Chunk[];
  simulatedOutput: string;
  expectation: ScenarioExpectation;
}

export interface GuardDecision {
  blocked: boolean;
  ruleId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ChunkGuardContext {
  scenarioId: string;
  scenario: Scenario;
  phase: "chunks";
}

export interface OutputGuardContext {
  scenarioId: string;
  scenario: Scenario;
  chunks: Chunk[];
  phase: "output";
  chunkDecisions: GuardDecision[];
}

export interface HarnessGuards {
  checkChunks(
    chunks: Chunk[],
    context: ChunkGuardContext
  ): GuardDecision | GuardDecision[] | Promise<GuardDecision | GuardDecision[]>;
  checkOutput(
    output: string,
    context: OutputGuardContext
  ): GuardDecision | GuardDecision[] | Promise<GuardDecision | GuardDecision[]>;
}

export interface ScenarioRunResult {
  scenarioId: string;
  scenarioName: string;
  expectation: ScenarioExpectation;
  chunks: Chunk[];
  simulatedOutput: string;
  decisions: Array<{
    phase: "chunks" | "output";
    decisions: GuardDecision[];
  }>;
  blocked: boolean;
  passed: boolean;
}

export const SCENARIOS: readonly Scenario[];

export function listScenarios(): Scenario[];

export function getScenario(id: string): Scenario | undefined;

export function runScenario(
  scenario: Scenario,
  guards: HarnessGuards
): Promise<ScenarioRunResult>;
