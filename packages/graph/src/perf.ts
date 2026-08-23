import { createEdge } from "./edges.js";
import { impact } from "./impact.js";
import { createNode, type GraphNode } from "./nodes.js";
import { fromCanonicalJSON, toCanonicalJSON } from "./serialize.js";
import { MemoryGraphStore } from "./store.js";
import { trace } from "./trace.js";
import { validateGraph, type GraphInput } from "./validate.js";

export interface PerfFixture {
  readonly name: string;
  readonly chunks: number;
  readonly depth: number;
  readonly graph: GraphInput;
  readonly nodes: number;
  readonly edges: number;
}

export interface PerfMeasurement {
  readonly operation: string;
  readonly fixture: string;
  readonly iterations: number;
  readonly medianMs: number;
  readonly p95Ms: number;
}

export interface PerfReport {
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly cpus: number;
  };
  readonly fixtures: readonly { name: string; nodes: number; edges: number; depth: number }[];
  readonly measurements: readonly PerfMeasurement[];
}

const TENANT = "perf";
const AT = "2026-03-04T10:00:00.000Z";

/**
 * Builds a synthetic lineage of a declared size.
 *
 * Synthetic on purpose: a fixture whose size is a parameter is the only way to
 * say how cost scales, and a measurement whose fixture cannot be described is
 * not reportable. `chunks` controls breadth, `depth` the length of the
 * derivation chain a backward traversal must walk.
 */
export function perfFixture(chunks: number, depth: number): PerfFixture {
  const nodes: GraphNode[] = [];
  const edges = [];

  const run = createNode({
    kind: "Run",
    tenantId: TENANT,
    observedAt: AT,
    runKey: `perf-${chunks}-${depth}`,
    startedAt: AT,
  });
  nodes.push(run);

  const policy = createNode({
    kind: "Policy",
    tenantId: TENANT,
    observedAt: AT,
    name: "perf",
    version: "1",
    contentHash: "sha256:perf-policy",
    mode: "enforce",
  });
  nodes.push(policy);

  const step = createNode({
    kind: "Step",
    tenantId: TENANT,
    observedAt: AT,
    runId: run.id,
    index: 0,
    name: "retrieve",
    stepKind: "retrieve",
  });
  nodes.push(step);
  edges.push(edge("PRODUCED", run.id, step.id));

  const output = createNode({
    kind: "Output",
    tenantId: TENANT,
    observedAt: AT,
    runId: run.id,
    contentHash: "sha256:perf-output",
    text: "Synthetic output.",
    delivered: true,
  });
  nodes.push(output);
  edges.push(edge("PRODUCED", step.id, output.id));

  for (let index = 0; index < chunks; index += 1) {
    const source = createNode({
      kind: "Source",
      tenantId: TENANT,
      observedAt: AT,
      uri: `https://perf.test/doc-${index}`,
      sourceKind: "retrieval",
    });
    nodes.push(source);

    // A derivation chain of `depth` artifacts, so backward traversal has real
    // work to do rather than terminating in one hop.
    let previous: string | null = null;
    for (let level = 0; level < depth; level += 1) {
      const artifact = createNode({
        kind: "Artifact",
        tenantId: TENANT,
        observedAt: AT,
        runId: run.id,
        contentHash: `sha256:perf-${index}-${level}`,
      });
      nodes.push(artifact);

      if (previous === null) {
        edges.push(edge("PRODUCED", source.id, artifact.id));
      } else {
        edges.push(edge("DERIVED_FROM", artifact.id, previous));
      }
      previous = artifact.id;
    }

    const chunk = createNode({
      kind: "Chunk",
      tenantId: TENANT,
      observedAt: AT,
      runId: run.id,
      contentHash: `sha256:perf-chunk-${index}`,
      ordinal: index,
      text: `Synthetic chunk ${index}.`,
      channel: "RETRIEVED_DOC",
      tier: "T3",
      retrievedAt: AT,
      admitted: true,
    });
    nodes.push(chunk);
    edges.push(edge("SPLIT_INTO", previous as string, chunk.id));
    edges.push(edge("INCLUDED_IN", chunk.id, step.id));

    const claim = createNode({
      kind: "Claim",
      tenantId: TENANT,
      observedAt: AT,
      runId: run.id,
      outputRef: output.id,
      text: `Synthetic claim ${index}.`,
      spanStart: index,
      spanEnd: index + 1,
      material: true,
    });
    nodes.push(claim);
    edges.push(edge("EXTRACTED_FROM", claim.id, output.id));
    edges.push(edge("SUPPORTED_BY", claim.id, chunk.id));
    edges.push(edge("EVALUATED_BY", claim.id, policy.id));

    const verdict = createNode({
      kind: "Verdict",
      tenantId: TENANT,
      observedAt: AT,
      runId: run.id,
      targetRef: claim.id,
      policyRef: policy.id,
      decision: "allow",
      reasonCodes: [],
      method: "deterministic",
      monitored: false,
      decidedAt: AT,
      inputHash: `sha256:perf-input-${index}`,
    });
    nodes.push(verdict);
    edges.push(edge("DECIDES", verdict.id, claim.id));
  }

  const graph: GraphInput = { nodes, edges };
  return {
    name: `chunks=${chunks} depth=${depth}`,
    chunks,
    depth,
    graph,
    nodes: nodes.length,
    edges: edges.length,
  };
}

