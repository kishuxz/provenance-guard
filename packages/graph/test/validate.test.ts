import { describe, expect, it } from "vitest";

import {
  GraphViolationCodes,
  baselineGraph,
  createEdge,
  createNode,
  graphFixtures,
  validateGraph,
  type GraphInput,
  type GraphNode,
} from "../src/index.js";

const TENANT = "acme";
const AT = "2026-03-04T10:00:00.000Z";

function codesOf(graph: GraphInput): string[] {
  return [...new Set(validateGraph(graph).violations.map((violation) => violation.code))].sort();
}

describe("validateGraph on the baseline", () => {
  it("reports nothing for a well-formed lineage", () => {
    const report = validateGraph(baselineGraph());

    expect(report.violations).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("accepts an empty graph", () => {
    expect(validateGraph({ nodes: [], edges: [] }).valid).toBe(true);
  });
});

describe("adversarial fixtures", () => {
  const fixtures = graphFixtures();

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    "%s produces exactly its expected codes",
    (_id, fixture) => {
      expect(codesOf(fixture.graph)).toEqual([...fixture.expectedCodes].sort());
    },
  );

  it("covers every violation code with at least one fixture", () => {
    const covered = new Set(fixtures.flatMap((fixture) => fixture.expectedCodes));

    expect([...covered].sort()).toEqual([...GraphViolationCodes].sort());
  });

  it("includes near misses that must stay silent", () => {
    const nearMisses = fixtures.filter((fixture) => fixture.id.startsWith("near-miss-"));

    expect(nearMisses.length).toBeGreaterThanOrEqual(5);
    for (const fixture of nearMisses) {
      expect(validateGraph(fixture.graph).violations, fixture.id).toEqual([]);
    }
  });
});

describe("determinism", () => {
  it("returns the same report regardless of input order", () => {
    const graph = graphFixtures().find((fixture) => fixture.id === "cycle-self-loop")?.graph;
    if (graph === undefined) {
      throw new Error("missing fixture");
    }

    const forward = validateGraph(graph);
    const reversed = validateGraph({
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });

    expect(reversed.violations).toEqual(forward.violations);
  });

  it("is stable across many shuffles of a graph with several violations", () => {
    const base = baselineGraph();
    const chunk = base.nodes.find((node) => node.kind === "Chunk") as GraphNode;
    const artifact = base.nodes.find((node) => node.kind === "Artifact") as GraphNode;

    const graph: GraphInput = {
      // Blocked chunk plus a self-derivation: two unrelated violations at once.
      nodes: base.nodes.map((node) =>
        node.id === chunk.id ? ({ ...node, admitted: false } as GraphNode) : node,
      ),
      edges: [
        ...base.edges,
        createEdge({
          tenantId: TENANT,
          type: "DERIVED_FROM",
          from: artifact.id,
          to: artifact.id,
          observedAt: AT,
        }),
      ],
    };

    const expected = validateGraph(graph).violations;
    expect(expected.length).toBeGreaterThan(1);

    for (let seed = 0; seed < 25; seed += 1) {
      const shuffled = validateGraph({
        nodes: rotate(graph.nodes, seed),
        edges: rotate(graph.edges, seed * 3 + 1),
      });

      expect(shuffled.violations, `seed ${seed}`).toEqual(expected);
    }
  });
});

describe("cycle detection", () => {
  it("terminates on a long acyclic chain without overflowing the stack", () => {
    const run = createNode({
      kind: "Run",
      tenantId: TENANT,
      observedAt: AT,
      runKey: "run-long",
      startedAt: AT,
    });

    const artifacts = Array.from({ length: 5000 }, (_unused, index) =>
      createNode({
        kind: "Artifact",
        tenantId: TENANT,
        observedAt: AT,
        runId: run.id,
        contentHash: `sha256:artifact-${index}`,
      }),
    );

    const edges = artifacts.slice(1).map((artifact, index) =>
      createEdge({
        tenantId: TENANT,
        type: "DERIVED_FROM",
        from: artifact.id,
        to: (artifacts[index] as GraphNode).id,
        observedAt: AT,
      }),
    );

    const report = validateGraph({ nodes: [run, ...artifacts], edges });

    expect(
      report.violations.filter((violation) => violation.code === "GRAPH_CYCLE_DETECTED"),
    ).toEqual([]);
  });

  it("detects a mutual cycle between two artifacts", () => {
    const base = baselineGraph();
    const run = base.nodes.find((node) => node.kind === "Run") as GraphNode;
    const [first, second] = [0, 1].map((index) =>
      createNode({
        kind: "Artifact",
        tenantId: TENANT,
        observedAt: AT,
        runId: run.id,
        contentHash: `sha256:mutual-${index}`,
      }),
    ) as [GraphNode, GraphNode];

    const report = validateGraph({
      nodes: [...base.nodes, first, second],
      edges: [
        ...base.edges,
        createEdge({
          tenantId: TENANT,
          type: "DERIVED_FROM",
          from: first.id,
          to: second.id,
          observedAt: AT,
        }),
        createEdge({
          tenantId: TENANT,
          type: "DERIVED_FROM",
          from: second.id,
          to: first.id,
          observedAt: AT,
        }),
      ],
    });

    expect(report.violations.map((violation) => violation.code)).toContain("GRAPH_CYCLE_DETECTED");
  });

  it("does not treat a diamond as a cycle", () => {
    // Two independent derivations that reconverge share nodes but form no loop.
    const base = baselineGraph();
    const run = base.nodes.find((node) => node.kind === "Run") as GraphNode;
    const [root, left, right] = [0, 1, 2].map((index) =>
      createNode({
        kind: "Artifact",
        tenantId: TENANT,
        observedAt: AT,
        runId: run.id,
        contentHash: `sha256:diamond-${index}`,
      }),
    ) as [GraphNode, GraphNode, GraphNode];

    const report = validateGraph({
      nodes: [...base.nodes, root, left, right],
      edges: [
        ...base.edges,
        ...(
          [
            [left, root],
            [right, root],
          ] as const
        ).map(([from, to]) =>
          createEdge({
            tenantId: TENANT,
            type: "DERIVED_FROM",
            from: from.id,
            to: to.id,
            observedAt: AT,
          }),
        ),
      ],
    });

    expect(report.valid).toBe(true);
  });
});

describe("totality", () => {
  it("reports every violation rather than the first", () => {
    const base = baselineGraph();
    const chunk = base.nodes.find((node) => node.kind === "Chunk") as GraphNode;
    const policy = base.nodes.find((node) => node.kind === "Policy") as GraphNode;

    const report = validateGraph({
      // Blocked chunk (support violation) and a missing policy (verdict
      // violation) at the same time.
      nodes: base.nodes
        .filter((node) => node.id !== policy.id)
        .map((node) => (node.id === chunk.id ? ({ ...node, admitted: false } as GraphNode) : node)),
      edges: base.edges,
    });

    const codes = new Set(report.violations.map((violation) => violation.code));

    expect(codes.has("GRAPH_SUPPORT_FROM_BLOCKED_CHUNK")).toBe(true);
    expect(codes.has("GRAPH_VERDICT_POLICY_MISSING")).toBe(true);
  });

  it("does not throw on structurally malformed input", () => {
    // A graph that arrived as JSON rather than through createNode.
    const junk = {
      nodes: [{ kind: "Chunk", id: "not-an-id" } as unknown as GraphNode],
      edges: [],
    };

    expect(() => validateGraph(junk)).not.toThrow();
    expect(codesOf(junk)).toContain("GRAPH_SCHEMA_INVALID");
  });
});

function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) {
    return [];
  }
  const offset = by % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}
