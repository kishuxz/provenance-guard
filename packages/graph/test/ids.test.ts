import { describe, expect, it } from "vitest";

import {
  GRAPH_SCHEMA_VERSION,
  GraphError,
  createNode,
  deriveGraphId,
  isIdForTenant,
  parseGraphId,
  type GraphNodeInput,
} from "../src/index.js";

const OBSERVED_AT = "2026-03-04T10:00:00.000Z";

describe("deriveGraphId", () => {
  it("is stable across repeated derivation", () => {
    const first = deriveGraphId("acme", "Source", {
      uri: "https://vendor.test/a",
      sourceKind: "retrieval",
    });
    const second = deriveGraphId("acme", "Source", {
      uri: "https://vendor.test/a",
      sourceKind: "retrieval",
    });

    expect(first).toBe(second);
  });

  it("does not depend on the order identity fields were written", () => {
    const written = deriveGraphId("acme", "Source", {
      uri: "https://vendor.test/a",
      sourceKind: "tool",
    });
    const reordered = deriveGraphId("acme", "Source", {
      sourceKind: "tool",
      uri: "https://vendor.test/a",
    });

    expect(written).toBe(reordered);
  });

  it("separates identical facts recorded by different tenants", () => {
    const identity = { uri: "https://vendor.test/a", sourceKind: "retrieval" } as const;

    expect(deriveGraphId("acme", "Source", identity)).not.toBe(
      deriveGraphId("globex", "Source", identity),
    );
  });

  it("cannot be forged by moving content across the field boundary", () => {
    // With a delimiter-joined hash input these two collide. They must not.
    const split = deriveGraphId("acme", "Source", { uri: "a", sourceKind: "b" });
    const merged = deriveGraphId("acme", "Source", { uri: "a:b", sourceKind: "" });

    expect(split).not.toBe(merged);
  });

  it("cannot be forged by a tenant that contains the id separator", () => {
    expect(() => deriveGraphId("acme:Chunk:0", "Source", { uri: "a", sourceKind: "tool" })).toThrow(
      GraphError,
    );
  });

  it("rejects a tenant id that is empty or out of charset", () => {
    for (const tenant of ["", "ACME", "acme tenant", "acme/other", "-leading"]) {
      expect(() => deriveGraphId(tenant, "Run", { runKey: "r" }), tenant).toThrow(GraphError);
    }
  });
});

describe("parseGraphId", () => {
  it("round-trips a derived id", () => {
    const id = deriveGraphId("acme", "Run", { runKey: "run-1" });

    expect(parseGraphId(id)).toEqual({
      tenantId: "acme",
      kind: "Run",
      digest: id.split(":")[3],
    });
  });

  it("rejects strings that are not graph ids", () => {
    for (const candidate of [
      "",
      "run-1",
      "pg:acme:Run",
      "pg:acme:Run:nothex",
      "x:acme:Run:" + "a".repeat(32),
    ]) {
      expect(() => parseGraphId(candidate), candidate).toThrow(GraphError);
    }
  });

  it("reports tenant scoping without throwing", () => {
    const id = deriveGraphId("acme", "Run", { runKey: "run-1" });

    expect(isIdForTenant(id, "acme")).toBe(true);
    expect(isIdForTenant(id, "globex")).toBe(false);
    expect(isIdForTenant("not-an-id", "acme")).toBe(false);
  });
});

describe("createNode identity", () => {
  const run: GraphNodeInput = {
    kind: "Run",
    tenantId: "acme",
    observedAt: OBSERVED_AT,
    runKey: "run-1",
    startedAt: OBSERVED_AT,
  };

  it("derives the id rather than accepting one", () => {
    const node = createNode(run);

    expect(node.id).toBe(deriveGraphId("acme", "Run", { runKey: "run-1" }));
    expect(node.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
  });

  it("converges when the same fact is recorded twice", () => {
    expect(createNode(run).id).toBe(
      createNode({ ...run, observedAt: "2027-01-01T00:00:00.000Z" }).id,
    );
  });

  it("does not let a non-identity attribute change identity", () => {
    // startedAt is an observation about the run, not what makes it that run.
    expect(createNode(run).id).toBe(
      createNode({ ...run, startedAt: "2020-01-01T00:00:00.000Z" }).id,
    );
  });
});
