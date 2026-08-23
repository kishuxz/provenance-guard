import { describe, expect, it } from "vitest";

import {
  GraphError,
  NodeKinds,
  REDACTABLE_ATTRIBUTES,
  createNode,
  expectedNodeId,
  identityFields,
  runOf,
  type GraphNodeInput,
} from "../src/index.js";

const OBSERVED_AT = "2026-03-04T10:00:00.000Z";

function chunkInput(overrides: Partial<Extract<GraphNodeInput, { kind: "Chunk" }>> = {}) {
  return {
    kind: "Chunk",
    tenantId: "acme",
    observedAt: OBSERVED_AT,
    runId: "pg:acme:Run:" + "0".repeat(32),
    contentHash: "sha256:abc",
    ordinal: 0,
    text: "Revenue grew 12% quarter over quarter.",
    channel: "RETRIEVED_DOC",
    tier: "T3",
    retrievedAt: OBSERVED_AT,
    admitted: true,
    ...overrides,
  } satisfies GraphNodeInput;
}

describe("createNode", () => {
  it("builds a chunk node from the fields a caller actually has", () => {
    const node = createNode(chunkInput());

    expect(node.kind).toBe("Chunk");
    expect(node.id.startsWith("pg:acme:Chunk:")).toBe(true);
    expect(expectedNodeId(node)).toBe(node.id);
  });

  it("fails closed with a typed error rather than coercing a bad field", () => {
    // `tier` is not a credibility tier. A silently-coerced node here would be
    // traversed and cited as though its tier had been checked.
    expect(() => createNode(chunkInput({ tier: "T9" } as never))).toThrow(GraphError);

    try {
      createNode(chunkInput({ tier: "T9" } as never));
    } catch (error) {
      expect((error as GraphError).code).toBe("GRAPH_SCHEMA_INVALID");
      expect((error as GraphError).details.join(" ")).toContain("tier");
    }
  });

  it("rejects a non-ISO timestamp", () => {
    expect(() => createNode(chunkInput({ retrievedAt: "yesterday" }))).toThrow(GraphError);
  });

  it("rejects a negative ordinal", () => {
    expect(() => createNode(chunkInput({ ordinal: -1 }))).toThrow(GraphError);
  });

  it("records a rejected chunk rather than dropping it", () => {
    // The graph has to hold chunks the guard refused, or a later claim of
    // support from a blocked chunk has no node to point at.
    const node = createNode(chunkInput({ admitted: false }));

    expect(node.kind === "Chunk" && node.admitted).toBe(false);
  });

  it("distinguishes two chunks with identical text at different offsets", () => {
    const first = createNode(chunkInput({ ordinal: 0 }));
    const second = createNode(chunkInput({ ordinal: 1 }));

    expect(first.id).not.toBe(second.id);
  });

  it("keeps retrievedAt independent of observedAt", () => {
    // A 2023 document re-served today is not a document retrieved today.
    const stale = createNode(chunkInput({ retrievedAt: "2023-01-05T00:00:00.000Z" }));

    expect(stale.kind === "Chunk" && stale.retrievedAt).toBe("2023-01-05T00:00:00.000Z");
    expect(stale.observedAt).toBe(OBSERVED_AT);
  });
});

describe("verdict nodes", () => {
  const verdict = {
    kind: "Verdict",
    tenantId: "acme",
    observedAt: OBSERVED_AT,
    runId: "pg:acme:Run:" + "0".repeat(32),
    targetRef: "pg:acme:Claim:" + "1".repeat(32),
    policyRef: "pg:acme:Policy:" + "2".repeat(32),
    decision: "block",
    reasonCodes: ["CLAIM_UNGROUNDED"],
    method: "deterministic",
    monitored: false,
    decidedAt: OBSERVED_AT,
    inputHash: "sha256:def",
  } satisfies GraphNodeInput;

  it("keeps monitor mode distinct from the decision it recorded", () => {
    const monitored = createNode({ ...verdict, monitored: true });

    expect(monitored.kind === "Verdict" && monitored.decision).toBe("block");
    expect(monitored.kind === "Verdict" && monitored.monitored).toBe(true);
  });

  it("gives monitor and enforce verdicts the same identity for the same decision", () => {
    // Switching to enforcement must not change recorded decision semantics.
    expect(createNode(verdict).id).toBe(createNode({ ...verdict, monitored: true }).id);
  });

  it("records which mechanism decided", () => {
    const judged = createNode({ ...verdict, method: "judge" });

    expect(judged.kind === "Verdict" && judged.method).toBe("judge");
  });

  it("rejects a reason code outside the shared union", () => {
    expect(() => createNode({ ...verdict, reasonCodes: ["NOT_A_CODE"] } as never)).toThrow(
      GraphError,
    );
  });
});

