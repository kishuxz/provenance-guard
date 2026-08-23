import type { GraphViolationCode } from "./codes.js";
import { createEdge, type GraphEdge } from "./edges.js";
import { createNode, type GraphNode } from "./nodes.js";
import type { GraphInput } from "./validate.js";

const TENANT = "acme";
const AT = "2026-03-04T10:00:00.000Z";

export interface GraphFixture {
  readonly id: string;
  readonly description: string;
  /**
   * The codes this fixture must produce. Empty for a near miss: a graph that
   * looks like a violation but is legitimate, and must validate clean.
   */
  readonly expectedCodes: readonly GraphViolationCode[];
  readonly graph: GraphInput;
}

/**
 * A small well-formed lineage: one run retrieves a document, splits it into a
 * chunk, admits the chunk, generates an output, and extracts a claim that the
 * chunk supports. Every adversarial fixture is this graph with one thing wrong,
 * so a violation can only be attributed to the mutation.
 */
export function baselineGraph(): GraphInput {
  const run = createNode({
    kind: "Run",
    tenantId: TENANT,
    observedAt: AT,
    runKey: "run-1",
    startedAt: AT,
  });

  const policy = createNode({
    kind: "Policy",
    tenantId: TENANT,
    observedAt: AT,
    name: "default",
    version: "1",
    contentHash: "sha256:policy-1",
    mode: "enforce",
  });

  const source = createNode({
    kind: "Source",
    tenantId: TENANT,
    observedAt: AT,
    uri: "https://vendor.test/report",
    sourceKind: "retrieval",
  });

  const step = createNode({
    kind: "Step",
    tenantId: TENANT,
    observedAt: AT,
    runId: run.id,
    index: 0,
    name: "retrieve-report",
    stepKind: "retrieve",
  });

  const artifact = createNode({
    kind: "Artifact",
    tenantId: TENANT,
    observedAt: AT,
    runId: run.id,
    contentHash: "sha256:artifact-1",
    mediaType: "text/plain",
    upstreamStatus: 200,
  });

  const chunk = createNode({
    kind: "Chunk",
    tenantId: TENANT,
    observedAt: AT,
    runId: run.id,
    contentHash: "sha256:chunk-1",
    ordinal: 0,
    text: "Revenue grew 12% quarter over quarter in the EMEA region.",
    channel: "RETRIEVED_DOC",
    tier: "T3",
    retrievedAt: AT,
    admitted: true,
    slot: "evidence",
  });

  const output = createNode({
    kind: "Output",
    tenantId: TENANT,
    observedAt: AT,
    runId: run.id,
    contentHash: "sha256:output-1",
    text: "Revenue grew 12% quarter over quarter in the EMEA region.",
    delivered: true,
  });

  const claim = createNode({
    kind: "Claim",
    tenantId: TENANT,
    observedAt: AT,
    runId: run.id,
    outputRef: output.id,
    text: "Revenue grew 12% quarter over quarter in the EMEA region.",
    spanStart: 0,
    spanEnd: 56,
    material: true,
  });

  const verdict = createNode({
    kind: "Verdict",
    tenantId: TENANT,
    observedAt: AT,
    runId: run.id,
    targetRef: claim.id,
    policyRef: policy.id,
    decision: "allow",
    reasonCodes: [],
    method: "deterministic",
    monitored: false,
    decidedAt: AT,
    inputHash: "sha256:input-1",
  });

  const edge = (type: GraphEdge["type"], from: string, to: string): GraphEdge =>
    createEdge({ tenantId: TENANT, type, from, to, observedAt: AT });

  return {
    nodes: [run, policy, source, step, artifact, chunk, output, claim, verdict],
    edges: [
      edge("PRODUCED", run.id, step.id),
      edge("PRODUCED", step.id, artifact.id),
      edge("PRODUCED", source.id, artifact.id),
      edge("DERIVED_FROM", artifact.id, source.id),
      edge("SPLIT_INTO", artifact.id, chunk.id),
      edge("INCLUDED_IN", chunk.id, step.id),
      edge("CONSUMED", step.id, chunk.id),
      edge("PRODUCED", step.id, output.id),
      edge("EXTRACTED_FROM", claim.id, output.id),
      edge("SUPPORTED_BY", claim.id, chunk.id),
      edge("EVALUATED_BY", claim.id, policy.id),
      edge("DECIDES", verdict.id, claim.id),
    ],
  };
}

/** Narrows to the requested kind, so a fixture can override kind-specific fields. */
function node<K extends GraphNode["kind"]>(
  graph: GraphInput,
  kind: K,
): Extract<GraphNode, { kind: K }> {
  const found = graph.nodes.find(
    (candidate): candidate is Extract<GraphNode, { kind: K }> => candidate.kind === kind,
  );
  if (found === undefined) {
    throw new Error(`baseline graph has no ${kind} node`);
  }
  return found;
}