function edge(type: Parameters<typeof createEdge>[0]["type"], from: string, to: string) {
  return createEdge({ tenantId: TENANT, type, from, to, observedAt: AT });
}

/**
 * Measures the graph operations on declared fixtures.
 *
 * Reports median and p95 rather than a mean: a mean hides the tail, and the
 * tail is what a request-path component is judged on. Every number carries its
 * fixture and the environment it was produced on, because a performance figure
 * quoted without those is not a measurement, it is a rumour.
 */
export function measure(
  fixtures: readonly PerfFixture[],
  iterations: number,
  environment: PerfReport["environment"],
): PerfReport {
  const measurements: PerfMeasurement[] = [];

  for (const fixture of fixtures) {
    const serialized = toCanonicalJSON(fixture.graph, { redact: false });
    const store = new MemoryGraphStore(fixture.graph);
    const claim = fixture.graph.nodes.find((node) => node.kind === "Claim");
    const source = fixture.graph.nodes.find((node) => node.kind === "Source");

    const cases: { operation: string; run: () => void }[] = [
      { operation: "validate", run: () => void validateGraph(fixture.graph) },
      { operation: "serialize", run: () => void toCanonicalJSON(fixture.graph) },
      { operation: "deserialize", run: () => void fromCanonicalJSON(serialized) },
      { operation: "store.load", run: () => void new MemoryGraphStore(fixture.graph) },
    ];

    if (claim !== undefined) {
      cases.push({ operation: "trace", run: () => void trace(store, TENANT, claim.id) });
    }
    if (source !== undefined) {
      cases.push({ operation: "impact", run: () => void impact(store, TENANT, source.id) });
    }

    for (const testCase of cases) {
      const samples: number[] = [];
      // One untimed pass, so the first sample is not dominated by lazy
      // initialisation that a real deployment pays exactly once.
      testCase.run();

      for (let index = 0; index < iterations; index += 1) {
        const started = performance.now();
        testCase.run();
        samples.push(performance.now() - started);
      }

      samples.sort((left, right) => left - right);
      measurements.push({
        operation: testCase.operation,
        fixture: fixture.name,
        iterations,
        medianMs: round(percentile(samples, 0.5)),
        p95Ms: round(percentile(samples, 0.95)),
      });
    }
  }

  return {
    environment,
    fixtures: fixtures.map((fixture) => ({
      name: fixture.name,
      nodes: fixture.nodes,
      edges: fixture.edges,
      depth: fixture.depth,
    })),
    measurements,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] as number;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
