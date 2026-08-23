import { describe, expect, it } from "vitest";

import {
  GraphError,
  MemoryGraphStore,
  REDACTED,
  baselineGraph,
  createNode,
  fromCanonicalJSON,
  fromJSONL,
  stripCredentials,
  toCanonicalJSON,
  toJSONL,
  validateGraph,
  type GraphNode,
  type SourceNode,
} from "../src/index.js";

const SECRET_TEXT = "Revenue grew 12% quarter over quarter in the EMEA region.";

describe("canonical JSON", () => {
  it("is byte-identical for the same graph supplied in different orders", () => {
    const graph = baselineGraph();
    const shuffled = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };

    expect(toCanonicalJSON(shuffled)).toBe(toCanonicalJSON(graph));
  });

  it("differs when any recorded fact differs", () => {
    // Guards against a canonicaliser so aggressive it erases real differences.
    const graph = baselineGraph();
    const changed = {
      nodes: graph.nodes.map((node) =>
        node.kind === "Chunk" ? ({ ...node, admitted: false } as GraphNode) : node,
      ),
      edges: graph.edges,
    };

    expect(toCanonicalJSON(changed)).not.toBe(toCanonicalJSON(graph));
  });

  it("round-trips without redaction", () => {
    const graph = baselineGraph();
    const restored = fromCanonicalJSON(toCanonicalJSON(graph, { redact: false }));

    expect(restored.nodes).toEqual([...graph.nodes].sort(byId));
    expect(restored.edges).toEqual([...graph.edges].sort(byId));
  });

  it("serializes byte-identically on repeat, which is invariant 8 as a string check", () => {
    expect(toCanonicalJSON(baselineGraph())).toBe(toCanonicalJSON(baselineGraph()));
  });
});

