import { describe, expect, it } from "vitest";

import {
  GraphError,
  MemoryGraphStore,
  baselineGraph,
  buildGraph,
  createEdge,
  createNode,
  explain,
  trace,
  type ChunkNode,
  type GraphInput,
  type GraphNode,
  type RunAudit,
} from "../src/index.js";

const TENANT = "acme";
const AT = "2026-03-04T10:00:00.000Z";

function storeOf(graph: GraphInput = baselineGraph()): MemoryGraphStore {
  return new MemoryGraphStore(graph);
}

function idOf(store: MemoryGraphStore, kind: GraphNode["kind"]): string {
  const node = store.nodes(TENANT, kind)[0];
  if (node === undefined) {
    throw new Error(`no ${kind} node`);
  }
  return node.id;
}

describe("trace", () => {
  it("reaches the source a grounded claim rests on", () => {
    const store = storeOf();
    const result = trace(store, TENANT, idOf(store, "Claim"));

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.uri).toBe("https://vendor.test/report");
  });

  it("walks claim to chunk to artifact to source", () => {
    const store = storeOf();
    const result = trace(store, TENANT, idOf(store, "Claim"));
    const kinds = (result.paths[0]?.nodes ?? []).map(
      (id) => store.node(TENANT, id)?.kind ?? "missing",
    );

    expect(kinds[0]).toBe("Claim");
    expect(kinds).toContain("Chunk");
    expect(kinds).toContain("Artifact");
    expect(kinds).toContain("Source");
  });

  it("traces an output through its claims", () => {
    const store = storeOf();
    const result = trace(store, TENANT, idOf(store, "Output"));
    const kinds = new Set(
      result.paths.flatMap((path) => path.nodes.map((id) => store.node(TENANT, id)?.kind)),
    );

    expect(kinds.has("Claim")).toBe(true);
    expect(kinds.has("Source")).toBe(true);
  });

  it("does not follow SUPPORTED_BY backwards into a forward path", () => {
    // Tracing a chunk must not walk out to the claims that cited it: that
    // direction is "what rested on this", and returning it here would read as
    // provenance for the chunk.
    const store = storeOf();
    const result = trace(store, TENANT, idOf(store, "Chunk"));
    const kinds = new Set(
      result.paths.flatMap((path) => path.nodes.map((id) => store.node(TENANT, id)?.kind)),
    );

    expect(kinds.has("Claim")).toBe(false);
  });

  it("returns a single-node path for a claim that rests on nothing", () => {
    const graph = baselineGraph();
    const store = storeOf({
      nodes: graph.nodes,
      edges: graph.edges.filter((edge) => edge.type !== "SUPPORTED_BY"),
    });

    const result = trace(store, TENANT, idOf(store, "Claim"));

    expect(result.paths).toEqual([{ nodes: [idOf(store, "Claim")], edges: [] }]);
    expect(result.sources).toEqual([]);
  });

  it("still traces to a chunk the guard refused, so the refusal is inspectable", () => {
    const graph = baselineGraph();
    const store = storeOf({
      nodes: graph.nodes.map((node) =>
        node.kind === "Chunk" ? ({ ...node, admitted: false } as GraphNode) : node,
      ),
      edges: graph.edges,
    });

    const result = trace(store, TENANT, idOf(store, "Claim"));
    const chunk = result.paths
      .flatMap((path) => path.nodes)
      .map((id) => store.node(TENANT, id))
      .find((node): node is ChunkNode => node?.kind === "Chunk");

    expect(chunk?.admitted).toBe(false);
  });

  it("throws a typed error for an unknown target", () => {
    expect(() => trace(storeOf(), TENANT, `pg:${TENANT}:Claim:${"0".repeat(32)}`)).toThrow(
      GraphError,
    );
  });

  it("will not read across a tenant boundary", () => {
    const store = storeOf();

    expect(() => trace(store, "globex", idOf(store, "Claim"))).toThrow(GraphError);
  });
});

describe("determinism", () => {
  it("returns identical paths regardless of store insertion order", () => {
    const graph = baselineGraph();
    const forward = storeOf(graph);
    const reversed = storeOf({
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });

    expect(trace(reversed, TENANT, idOf(reversed, "Claim")).paths).toEqual(
      trace(forward, TENANT, idOf(forward, "Claim")).paths,
    );
  });
});