describe("REDACTABLE_ATTRIBUTES", () => {
  it("has an entry for every node kind", () => {
    expect(Object.keys(REDACTABLE_ATTRIBUTES).sort()).toEqual([...NodeKinds].sort());
  });

  it("names attributes that exist on the kind it describes", () => {
    const samples: Record<string, GraphNodeInput> = {
      Source: {
        kind: "Source",
        tenantId: "acme",
        observedAt: OBSERVED_AT,
        uri: "https://user:secret@vendor.test/a",
        sourceKind: "retrieval",
      },
      Chunk: chunkInput(),
    };

    for (const [kind, input] of Object.entries(samples)) {
      for (const attribute of REDACTABLE_ATTRIBUTES[kind as keyof typeof REDACTABLE_ATTRIBUTES]) {
        expect(createNode(input), `${kind}.${attribute}`).toHaveProperty(attribute);
      }
    }
  });

  it("marks every attribute that can carry raw material", () => {
    // A regression here is a silent export leak, so the expectation is written
    // out rather than derived from the map it is checking.
    //
    // Source.uri is deliberately absent. It is an identity field, so blanking
    // it on export would leave the node's id un-derivable and every redacted
    // export failing GRAPH_ID_MISMATCH. Credentials are stripped when the node
    // is created instead, so the secret is never recorded at all.
    expect(REDACTABLE_ATTRIBUTES).toEqual({
      Source: [],
      Run: [],
      Step: [],
      Artifact: [],
      Chunk: ["text"],
      Claim: ["text"],
      Policy: [],
      Verdict: [],
      Output: ["text"],
    });
  });

  it("never marks an identity field as redactable", () => {
    // The property the redaction design rests on, asserted directly rather
    // than left implicit in the list above: redacting a field that determines
    // identity would make every redacted export fail validation. This holds
    // for any future kind, not just today's.
    const samples: GraphNodeInput[] = [
      {
        kind: "Source",
        tenantId: "acme",
        observedAt: OBSERVED_AT,
        uri: "https://vendor.test/a",
        sourceKind: "retrieval",
      },
      {
        kind: "Run",
        tenantId: "acme",
        observedAt: OBSERVED_AT,
        runKey: "r",
        startedAt: OBSERVED_AT,
      },
      chunkInput(),
      {
        kind: "Claim",
        tenantId: "acme",
        observedAt: OBSERVED_AT,
        runId: "pg:acme:Run:" + "0".repeat(32),
        outputRef: "pg:acme:Output:" + "1".repeat(32),
        text: "A claim.",
        spanStart: 0,
        spanEnd: 8,
        material: true,
      },
      {
        kind: "Output",
        tenantId: "acme",
        observedAt: OBSERVED_AT,
        runId: "pg:acme:Run:" + "0".repeat(32),
        contentHash: "sha256:out",
        text: "An output.",
        delivered: true,
      },
    ];

    for (const sample of samples) {
      const identity = new Set(Object.keys(identityFields(sample)));
      for (const attribute of REDACTABLE_ATTRIBUTES[sample.kind]) {
        expect(identity.has(attribute), `${sample.kind}.${attribute} is an identity field`).toBe(
          false,
        );
      }
    }
  });
});

describe("runOf", () => {
  it("returns null for kinds that outlive a run", () => {
    const source = createNode({
      kind: "Source",
      tenantId: "acme",
      observedAt: OBSERVED_AT,
      uri: "https://vendor.test/a",
      sourceKind: "retrieval",
    });
    const policy = createNode({
      kind: "Policy",
      tenantId: "acme",
      observedAt: OBSERVED_AT,
      name: "default",
      version: "1",
      contentHash: "sha256:pol",
      mode: "enforce",
    });

    expect(runOf(source)).toBeNull();
    expect(runOf(policy)).toBeNull();
  });

  it("returns a run's own id for the run node", () => {
    const run = createNode({
      kind: "Run",
      tenantId: "acme",
      observedAt: OBSERVED_AT,
      runKey: "run-1",
      startedAt: OBSERVED_AT,
    });

    expect(runOf(run)).toBe(run.id);
  });

  it("returns the owning run for run-scoped kinds", () => {
    const node = createNode(chunkInput());

    expect(runOf(node)).toBe(chunkInput().runId);
  });
});