function replace(graph: GraphInput, updated: GraphNode): GraphInput {
  return {
    nodes: graph.nodes.map((candidate) =>
      candidate.kind === updated.kind && candidate.id === updated.id ? updated : candidate,
    ),
    edges: graph.edges,
  };
}

/** Drops a node and leaves edges dangling, to isolate endpoint checking. */
function withoutNode(graph: GraphInput, id: string): GraphInput {
  return { nodes: graph.nodes.filter((candidate) => candidate.id !== id), edges: graph.edges };
}

/**
 * Drops a node and every edge touching it, so the fixture isolates the single
 * violation it targets instead of also reporting the dangling edges the
 * deletion happens to create.
 */
function withoutNodeAndEdges(graph: GraphInput, id: string): GraphInput {
  return {
    nodes: graph.nodes.filter((candidate) => candidate.id !== id),
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  };
}

function withEdges(graph: GraphInput, extra: readonly GraphEdge[]): GraphInput {
  return { nodes: graph.nodes, edges: [...graph.edges, ...extra] };
}

function withoutEdgeType(graph: GraphInput, type: GraphEdge["type"]): GraphInput {
  return { nodes: graph.nodes, edges: graph.edges.filter((edge) => edge.type !== type) };
}

/**
 * One fixture per violation code, plus the near misses. Exported so the CLI's
 * `graph validate`, the storage conformance suite, and these tests all exercise
 * the same corpus rather than three divergent hand-built graphs.
 */
