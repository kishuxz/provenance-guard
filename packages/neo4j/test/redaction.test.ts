import { describe, expect, it } from "vitest";

import {
  GraphError,
  REDACTED,
  baselineGraph,
  createNode,
  validateGraph,
  type GraphNode,
} from "@provguard/graph";

import { Neo4jGraphAdapter, redactNodeForStorage, resolvePersistRawText } from "../src/index.js";

/**
 * Unit coverage for the sensitive-data behaviour, with no database.
 *
 * The driver connects lazily, so an adapter can be constructed and its
 * configuration inspected offline. That matters: the redaction default is a
 * security property, and a property that can only be checked when Docker is
 * available is a property that goes unchecked on most runs.
 */
const SECRET = "Revenue grew 12% quarter over quarter in the EMEA region.";
const OFFLINE = { uri: "neo4j://127.0.0.1:1", username: "neo4j", password: "unused-in-unit-tests" };

describe("resolvePersistRawText", () => {
  it("defaults to redacting when absent", () => {
    expect(resolvePersistRawText(undefined)).toBe(false);
    expect(resolvePersistRawText(null)).toBe(false);
  });

  it("enables raw persistence only for the literal boolean true", () => {
    expect(resolvePersistRawText(true)).toBe(true);
    expect(resolvePersistRawText(false)).toBe(false);
  });

  it("refuses a truthy string rather than silently enabling raw persistence", () => {
    // The dangerous case: "false" is truthy. A `??`-style default would have
    // turned a stringly-typed config into raw storage.
    for (const value of ["true", "false", "1", "yes"]) {
      expect(() => resolvePersistRawText(value), value).toThrow(GraphError);
    }
  });

  it("refuses other malformed values rather than quietly ignoring them", () => {
    // Quietly ignoring a typo would leave an operator believing raw text was on
    // when it was not. Both silent directions are bad; this one is loud.
    for (const value of [1, 0, {}, []]) {
      expect(() => resolvePersistRawText(value), JSON.stringify(value)).toThrow(GraphError);
    }
  });
});

describe("adapter configuration", () => {
  it("redacts by default", () => {
    expect(new Neo4jGraphAdapter(OFFLINE).persistsRawText).toBe(false);
  });

  it("reports raw persistence only when explicitly enabled", () => {
    expect(new Neo4jGraphAdapter({ ...OFFLINE, persistRawText: true }).persistsRawText).toBe(true);
    expect(new Neo4jGraphAdapter({ ...OFFLINE, persistRawText: false }).persistsRawText).toBe(
      false,
    );
  });

  it("refuses to construct with a malformed opt-in", () => {
    expect(
      () => new Neo4jGraphAdapter({ ...OFFLINE, persistRawText: "true" as unknown as boolean }),
    ).toThrow(GraphError);
  });

  it("never puts the password into the error raised by a bad config", () => {
    try {
      new Neo4jGraphAdapter({
        ...OFFLINE,
        password: "hunter2",
        persistRawText: "yes" as unknown as boolean,
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(`${(error as Error).message}`).not.toContain("hunter2");
    }
  });
});

describe("redactNodeForStorage", () => {
  it("removes raw text from a chunk", () => {
    const chunk = baselineGraph().nodes.find((node) => node.kind === "Chunk") as GraphNode;
    const redacted = redactNodeForStorage(chunk);

    expect(JSON.stringify(chunk)).toContain(SECRET);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(JSON.stringify(redacted)).toContain(REDACTED);
  });

  it("leaves a node with nothing sensitive byte-identical", () => {
    const run = baselineGraph().nodes.find((node) => node.kind === "Run") as GraphNode;

    expect(redactNodeForStorage(run)).toBe(run);
  });

  it("does not change any id, so redacted writes stay queryable by id", () => {
    const graph = baselineGraph();
    const redacted = graph.nodes.map(redactNodeForStorage);

    expect(redacted.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
  });

  it("keeps a fully redacted graph schema-valid", () => {
    // Redaction touches only non-identity attributes, so ids still derive and
    // the stored graph still validates. If it did not, a redacted store would
    // be unusable for exactly the auditing it exists to support.
    const graph = baselineGraph();
    const redacted = { nodes: graph.nodes.map(redactNodeForStorage), edges: graph.edges };

    expect(validateGraph(redacted).violations).toEqual([]);
  });

  it("redacts claim and output text as well as chunk text", () => {
    const graph = baselineGraph();
    const redacted = graph.nodes.map(redactNodeForStorage);

    for (const kind of ["Claim", "Output"] as const) {
      const node = redacted.find((candidate) => candidate.kind === kind);
      expect(JSON.stringify(node), kind).not.toContain(SECRET);
    }
  });

  it("does not redact a source uri, which is identity", () => {
    // Credentials are stripped at creation instead; blanking the uri here would
    // make the node's id underivable and every stored graph invalid.
    const source = createNode({
      kind: "Source",
      tenantId: "acme",
      observedAt: "2026-03-04T10:00:00.000Z",
      uri: "https://vendor.test/report",
      sourceKind: "retrieval",
    });

    expect((redactNodeForStorage(source) as { uri: string }).uri).toBe(
      "https://vendor.test/report",
    );
  });
});
