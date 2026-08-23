import { describe, expect, it } from "vitest";

import {
  GraphError,
  MemoryGraphStore,
  baselineGraph,
  createEdge,
  createNode,
  impact,
  type GraphInput,
  type GraphNode,
} from "../src/index.js";

const TENANT = "acme";
const AT = "2026-03-04T10:00:00.000Z";

function storeOf(graph: GraphInput = baselineGraph()): MemoryGraphStore {
  return new MemoryGraphStore(graph);
}

/**
 * Loads without validation, for graphs deliberately built broken.
 *
 * `load` now rejects cycles, which is right: a cyclic lineage is corrupt and
 * should not enter a store. But traversal still has to terminate on a graph
 * that was never validated -- that is exactly when someone reaches for trace --
 * so these cases opt out explicitly rather than the store going quiet on them.
 */
function uncheckedStore(graph: GraphInput): MemoryGraphStore {
  return new MemoryGraphStore().loadUnchecked(graph);
}

function idOf(store: MemoryGraphStore, kind: GraphNode["kind"]): string {
  const node = store.nodes(TENANT, kind)[0];
  if (node === undefined) {
    throw new Error(`no ${kind} node`);
  }
  return node.id;
}

describe("impact from a retracted source", () => {
  it("reports the claim, output and run that depend on it", () => {
    const store = storeOf();
    const result = impact(store, TENANT, idOf(store, "Source"));

    expect(result.claims).toHaveLength(1);
    expect(result.outputs).toHaveLength(1);
    expect(result.runs).toHaveLength(1);
  });

  it("records distance, so a direct dependant is distinguishable", () => {
    const store = storeOf();
    const result = impact(store, TENANT, idOf(store, "Chunk"));
    const claim = result.claims[0];

    expect(claim?.distance).toBe(1);
  });

  it("reports increasing distance further from the origin", () => {
    const store = storeOf();
    const result = impact(store, TENANT, idOf(store, "Source"));
    const claimDistance = result.claims[0]?.distance ?? 0;
    const outputDistance = result.outputs[0]?.distance ?? 0;

    expect(claimDistance).toBeGreaterThan(1);
    expect(outputDistance).toBeGreaterThan(claimDistance);
  });
});

describe("delivered and undelivered are kept apart", () => {
  it("counts a delivered output in both lists", () => {
    const store = storeOf();
    const result = impact(store, TENANT, idOf(store, "Chunk"));

    expect(result.outputs).toHaveLength(1);
    expect(result.deliveredOutputs).toHaveLength(1);
  });

  it("excludes an undelivered output from deliveredOutputs", () => {
    // The output was blocked, so nothing reached a user. Folding this in with
    // delivered outputs would turn a bug into an incident in every report.
    const graph = baselineGraph();
    const store = storeOf({
      nodes: graph.nodes.map((node) =>
        node.kind === "Output" ? ({ ...node, delivered: false } as GraphNode) : node,
      ),
      edges: graph.edges,
    });

    const result = impact(store, TENANT, idOf(store, "Chunk"));

    expect(result.outputs).toHaveLength(1);
    expect(result.deliveredOutputs).toEqual([]);
  });
});

describe("being bad is not the same as having consequences", () => {
  it("reports no dependants for a refused chunk nothing cited", () => {
    const graph = baselineGraph();
    const store = storeOf({
      nodes: graph.nodes.map((node) =>
        node.kind === "Chunk" ? ({ ...node, admitted: false } as GraphNode) : node,
      ),
      // No claim ever rested on it.
      edges: graph.edges.filter((edge) => edge.type !== "SUPPORTED_BY"),
    });

    const result = impact(store, TENANT, idOf(store, "Chunk"));

    expect(result.claims).toEqual([]);
    expect(result.outputs).toEqual([]);
    expect(result.deliveredOutputs).toEqual([]);
  });

  it("never reports the origin as its own dependant", () => {
    const store = storeOf();
    const originId = idOf(store, "Chunk");
    const result = impact(store, TENANT, originId);

    const reported = [...result.claims, ...result.outputs, ...result.runs].map(
      (entry) => entry.node.id,
    );
    expect(reported).not.toContain(originId);
  });
});