describe("termination and bounds", () => {
  it("terminates on a graph containing a cycle", () => {
    // validateGraph forbids cycles, but trace has to survive an unvalidated
    // graph — that is exactly when someone reaches for it.
    const graph = baselineGraph();
    const artifact = graph.nodes.find((node) => node.kind === "Artifact") as GraphNode;
    const store = storeOf({
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

    expect(() => trace(store, TENANT, idOf(store, "Claim"))).not.toThrow();
  });

  it("reports truncation instead of silently dropping paths", () => {
    const store = storeOf();
    const result = trace(store, TENANT, idOf(store, "Output"), { maxPaths: 1 });

    expect(result.truncated).toBe(true);
  });

  it("does not report truncation when the walk completed", () => {
    const store = storeOf();

    expect(trace(store, TENANT, idOf(store, "Claim")).truncated).toBe(false);
  });

  it("reports truncation when depth is exceeded", () => {
    const store = storeOf();

    expect(trace(store, TENANT, idOf(store, "Claim"), { maxDepth: 1 }).truncated).toBe(true);
  });
});

describe("explain", () => {
  it("returns the exact policy version node, not just a name", () => {
    const store = storeOf();
    const result = explain(store, TENANT, idOf(store, "Claim"));

    expect(result.policy?.kind).toBe("Policy");
    expect(result.policy?.version).toBe("1");
    expect(result.policy?.contentHash).toBe("sha256:policy-1");
  });

  it("reports the verdict, method and reason codes as recorded", () => {
    const store = storeOf();
    const result = explain(store, TENANT, idOf(store, "Claim"));

    expect(result.verdict?.decision).toBe("allow");
    expect(result.method).toBe("deterministic");
    expect(result.reasonCodes).toEqual([]);
  });

  it("returns nulls rather than fabricating a decision that was never recorded", () => {
    const store = storeOf();
    const result = explain(store, TENANT, idOf(store, "Artifact"));

    expect(result.verdict).toBeNull();
    expect(result.policy).toBeNull();
    expect(result.method).toBeNull();
    expect(result.monitored).toBeNull();
  });

  it("emits no generated prose field", () => {
    // The spec requires explanations to be recorded facts. A summary string
    // assembled here would be indistinguishable downstream from model output.
    const store = storeOf();
    const result = explain(store, TENANT, idOf(store, "Claim"));

    expect(Object.keys(result).sort()).toEqual([
      "decisionPaths",
      "method",
      "monitored",
      "policy",
      "reasonCodes",
      "sources",
      "target",
      "verdict",
    ]);
  });

  it("keeps a monitored block visible as a block", () => {
    const audit: RunAudit = {
      tenantId: TENANT,
      runKey: "run-1",
      startedAt: AT,
      observedAt: AT,
      policy: { name: "default", version: "1", contentHash: "sha256:p", mode: "monitor" },
      chunks: [],
      output: { text: "A fabricated paragraph.", delivered: true },
      claims: [
        {
          claim: { id: "c", text: "A fabricated paragraph.", spanStart: 0, spanEnd: 23 },
          grounding: {
            claimId: "c",
            status: "ungrounded",
            supportingChunkIds: [],
            method: "exact",
            score: 0,
          },
          material: true,
          reasonCodes: ["CLAIM_UNGROUNDED"],
        },
      ],
    };

    const store = new MemoryGraphStore(buildGraph(audit));
    const result = explain(store, TENANT, idOf(store, "Claim"));

    expect(result.verdict?.decision).toBe("block");
    expect(result.monitored).toBe(true);
    expect(result.reasonCodes).toEqual(["CLAIM_UNGROUNDED"]);
  });

  it("records a judge-decided verdict as judge", () => {
    const store = storeOf();
    const claimId = idOf(store, "Claim");
    const policyId = idOf(store, "Policy");
    const judged = createNode({
      kind: "Verdict",
      tenantId: TENANT,
      observedAt: AT,
      runId: idOf(store, "Run"),
      targetRef: claimId,
      policyRef: policyId,
      decision: "allow",
      reasonCodes: [],
      method: "judge",
      monitored: false,
      decidedAt: AT,
      inputHash: "sha256:judge",
    });

    const graph = baselineGraph();
    const withJudge = new MemoryGraphStore({
      nodes: [...graph.nodes.filter((node) => node.kind !== "Verdict"), judged],
      edges: [
        ...graph.edges.filter((edge) => edge.type !== "DECIDES"),
        createEdge({
          tenantId: TENANT,
          type: "DECIDES",
          from: judged.id,
          to: claimId,
          observedAt: AT,
        }),
      ],
    });

    expect(explain(withJudge, TENANT, claimId).method).toBe("judge");
  });

  it("returns only minimal-length decision paths", () => {
    const store = storeOf();
    const result = explain(store, TENANT, idOf(store, "Output"));
    const lengths = new Set(result.decisionPaths.map((path) => path.nodes.length));

    expect(lengths.size).toBeLessThanOrEqual(1);
  });
});
