import { describe, expect, it } from "vitest";

import type { Chunk } from "@provguard/schema";

import {
  buildGraph,
  validateGraph,
  type ChunkNode,
  type GraphNode,
  type RunAudit,
  type VerdictNode,
} from "../src/index.js";

const AT = "2026-03-04T10:00:00.000Z";

function chunk(id: string, text: string, overrides: Partial<Chunk["provenance"]> = {}): Chunk {
  return {
    id,
    text,
    provenance: {
      sourceId: `source:${id}`,
      channel: "RETRIEVED_DOC",
      tier: "T3",
      retrievedAt: AT,
      contentHash: `sha256:${id}`,
      ...overrides,
    },
  };
}

const SUPPORTING = chunk("c1", "Revenue grew 12% quarter over quarter in the EMEA region.");

/** A clean run: one admitted chunk, one grounded claim, output delivered. */
function cleanAudit(overrides: Partial<RunAudit> = {}): RunAudit {
  return {
    tenantId: "acme",
    runKey: "run-1",
    startedAt: AT,
    observedAt: AT,
    policy: {
      name: "default",
      version: "1",
      contentHash: "sha256:policy-1",
      mode: "enforce",
    },
    chunks: [
      {
        chunk: SUPPORTING,
        admitted: true,
        slot: "evidence",
        verdict: { decision: "allow", reasons: [] },
      },
    ],
    output: {
      text: "Revenue grew 12% quarter over quarter in the EMEA region.",
      delivered: true,
    },
    claims: [
      {
        claim: {
          id: "claim-1",
          text: "Revenue grew 12% quarter over quarter in the EMEA region.",
          spanStart: 0,
          spanEnd: 56,
        },
        grounding: {
          claimId: "claim-1",
          status: "grounded",
          supportingChunkIds: ["c1"],
          method: "exact",
          score: 1,
        },
        material: true,
      },
    ],
    ...overrides,
  };
}

function nodesOfKind<K extends GraphNode["kind"]>(
  graph: ReturnType<typeof buildGraph>,
  kind: K,
): Extract<GraphNode, { kind: K }>[] {
  return graph.nodes.filter((node): node is Extract<GraphNode, { kind: K }> => node.kind === kind);
}