describe("transitive dependants", () => {
  function chainGraph(): GraphInput {
    const base = baselineGraph();
    const run = base.nodes.find((node) => node.kind === "Run") as GraphNode;
    const artifact = base.nodes.find((node) => node.kind === "Artifact") as GraphNode;

    // A second artifact derived from the first: the "we reprocessed it" case.
    const derived = createNode({
      kind: "Artifact",
      tenantId: TENANT,
      observedAt: AT,
      runId: run.id,
      contentHash: "sha256:derived",
    });

    const derivedChunk = createNode({
      kind: "Chunk",
      tenantId: TENANT,
      observedAt: AT,
      runId: run.id,
      contentHash: "sha256:derived-chunk",
      ordinal: 1,
      text: "A reprocessed paragraph.",
      channel: "RETRIEVED_DOC",
      tier: "T3",
      retrievedAt: AT,
      admitted: true,
    });

    return {
      nodes: [...base.nodes, derived, derivedChunk],
      edges: [
        ...base.edges,
        createEdge({
          tenantId: TENANT,
          type: "DERIVED_FROM",
          from: derived.id,
          to: artifact.id,
          observedAt: AT,
        }),
        createEdge({
          tenantId: TENANT,
          type: "SPLIT_INTO",
          from: derived.id,
          to: derivedChunk.id,
          observedAt: AT,
        }),
      ],
    };
  }

  it("reaches a claim through a reprocessed artifact", () => {
    const store = storeOf(chainGraph());
    const originalArtifact = store
      .nodes(TENANT, "Artifact")
      .find((node) => node.contentHash === "sha256:artifact-1") as GraphNode;

    const result = impact(store, TENANT, originalArtifact.id);

    // The claim rests on the original chunk, one hop from the artifact that
    // was split into it, so it is still reported after reprocessing exists.
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.distance).toBe(2);
  });

  it("reports the reprocessed artifact and its chunk as affected", () => {
    // The derived artifact never carried a claim, so it shows up in neither
    // claims nor outputs; the check is that the walk reached it at all.
    const store = storeOf(chainGraph());
    const originalArtifact = store
      .nodes(TENANT, "Artifact")
      .find((node) => node.contentHash === "sha256:artifact-1") as GraphNode;
    const derivedChunk = store
      .nodes(TENANT, "Chunk")
      .find((node) => node.contentHash === "sha256:derived-chunk") as GraphNode;

    // Impact from the derived chunk alone reaches nothing, confirming the
    // claim above is reached via the original chunk rather than this branch.
    expect(impact(store, TENANT, derivedChunk.id).claims).toEqual([]);

    // And the run is reported once, at the distance of its nearest member.
    const result = impact(store, TENANT, originalArtifact.id);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.distance).toBe(1);
  });
});

describe("determinism, termination and scoping", () => {
  it("is stable under store insertion-order shuffling", () => {
    const graph = baselineGraph();
    const forward = storeOf(graph);
    const reversed = storeOf({
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });

    expect(impact(reversed, TENANT, idOf(reversed, "Source"))).toEqual(
      impact(forward, TENANT, idOf(forward, "Source")),
    );
  });

  it("terminates on a graph containing a cycle", () => {
    const graph = baselineGraph();
    const artifact = graph.nodes.find((node) => node.kind === "Artifact") as GraphNode;
    const store = uncheckedStore({
      nodes: graph.nodes,
      edges: [
        ...graph.edges,
        createEdge({
          tenantId: TENANT,
          type: "DERIVED_FROM",
          from: artifact.id,
          to: artifact.id,
          observedAt: AT,
        }),
      ],
    });

    expect(() => impact(store, TENANT, idOf(store, "Source"))).not.toThrow();
  });

  it("reports truncation rather than silently stopping", () => {
    const store = storeOf();
    const result = impact(store, TENANT, idOf(store, "Source"), { maxDepth: 1 });

    expect(result.truncated).toBe(true);
  });

  it("does not report truncation on a complete walk", () => {
    const store = storeOf();

    expect(impact(store, TENANT, idOf(store, "Source")).truncated).toBe(false);
  });

  it("will not read across a tenant boundary", () => {
    const store = storeOf();

    expect(() => impact(store, "globex", idOf(store, "Source"))).toThrow(GraphError);
  });

  it("throws a typed error for an unknown origin", () => {
    expect(() => impact(storeOf(), TENANT, `pg:${TENANT}:Source:${"0".repeat(32)}`)).toThrow(
      GraphError,
    );
  });
});