export function graphFixtures(): readonly GraphFixture[] {
  const fixtures: GraphFixture[] = [];

  fixtures.push({
    id: "valid-baseline",
    description: "A well-formed lineage from source to delivered claim.",
    expectedCodes: [],
    graph: baselineGraph(),
  });

  {
    const graph = baselineGraph();
    const chunk = node(graph, "Chunk");
    fixtures.push({
      id: "schema-invalid-tier",
      description: "A chunk carrying a credibility tier outside the shared union.",
      expectedCodes: ["GRAPH_SCHEMA_INVALID"],
      graph: replace(graph, { ...chunk, tier: "T9" } as unknown as GraphNode),
    });
  }

  {
    const graph = baselineGraph();
    const chunk = node(graph, "Chunk");
    fixtures.push({
      id: "edge-endpoint-missing",
      description: "SUPPORTED_BY points at a chunk that is not in the graph.",
      expectedCodes: ["GRAPH_EDGE_ENDPOINT_MISSING"],
      graph: withoutNode(graph, chunk.id),
    });
  }

  {
    const graph = baselineGraph();
    const claim = node(graph, "Claim");
    fixtures.push({
      id: "reference-missing-output",
      description: "A claim whose outputRef names an output that was never recorded.",
      expectedCodes: ["GRAPH_REFERENCE_MISSING"],
      graph: withoutNodeAndEdges(graph, claim.outputRef),
    });
  }

  {
    const graph = baselineGraph();
    const chunk = node(graph, "Chunk");
    const claim = node(graph, "Claim");
    fixtures.push({
      id: "edge-type-not-permitted",
      description: "SUPPORTED_BY reversed, so a chunk appears to rest on a claim.",
      expectedCodes: ["GRAPH_EDGE_TYPE_NOT_PERMITTED"],
      graph: withEdges(graph, [
        createEdge({
          tenantId: TENANT,
          type: "SUPPORTED_BY",
          from: chunk.id,
          to: claim.id,
          observedAt: AT,
        }),
      ]),
    });
  }

  {
    const graph = baselineGraph();
    const chunk = node(graph, "Chunk");
    const foreign = createNode({
      kind: "Claim",
      tenantId: "globex",
      observedAt: AT,
      runId: node(graph, "Run").id,
      outputRef: node(graph, "Output").id,
      text: "Revenue grew 12%.",
      spanStart: 0,
      spanEnd: 17,
      material: true,
    });

    fixtures.push({
      id: "tenant-mismatch-edge",
      description: "A claim in one tenant is supported by a chunk in another.",
      expectedCodes: ["GRAPH_TENANT_MISMATCH"],
      graph: {
        nodes: [...graph.nodes, foreign],
        edges: [
          ...graph.edges,
          createEdge({
            tenantId: TENANT,
            type: "SUPPORTED_BY",
            from: foreign.id,
            to: chunk.id,
            observedAt: AT,
          }),
        ],
      },
    });
  }

  {
    const graph = baselineGraph();
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
      contentHash: "sha256:chunk-2",
      ordinal: 0,
      text: "Unrelated document.",
      channel: "RETRIEVED_DOC",
      tier: "T3",
      retrievedAt: AT,
      admitted: true,
    });

    fixtures.push({
      id: "run-mismatch-support",
      description: "SUPPORTED_BY is run-local but joins a claim to another run's chunk.",
      expectedCodes: ["GRAPH_RUN_MISMATCH"],
      graph: {
        nodes: [...graph.nodes, otherRun, otherChunk],
        edges: [
          ...graph.edges,
          createEdge({
            tenantId: TENANT,
            type: "SUPPORTED_BY",
            from: node(graph, "Claim").id,
            to: otherChunk.id,
            observedAt: AT,
          }),
        ],
      },
    });
  }

  {
    const graph = baselineGraph();
    const artifact = node(graph, "Artifact");
    fixtures.push({
      id: "cycle-self-loop",
      description: "An artifact derived from itself.",
      expectedCodes: ["GRAPH_CYCLE_DETECTED"],
      graph: withEdges(graph, [
        createEdge({
          tenantId: TENANT,
          type: "DERIVED_FROM",
          from: artifact.id,
          to: artifact.id,
          observedAt: AT,
        }),
      ]),
    });
  }

  {
    const graph = baselineGraph();
    const run = node(graph, "Run");
    const ring = [0, 1, 2].map((index) =>
      createNode({
        kind: "Artifact",
        tenantId: TENANT,
        observedAt: AT,
        runId: run.id,
        contentHash: `sha256:ring-${index}`,
      }),
    ) as [GraphNode, GraphNode, GraphNode];

    fixtures.push({
      id: "cycle-three-node-ring",
      description:
        "Three artifacts each derived from the next. No single edge looks wrong, so only a traversal finds it.",
      expectedCodes: ["GRAPH_CYCLE_DETECTED"],
      graph: {
        nodes: [...graph.nodes, ...ring],
        edges: [
          ...graph.edges,
          ...ring.map((artifact, index) =>
            createEdge({
              tenantId: TENANT,
              type: "DERIVED_FROM",
              from: artifact.id,
              to: (ring[(index + 1) % ring.length] as GraphNode).id,
              observedAt: AT,
            }),
          ),
        ],
      },
    });
  }

  {
    const graph = baselineGraph();
    const chunk = node(graph, "Chunk");
    fixtures.push({
      id: "support-from-blocked-chunk",
      description: "A claim rests on a chunk the inbound guard refused.",
      expectedCodes: ["GRAPH_SUPPORT_FROM_BLOCKED_CHUNK"],
      graph: replace(graph, { ...chunk, admitted: false }),
    });
  }

  {
    const graph = baselineGraph();
    fixtures.push({
      id: "unsupported-delivered-claim",
      description: "A delivered material claim with its support edge and allowing verdict removed.",
      expectedCodes: ["GRAPH_CLAIM_UNSUPPORTED_DELIVERY"],
      graph: withoutNode(
        withoutEdgeType(withoutEdgeType(baselineGraph(), "SUPPORTED_BY"), "DECIDES"),
        node(graph, "Verdict").id,
      ),
    });
  }

  {
    const graph = baselineGraph();
    fixtures.push({
      id: "verdict-policy-missing",
      description: "A verdict whose policy version is not recorded in the graph.",
      expectedCodes: ["GRAPH_VERDICT_POLICY_MISSING"],
      graph: withoutNodeAndEdges(graph, node(graph, "Policy").id),
    });
  }

  {
    const graph = baselineGraph();
    const chunk = node(graph, "Chunk");
    fixtures.push({
      id: "id-mismatch-tampered-chunk",
      description: "A chunk edited after the fact, so its id no longer derives from its fields.",
      expectedCodes: ["GRAPH_ID_MISMATCH"],
      graph: replace(graph, { ...chunk, contentHash: "sha256:rewritten" } as GraphNode),
    });
  }

  {
    const graph = baselineGraph();
    const chunk = node(graph, "Chunk");
    fixtures.push({
      id: "duplicate-id",
      description: "Two different chunks stored under one id.",
      expectedCodes: ["GRAPH_DUPLICATE_ID"],
      graph: {
        nodes: [...graph.nodes, { ...chunk, text: "A different body." } as GraphNode],
        edges: graph.edges,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Near misses. Each looks like one of the violations above and is not one.
  // A validator that fires on these is unusable: it would report the tool's
  // own model as a defect in the system under test.
  // ---------------------------------------------------------------------

  {
    const graph = baselineGraph();
    const previousRun = createNode({
      kind: "Run",
      tenantId: TENANT,
      observedAt: AT,
      runKey: "run-0",
      startedAt: AT,
    });
    const previousArtifact = createNode({
      kind: "Artifact",
      tenantId: TENANT,
      observedAt: AT,
      runId: previousRun.id,
      contentHash: "sha256:artifact-0",
    });

    fixtures.push({
      id: "near-miss-cross-run-derivation",
      description:
        "An artifact derived from an earlier run's artifact. DERIVED_FROM is not run-local, and this link is what impact analysis follows.",
      expectedCodes: [],
      graph: {
        nodes: [...graph.nodes, previousRun, previousArtifact],
        edges: [
          ...graph.edges,
          createEdge({
            tenantId: TENANT,
            type: "DERIVED_FROM",
            from: node(graph, "Artifact").id,
            to: previousArtifact.id,
            observedAt: AT,
          }),
        ],
      },
    });
  }

  {
    const graph = withoutEdgeType(baselineGraph(), "SUPPORTED_BY");
    const claim = node(graph, "Claim");
    fixtures.push({
      id: "near-miss-unsupported-non-material-claim",
      description: "An unsupported delivered claim that is not material, such as a hedge.",
      expectedCodes: [],
      graph: replace(graph, { ...claim, material: false }),
    });
  }

  {
    const graph = withoutEdgeType(baselineGraph(), "SUPPORTED_BY");
    const output = node(graph, "Output");
    fixtures.push({
      id: "near-miss-unsupported-undelivered-claim",
      description: "An unsupported material claim on an output that was blocked before delivery.",
      expectedCodes: [],
      graph: replace(graph, { ...output, delivered: false }),
    });
  }

  {
    fixtures.push({
      id: "near-miss-unsupported-claim-with-policy-exception",
      description:
        "An unsupported delivered material claim that a verdict allowed under a named policy version.",
      expectedCodes: [],
      graph: withoutEdgeType(baselineGraph(), "SUPPORTED_BY"),
    });
  }

  {
    // The baseline with support removed and its allowing verdict replaced by a
    // monitored block: an unsupported material claim delivered because the
    // policy was not in force. That is what monitor mode is, and the ledger
    // records both halves of it.
    const graph = withoutEdgeType(baselineGraph(), "SUPPORTED_BY");
    const claim = node(graph, "Claim");
    const policy = node(graph, "Policy");
    const original = node(graph, "Verdict");

    const monitoredBlock = createNode({
      kind: "Verdict",
      tenantId: TENANT,
      observedAt: AT,
      runId: node(graph, "Run").id,
      targetRef: claim.id,
      policyRef: policy.id,
      decision: "block",
      reasonCodes: ["CLAIM_UNGROUNDED"],
      method: "deterministic",
      monitored: true,
      decidedAt: AT,
      inputHash: "sha256:input-3",
    });

    fixtures.push({
      id: "near-miss-monitor-mode-unsupported-delivery",
      description:
        "An unsupported material claim delivered under a monitor-mode policy that recorded the block. The delivery is explained, so the record is coherent.",
      expectedCodes: [],
      graph: {
        nodes: [...graph.nodes.filter((candidate) => candidate.id !== original.id), monitoredBlock],
        edges: [
          ...graph.edges.filter((edge) => edge.from !== original.id),
          createEdge({
            tenantId: TENANT,
            type: "DECIDES",
            from: monitoredBlock.id,
            to: claim.id,
            observedAt: AT,
          }),
        ],
      },
    });
  }

  {
    const graph = baselineGraph();
    const chunk = node(graph, "Chunk");
    const policy = node(graph, "Policy");
    const monitoredBlock = createNode({
      kind: "Verdict",
      tenantId: TENANT,
      observedAt: AT,
      runId: node(graph, "Run").id,
      targetRef: chunk.id,
      policyRef: policy.id,
      decision: "block",
      reasonCodes: ["CHANNEL_NOT_PERMITTED"],
      method: "deterministic",
      monitored: true,
      decidedAt: AT,
      inputHash: "sha256:input-2",
    });

    fixtures.push({
      id: "near-miss-monitor-mode-block",
      description:
        "A monitor-mode block on an admitted chunk. The policy was not in force, so a claim resting on the chunk records what happened rather than a corrupt ledger.",
      expectedCodes: [],
      graph: {
        nodes: [...graph.nodes, monitoredBlock],
        edges: [
          ...graph.edges,
          createEdge({
            tenantId: TENANT,
            type: "DECIDES",
            from: monitoredBlock.id,
            to: chunk.id,
            observedAt: AT,
          }),
        ],
      },
    });
  }

  return fixtures;
}