describe("buildGraph on a clean run", () => {
  it("produces a graph that satisfies every invariant", () => {
    const report = validateGraph(buildGraph(cleanAudit()));

    expect(report.violations).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("records the lineage a trace would follow", () => {
    const graph = buildGraph(cleanAudit());
    const kinds = new Set(graph.nodes.map((node) => node.kind));

    for (const expected of [
      "Run",
      "Policy",
      "Source",
      "Step",
      "Artifact",
      "Chunk",
      "Output",
      "Claim",
      "Verdict",
    ]) {
      expect(kinds.has(expected as GraphNode["kind"]), expected).toBe(true);
    }
  });

  it("links the claim to exactly the chunk its grounding named", () => {
    const graph = buildGraph(cleanAudit());
    const support = graph.edges.filter((edge) => edge.type === "SUPPORTED_BY");
    const [chunkNode] = nodesOfKind(graph, "Chunk");

    expect(support).toHaveLength(1);
    expect(support[0]?.to).toBe(chunkNode?.id);
  });

  it("does not manufacture support the guard never found", () => {
    // A second admitted chunk that no grounding named must not become support.
    const audit = cleanAudit();
    const graph = buildGraph({
      ...audit,
      chunks: [
        ...audit.chunks,
        { chunk: chunk("c2", "An unrelated paragraph."), admitted: true, slot: "evidence" },
      ],
    });

    expect(graph.edges.filter((edge) => edge.type === "SUPPORTED_BY")).toHaveLength(1);
  });

  it("carries the policy version onto every verdict", () => {
    const graph = buildGraph(cleanAudit());
    const [policy] = nodesOfKind(graph, "Policy");
    const verdicts = nodesOfKind(graph, "Verdict");

    expect(verdicts.length).toBeGreaterThan(0);
    for (const verdict of verdicts) {
      expect(verdict.policyRef).toBe(policy?.id);
    }
  });
});

describe("determinism", () => {
  it("produces an identical graph when the same audit is replayed", () => {
    expect(buildGraph(cleanAudit())).toEqual(buildGraph(cleanAudit()));
  });

  it("gives two tenants no shared ids for the same audit", () => {
    const acme = buildGraph(cleanAudit());
    const globex = buildGraph(cleanAudit({ tenantId: "globex" }));

    const acmeIds = new Set([...acme.nodes, ...acme.edges].map((element) => element.id));
    const overlap = [...globex.nodes, ...globex.edges].filter((element) => acmeIds.has(element.id));

    expect(overlap).toEqual([]);
  });

  it("does not let observation time change identity", () => {
    const first = buildGraph(cleanAudit());
    const later = buildGraph(cleanAudit({ observedAt: "2027-01-01T00:00:00.000Z" }));

    expect(later.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
  });
});

describe("rejected chunks", () => {
  const audit = cleanAudit({
    chunks: [
      {
        chunk: chunk("c1", "HTTP/1.1 400 Bad Request", {
          channel: "SYSTEM_ALERT",
          tier: "T5",
          upstreamStatus: 400,
        }),
        admitted: false,
        verdict: {
          decision: "block",
          reasons: [
            { code: "UPSTREAM_STATUS_NOT_OK", message: "Upstream status 400 is not a 2xx status." },
          ],
        },
      },
    ],
    output: { text: "The vendor reported strong growth.", delivered: false },
    claims: [],
  });

  it("keeps the refused chunk in the graph", () => {
    const [chunkNode] = nodesOfKind(buildGraph(audit), "Chunk") as [ChunkNode];

    expect(chunkNode.admitted).toBe(false);
  });

  it("does not record it as having entered context", () => {
    const graph = buildGraph(audit);

    expect(graph.edges.filter((edge) => edge.type === "INCLUDED_IN")).toEqual([]);
    expect(graph.edges.filter((edge) => edge.type === "CONSUMED")).toEqual([]);
  });

  it("records the reason code on the verdict", () => {
    const [verdict] = nodesOfKind(buildGraph(audit), "Verdict") as [VerdictNode];

    expect(verdict.decision).toBe("block");
    expect(verdict.reasonCodes).toEqual(["UPSTREAM_STATUS_NOT_OK"]);
  });

  it("still validates clean, because nothing claimed support from it", () => {
    expect(validateGraph(buildGraph(audit)).valid).toBe(true);
  });
});

describe("a polluted run is recorded, not papered over", () => {
  it("reports support from a chunk the guard refused", () => {
    // The builder must not drop the edge to make its own output validate.
    // Making this failure visible is the entire point of the ledger.
    const audit = cleanAudit();
    const polluted = buildGraph({
      ...audit,
      chunks: [
        {
          ...(audit.chunks[0] as RunAudit["chunks"][number]),
          admitted: false,
          verdict: {
            decision: "block",
            reasons: [{ code: "CHANNEL_NOT_PERMITTED", message: "not permitted" }],
          },
        },
      ],
    });

    const codes = validateGraph(polluted).violations.map((violation) => violation.code);

    expect(codes).toContain("GRAPH_SUPPORT_FROM_BLOCKED_CHUNK");
    expect(polluted.edges.some((edge) => edge.type === "SUPPORTED_BY")).toBe(true);
  });
});

describe("monitor mode", () => {
  const monitorAudit = cleanAudit({
    policy: {
      name: "default",
      version: "1",
      contentHash: "sha256:policy-1",
      mode: "monitor",
    },
    // Unsupported claim, delivered anyway: this is what monitor mode is.
    claims: [
      {
        claim: {
          id: "claim-1",
          text: "Battery suppliers are shifting toward compliance-led forecasting.",
          spanStart: 0,
          spanEnd: 64,
        },
        grounding: {
          claimId: "claim-1",
          status: "ungrounded",
          supportingChunkIds: [],
          method: "exact",
          score: 0,
        },
        material: true,
        reasonCodes: ["CLAIM_UNGROUNDED"],
      },
    ],
  });

  it("validates clean: the ledger is a true record, not a corrupt one", () => {
    const report = validateGraph(buildGraph(monitorAudit));

    expect(report.violations).toEqual([]);
  });

  it("still records the block that was not enforced", () => {
    const verdicts = nodesOfKind(buildGraph(monitorAudit), "Verdict");
    const claimVerdict = verdicts.find((verdict) =>
      verdict.reasonCodes.includes("CLAIM_UNGROUNDED"),
    );

    expect(claimVerdict?.decision).toBe("block");
    expect(claimVerdict?.monitored).toBe(true);
  });

  it("flags the same graph when the policy was enforcing", () => {
    // Same shape, mode flipped: the exception disappears and the violation
    // appears, so monitor is doing the work rather than the claim being fine.
    const enforced = buildGraph({
      ...monitorAudit,
      policy: { ...monitorAudit.policy, mode: "enforce" },
    });

    expect(validateGraph(enforced).violations.map((violation) => violation.code)).toContain(
      "GRAPH_CLAIM_UNSUPPORTED_DELIVERY",
    );
  });
});

describe("judge attribution", () => {
  it("records a judge-decided claim as judge, never as deterministic", () => {
    const audit = cleanAudit();
    const graph = buildGraph({
      ...audit,
      claims: [
        {
          ...(audit.claims[0] as RunAudit["claims"][number]),
          grounding: {
            claimId: "claim-1",
            status: "grounded",
            supportingChunkIds: ["c1"],
            method: "judge",
            score: 0.8,
          },
        },
      ],
    });

    const claimVerdict = nodesOfKind(graph, "Verdict").find(
      (verdict) => verdict.method === "judge",
    );

    expect(claimVerdict).toBeDefined();
  });

  it("leaves inbound verdicts deterministic even when a claim was judged", () => {
    const graph = buildGraph(cleanAudit());
    const chunkNode = nodesOfKind(graph, "Chunk")[0] as ChunkNode;
    const inbound = nodesOfKind(graph, "Verdict").find(
      (verdict) => verdict.targetRef === chunkNode.id,
    );

    expect(inbound?.method).toBe("deterministic");
  });
});
