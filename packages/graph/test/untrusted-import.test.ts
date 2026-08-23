import { describe, expect, it } from "vitest";

import {
  GraphError,
  MemoryGraphStore,
  baselineGraph,
  createEdge,
  createNode,
  fromCanonicalJSON,
  graphFixtures,
  toCanonicalJSON,
  type GraphInput,
  type GraphNode,
} from "../src/index.js";

const TENANT = "acme";
const AT = "2026-03-04T10:00:00.000Z";

/**
 * A graph document arriving from disk, an API, or another tenant's export is
 * untrusted input. These tests treat it that way.
 *
 * Note on terminology: the remediation brief asked for "tenant and matter-scope"
 * validation. This codebase has no `matter` concept — its scope concepts are
 * `tenant` and `run` — so both of those are covered below and the mismatch is
 * recorded rather than papered over by inventing an entity.
 */
function loading(graph: GraphInput): () => MemoryGraphStore {
  return () => new MemoryGraphStore(graph);
}

/** Asserts the load throws with a specific typed code, not merely some error. */
function expectRejected(build: () => MemoryGraphStore, code: string): void {
  try {
    build();
    throw new Error(`expected a ${code} rejection, but the load succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(GraphError);
    expect((error as GraphError).code).toBe(code);
  }
}

/** The store as it was before a rejected load, for atomicity checks. */
function snapshotOf(store: MemoryGraphStore): string {
  return toCanonicalJSON(store.snapshot(TENANT), { redact: false });
}

describe("forged ownership", () => {
  it("refuses a node whose id encodes a different tenant than it claims", () => {
    // The attack the audit found: the store filtered reads on a tenantId field
    // that the document itself supplies, so relabelling a node handed it over.
    const legitimate = createNode({
      kind: "Run",
      tenantId: TENANT,
      observedAt: AT,
      runKey: "r",
      startedAt: AT,
    });
    const forged = { ...legitimate, tenantId: "globex" } as GraphNode;

    expect(loading({ nodes: [forged], edges: [] })).toThrow(GraphError);
  });

  it("does not serve the forged node to the tenant it names", () => {
    const legitimate = createNode({
      kind: "Run",
      tenantId: TENANT,
      observedAt: AT,
      runKey: "r",
      startedAt: AT,
    });
    const forged = { ...legitimate, tenantId: "globex" } as GraphNode;

    let store: MemoryGraphStore | undefined;
    try {
      store = new MemoryGraphStore({ nodes: [forged], edges: [] });
    } catch {
      store = undefined;
    }

    expect(store).toBeUndefined();
  });

  it("refuses an edge that crosses a run boundary a run-local type forbids", () => {
    const base = baselineGraph();
    const otherRun = createNode({
      kind: "Run",
      tenantId: TENANT,
      observedAt: AT,
      runKey: "run-2",
      startedAt: AT,
    });
    const otherChunk = createNode({
      kind: "Chunk",
      tenantId: TENANT,
      observedAt: AT,
      runId: otherRun.id,
      contentHash: "sha256:other",
      ordinal: 0,
      text: "Another run's chunk.",
      channel: "RETRIEVED_DOC",
      tier: "T3",
      retrievedAt: AT,
      admitted: true,
    });
    const claim = base.nodes.find((node) => node.kind === "Claim") as GraphNode;

    expectRejected(
      loading({
        nodes: [...base.nodes, otherRun, otherChunk],
        edges: [
          ...base.edges,
          createEdge({
            tenantId: TENANT,
            type: "SUPPORTED_BY",
            from: claim.id,
            to: otherChunk.id,
            observedAt: AT,
          }),
        ],
      }),
      "GRAPH_RUN_MISMATCH",
    );
  });
});

describe("structurally invalid documents", () => {
  it("refuses an invalid node", () => {
    expect(
      loading({ nodes: [{ kind: "Chunk", id: "nope" } as unknown as GraphNode], edges: [] }),
    ).toThrow(GraphError);
  });

  it("refuses an edge whose type does not permit its endpoints", () => {
    const base = baselineGraph();
    const chunk = base.nodes.find((node) => node.kind === "Chunk") as GraphNode;
    const claim = base.nodes.find((node) => node.kind === "Claim") as GraphNode;

    expect(
      loading({
        nodes: base.nodes,
        edges: [
          ...base.edges,
          createEdge({
            tenantId: TENANT,
            type: "SUPPORTED_BY",
            from: chunk.id,
            to: claim.id,
            observedAt: AT,
          }),
        ],
      }),
    ).toThrow(GraphError);
  });

  it("refuses a cycle", () => {
    const base = baselineGraph();
    const artifact = base.nodes.find((node) => node.kind === "Artifact") as GraphNode;

    expectRejected(
      loading({
        nodes: base.nodes,
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
      }),
      "GRAPH_CYCLE_DETECTED",
    );
  });

  it("refuses a duplicate id", () => {
    const base = baselineGraph();
    const chunk = base.nodes.find((node) => node.kind === "Chunk") as GraphNode;

    expect(
      loading({
        nodes: [...base.nodes, { ...chunk, text: "different body" } as GraphNode],
        edges: base.edges,
      }),
    ).toThrow(GraphError);
  });

  it("refuses a tampered node whose id no longer derives from its fields", () => {
    const base = baselineGraph();

    expect(
      loading({
        nodes: base.nodes.map((node) =>
          node.kind === "Chunk"
            ? ({ ...node, contentHash: "sha256:rewritten" } as GraphNode)
            : node,
        ),
        edges: base.edges,
      }),
    ).toThrow(GraphError);
  });
});

describe("atomicity", () => {
  it("leaves an existing store untouched when a later load is rejected", () => {
    const store = new MemoryGraphStore(baselineGraph());
    const before = snapshotOf(store);

    const newcomer = createNode({
      kind: "Policy",
      tenantId: TENANT,
      observedAt: AT,
      name: "probe",
      version: "1",
      contentHash: "sha256:probe",
      mode: "enforce",
    });

    // A valid element ahead of an invalid one: a non-atomic load would write
    // the first and leave the store changed.
    expect(() =>
      store.load({
        nodes: [newcomer, { kind: "Wormhole", id: "x" } as unknown as GraphNode],
        edges: [],
      }),
    ).toThrow(GraphError);

    expect(snapshotOf(store)).toBe(before);
  });

  it("writes nothing at all when the very first load is rejected", () => {
    const store = new MemoryGraphStore();

    expect(() =>
      store.load({ nodes: [{ kind: "Chunk", id: "nope" } as unknown as GraphNode], edges: [] }),
    ).toThrow(GraphError);

    expect(store.size).toEqual({ nodes: 0, edges: 0 });
  });
});

describe("what must still load", () => {
  it("accepts a graph that fails a semantic invariant", () => {
    // Storage is not a validator. A graph recording that a claim rested on a
    // refused chunk is a true record of a real defect, and refusing to store it
    // would make the defect unexaminable.
    const blocked = graphFixtures().find((fixture) => fixture.id === "support-from-blocked-chunk");
    if (blocked === undefined) {
      throw new Error("fixture missing");
    }

    expect(loading(blocked.graph)).not.toThrow();
  });

  it("accepts an unsupported delivered claim", () => {
    const fixture = graphFixtures().find(
      (candidate) => candidate.id === "unsupported-delivered-claim",
    );
    if (fixture === undefined) {
      throw new Error("fixture missing");
    }

    expect(loading(fixture.graph)).not.toThrow();
  });

  it("round-trips a valid document through canonical JSON", () => {
    const restored = fromCanonicalJSON(toCanonicalJSON(baselineGraph(), { redact: false }));

    expect(loading(restored)).not.toThrow();
  });

  it("still allows a deliberately broken graph through the explicit opt-out", () => {
    const base = baselineGraph();
    const artifact = base.nodes.find((node) => node.kind === "Artifact") as GraphNode;
    const cyclic = {
      nodes: base.nodes,
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

    expect(() => new MemoryGraphStore().loadUnchecked(cyclic)).not.toThrow();
  });
});