describe("redaction", () => {
  it("is the default, so forgetting the option cannot leak", () => {
    expect(toCanonicalJSON(baselineGraph())).not.toContain(SECRET_TEXT);
  });

  it("removes raw material from every redactable attribute", () => {
    const exported = toCanonicalJSON(baselineGraph());

    expect(exported).toContain(REDACTED);
    expect(exported).not.toContain(SECRET_TEXT);
  });

  it("keeps raw material when explicitly asked", () => {
    expect(toCanonicalJSON(baselineGraph(), { redact: false })).toContain(SECRET_TEXT);
  });

  it("leaves a redacted export still valid", () => {
    // The property the whole redaction design turns on: every redactable
    // attribute is a non-identity field, so ids still derive. An export you
    // cannot validate is an export you have to trust.
    const restored = fromCanonicalJSON(toCanonicalJSON(baselineGraph()));
    const report = validateGraph(restored);

    expect(report.violations).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("does not change any id", () => {
    const graph = baselineGraph();
    const redacted = fromCanonicalJSON(toCanonicalJSON(graph));

    expect(redacted.nodes.map((node) => node.id)).toEqual(
      [...graph.nodes].sort(byId).map((node) => node.id),
    );
  });
});

describe("source credentials", () => {
  const withPassword = (): SourceNode =>
    createNode({
      kind: "Source",
      tenantId: "acme",
      observedAt: "2026-03-04T10:00:00.000Z",
      uri: "https://svc-account:hunter2@vendor.test/report?doc=42",
      sourceKind: "retrieval",
    }) as SourceNode;

  it("never records the password anywhere on the node", () => {
    // Checked against the serialized node, not just the uri field, so a
    // credential surviving in some other attribute would still fail.
    expect(JSON.stringify(withPassword())).not.toContain("hunter2");
  });

  it("never records the username either", () => {
    expect(JSON.stringify(withPassword())).not.toContain("svc-account");
  });

  it("keeps host, path and query, because they are what the source is", () => {
    const source = withPassword();

    expect(source.uri).toContain("vendor.test/report");
    expect(source.uri).toContain("doc=42");
  });

  it("distinguishes two documents that differ only by query string", () => {
    const base = {
      kind: "Source",
      tenantId: "acme",
      observedAt: "2026-03-04T10:00:00.000Z",
      sourceKind: "retrieval",
    } as const;

    const first = createNode({ ...base, uri: "https://vendor.test/r?doc=1" });
    const second = createNode({ ...base, uri: "https://vendor.test/r?doc=2" });

    expect(first.id).not.toBe(second.id);
  });

  it("leaves an unparseable uri alone rather than discarding the source", () => {
    expect(stripCredentials("not a url")).toBe("not a url");
  });

  it("leaves a credential-free uri byte-identical", () => {
    expect(stripCredentials("https://vendor.test/report")).toBe("https://vendor.test/report");
  });
});

describe("JSONL", () => {
  it("round-trips", () => {
    const graph = baselineGraph();
    const restored = fromJSONL(toJSONL(graph, { redact: false }));

    expect(restored.nodes).toEqual([...graph.nodes].sort(byId));
    expect(restored.edges).toEqual([...graph.edges].sort(byId));
  });

  it("writes one record per line", () => {
    const graph = baselineGraph();
    const lines = toJSONL(graph).trimEnd().split("\n");

    expect(lines).toHaveLength(graph.nodes.length + graph.edges.length + 1);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("redacts by default like the JSON form", () => {
    expect(toJSONL(baselineGraph())).not.toContain(SECRET_TEXT);
  });
});

describe("failing closed", () => {
  it("rejects JSON that is not JSON", () => {
    expect(() => fromCanonicalJSON("{not json")).toThrow(GraphError);
  });

  it("rejects a document with no schema version", () => {
    expect(() => fromCanonicalJSON(JSON.stringify({ nodes: [], edges: [] }))).toThrow(GraphError);
  });

  it("rejects a future schema version instead of guessing", () => {
    const document = JSON.parse(toCanonicalJSON(baselineGraph())) as Record<string, unknown>;
    document.schemaVersion = 99;

    expect(() => fromCanonicalJSON(JSON.stringify(document))).toThrow(/schema version/);
  });

  it("rejects a node that does not satisfy its schema", () => {
    const document = JSON.parse(toCanonicalJSON(baselineGraph(), { redact: false })) as {
      nodes: Record<string, unknown>[];
    };
    document.nodes[0] = { ...document.nodes[0], kind: "Wormhole" };

    expect(() => fromCanonicalJSON(JSON.stringify(document))).toThrow(GraphError);
  });

  it("rejects JSONL with no header rather than assuming a version", () => {
    const body = toJSONL(baselineGraph()).split("\n").slice(1).join("\n");

    expect(() => fromJSONL(body)).toThrow(/header/);
  });

  it("does not return a partial graph when one line is bad", () => {
    const lines = toJSONL(baselineGraph()).trimEnd().split("\n");
    lines[2] = "{oops";

    expect(() => fromJSONL(lines.join("\n"))).toThrow(GraphError);
  });
});

describe("MemoryGraphStore", () => {
  const store = () => new MemoryGraphStore(baselineGraph());

  it("loads a graph and reports its size", () => {
    const graph = baselineGraph();

    expect(store().size).toEqual({ nodes: graph.nodes.length, edges: graph.edges.length });
  });

  it("is idempotent when the same graph is loaded twice", () => {
    const loaded = store().load(baselineGraph());

    expect(loaded.size).toEqual(store().size);
  });

  it("never returns another tenant's elements", () => {
    const subject = store();

    expect(subject.nodes("globex")).toEqual([]);
    expect(subject.edges("globex")).toEqual([]);
    for (const node of subject.nodes("acme")) {
      expect(subject.node("globex", node.id)).toBeUndefined();
    }
  });

  it("filters by kind and by edge type", () => {
    const subject = store();

    expect(subject.nodes("acme", "Chunk").every((node) => node.kind === "Chunk")).toBe(true);
    expect(
      subject.edges("acme", "SUPPORTED_BY").every((edge) => edge.type === "SUPPORTED_BY"),
    ).toBe(true);
  });

  it("walks both directions", () => {
    const subject = store();
    const claim = subject.nodes("acme", "Claim")[0] as GraphNode;
    const chunk = subject.nodes("acme", "Chunk")[0] as GraphNode;

    expect(subject.outgoing("acme", claim.id, "SUPPORTED_BY").map((edge) => edge.to)).toEqual([
      chunk.id,
    ]);
    expect(subject.incoming("acme", chunk.id, "SUPPORTED_BY").map((edge) => edge.from)).toEqual([
      claim.id,
    ]);
  });

  it("returns deterministically ordered reads", () => {
    const forward = new MemoryGraphStore(baselineGraph());
    const graph = baselineGraph();
    const reversed = new MemoryGraphStore({
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });

    expect(reversed.nodes("acme")).toEqual(forward.nodes("acme"));
    expect(reversed.edges("acme")).toEqual(forward.edges("acme"));
  });

  it("throws a typed error when a required node is absent", () => {
    expect(() => store().requireNode("acme", "pg:acme:Chunk:" + "0".repeat(32))).toThrow(
      GraphError,
    );
  });

  it("snapshots a tenant into something validatable", () => {
    expect(validateGraph(store().snapshot("acme")).valid).toBe(true);
  });

  it("rejects a malformed tenant id rather than scanning everything", () => {
    expect(() => store().nodes("ACME")).toThrow(GraphError);
  });
});

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}
