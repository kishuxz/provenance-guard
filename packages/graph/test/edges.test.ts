import { describe, expect, it } from "vitest";

import {
  ACYCLIC_EDGE_TYPES,
  EDGE_MATRIX,
  EdgeTypes,
  GraphError,
  NodeKinds,
  RUN_LOCAL_EDGE_TYPES,
  createEdge,
  expectedEdgeId,
  isAcyclicEdgeType,
  isEdgePairPermitted,
  isRunLocalEdgeType,
} from "../src/index.js";

const OBSERVED_AT = "2026-03-04T10:00:00.000Z";
const CLAIM = "pg:acme:Claim:" + "1".repeat(32);
const CHUNK = "pg:acme:Chunk:" + "2".repeat(32);

describe("EDGE_MATRIX", () => {
  it("covers every edge type", () => {
    expect(Object.keys(EDGE_MATRIX).sort()).toEqual([...EdgeTypes].sort());
  });

  it("rejects every (type, from, to) triple it does not explicitly permit", () => {
    // Walks the full cross product rather than sampling, so a permitted pair
    // added by accident to any type is caught.
    const permitted = new Set<string>();
    for (const type of EdgeTypes) {
      for (const [from, to] of EDGE_MATRIX[type]) {
        permitted.add(`${type}|${from}|${to}`);
      }
    }

    let checked = 0;
    for (const type of EdgeTypes) {
      for (const from of NodeKinds) {
        for (const to of NodeKinds) {
          checked += 1;
          expect(isEdgePairPermitted(type, from, to), `${type} ${from}->${to}`).toBe(
            permitted.has(`${type}|${from}|${to}`),
          );
        }
      }
    }

    expect(checked).toBe(EdgeTypes.length * NodeKinds.length * NodeKinds.length);
    expect(permitted.size).toBeLessThan(checked);
  });

  it("keeps SUPPORTED_BY pointing from claim to evidence only", () => {
    // The reverse direction would let "this chunk proves things" be read off a
    // traversal, which is connectivity mistaken for truth.
    expect(isEdgePairPermitted("SUPPORTED_BY", "Claim", "Chunk")).toBe(true);
    expect(isEdgePairPermitted("SUPPORTED_BY", "Chunk", "Claim")).toBe(false);
  });

  it("does not permit a claim to support itself through any edge type", () => {
    for (const type of EdgeTypes) {
      expect(isEdgePairPermitted(type, "Claim", "Claim"), type).toBe(false);
    }
  });

  it("only lets a verdict decide a subject, never the reverse", () => {
    expect(isEdgePairPermitted("DECIDES", "Verdict", "Claim")).toBe(true);
    expect(isEdgePairPermitted("DECIDES", "Claim", "Verdict")).toBe(false);
  });
});

describe("edge classification", () => {
  it("declares DERIVED_FROM and SPLIT_INTO acyclic", () => {
    expect([...ACYCLIC_EDGE_TYPES].sort()).toEqual(["DERIVED_FROM", "SPLIT_INTO"]);
    expect(isAcyclicEdgeType("DERIVED_FROM")).toBe(true);
    expect(isAcyclicEdgeType("SUPPORTED_BY")).toBe(false);
  });

  it("leaves DERIVED_FROM free to cross runs", () => {
    // An artifact derived from an earlier run's artifact is the link impact
    // analysis depends on; forcing it run-local would sever it.
    expect(isRunLocalEdgeType("DERIVED_FROM")).toBe(false);
    expect(isRunLocalEdgeType("SUPPORTED_BY")).toBe(true);
  });

  it("does not declare EVALUATED_BY run-local, since a policy has no run", () => {
    expect(RUN_LOCAL_EDGE_TYPES).not.toContain("EVALUATED_BY");
  });
});

describe("createEdge", () => {
  const input = {
    tenantId: "acme",
    type: "SUPPORTED_BY",
    from: CLAIM,
    to: CHUNK,
    observedAt: OBSERVED_AT,
  } as const;

  it("derives an id from type and endpoints", () => {
    const edge = createEdge(input);

    expect(edge.id.startsWith("pg:acme:edge.SUPPORTED_BY:")).toBe(true);
    expect(expectedEdgeId(edge)).toBe(edge.id);
  });

  it("is idempotent, so replaying an audit converges instead of duplicating", () => {
    expect(createEdge(input).id).toBe(
      createEdge({ ...input, observedAt: "2027-05-05T00:00:00.000Z" }).id,
    );
  });

  it("gives the two directions different ids", () => {
    expect(createEdge(input).id).not.toBe(createEdge({ ...input, from: CHUNK, to: CLAIM }).id);
  });

  it("separates the same relationship across tenants", () => {
    expect(createEdge(input).id).not.toBe(createEdge({ ...input, tenantId: "globex" }).id);
  });

  it("gives two edge types between the same endpoints different ids", () => {
    expect(createEdge(input).id).not.toBe(createEdge({ ...input, type: "CONTRADICTED_BY" }).id);
  });

  it("fails closed on an unknown edge type", () => {
    expect(() => createEdge({ ...input, type: "VOUCHES_FOR" } as never)).toThrow(GraphError);
  });

  it("fails closed on an empty endpoint", () => {
    expect(() => createEdge({ ...input, to: "" })).toThrow(GraphError);
  });
});
