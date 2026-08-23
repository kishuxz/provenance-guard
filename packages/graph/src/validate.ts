import type { GraphViolationCode } from "./codes.js";
import {
  GraphEdgeSchema,
  isAcyclicEdgeType,
  isRunLocalEdgeType,
  isEdgePairPermitted,
  expectedEdgeId,
  type GraphEdge,
} from "./edges.js";
import { parseGraphId } from "./ids.js";
import { GraphNodeSchema, expectedNodeId, runOf, type GraphNode } from "./nodes.js";

export interface GraphViolation {
  readonly code: GraphViolationCode;
  readonly message: string;
  /** The node or edge the violation is attributed to. */
  readonly elementId: string;
  readonly elementType: "node" | "edge";
  readonly details: readonly string[];
}

export interface GraphInput {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface ValidationReport {
  readonly valid: boolean;
  readonly violations: readonly GraphViolation[];
}

/**
 * Checks every invariant and returns all violations.
 *
 * Total rather than fail-fast on purpose. A validator that throws on the first
 * problem tells you a graph is broken; one that reports every problem tells you
 * what to repair, and repairing a lineage ledger one round-trip per defect is
 * not viable. Nothing here throws on malformed input — a graph that arrived as
 * JSON is exactly the case this has to survive.
 */
export function validateGraph(input: GraphInput): ValidationReport {
  const violations: GraphViolation[] = [];

  const nodesById = new Map<string, GraphNode>();
  const duplicateIds = new Set<string>();

  for (const node of input.nodes) {
    checkNodeSchema(node, violations);

    if (nodesById.has(node.id)) {
      duplicateIds.add(node.id);
    } else {
      nodesById.set(node.id, node);
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of input.edges) {
    checkEdgeSchema(edge, violations);

    if (edgeIds.has(edge.id)) {
      duplicateIds.add(edge.id);
    } else {
      edgeIds.add(edge.id);
    }
  }

  for (const id of duplicateIds) {
    violations.push({
      code: "GRAPH_DUPLICATE_ID",
      message: `id ${id} is used by more than one element`,
      elementId: id,
      elementType: nodesById.has(id) ? "node" : "edge",
      details: [],
    });
  }

  for (const node of nodesById.values()) {
    checkNodeIdentity(node, violations);
    checkNodeReferences(node, nodesById, violations);
  }

  for (const edge of input.edges) {
    checkEdge(edge, nodesById, violations);
  }

  checkAcyclic(input.edges, nodesById, violations);
  checkSupportFromBlockedChunks(input.edges, nodesById, violations);
  checkDeliveredClaimsAreSupported(input.edges, nodesById, violations);

  return { valid: violations.length === 0, violations: sortViolations(violations) };
}

function checkNodeSchema(node: GraphNode, violations: GraphViolation[]): void {
  const parsed = GraphNodeSchema.safeParse(node);
  if (parsed.success) {
    return;
  }

  violations.push({
    code: "GRAPH_SCHEMA_INVALID",
    message: `node does not satisfy its schema`,
    elementId: typeof node?.id === "string" ? node.id : "<unknown>",
    elementType: "node",
    details: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  });
}

function checkEdgeSchema(edge: GraphEdge, violations: GraphViolation[]): void {
  const parsed = GraphEdgeSchema.safeParse(edge);
  if (parsed.success) {
    return;
  }

  violations.push({
    code: "GRAPH_SCHEMA_INVALID",
    message: `edge does not satisfy its schema`,
    elementId: typeof edge?.id === "string" ? edge.id : "<unknown>",
    elementType: "edge",
    details: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  });
}

/**
 * A node whose stored ID is not what its own identity fields derive to has been
 * edited after the fact. That is the signature of someone rewriting history
 * rather than appending to it, so it is reported even though the node is
 * otherwise well formed.
 */
function checkNodeIdentity(node: GraphNode, violations: GraphViolation[]): void {
  let expected: string;
  try {
    expected = expectedNodeId(node);
  } catch {
    violations.push({
      code: "GRAPH_ID_MISMATCH",
      message: `node id ${node.id} could not be re-derived`,
      elementId: node.id,
      elementType: "node",
      details: [],
    });
    return;
  }

  if (expected !== node.id) {
    violations.push({
      code: "GRAPH_ID_MISMATCH",
      message: `node id ${node.id} does not match the id its identity fields derive to`,
      elementId: node.id,
      elementType: "node",
      details: [`expected ${expected}`],
    });
  }

  let parsedTenant: string | null = null;
  try {
    parsedTenant = parseGraphId(node.id).tenantId;
  } catch {
    parsedTenant = null;
  }

  if (parsedTenant !== null && parsedTenant !== node.tenantId) {
    violations.push({
      code: "GRAPH_TENANT_MISMATCH",
      message: `node id ${node.id} is scoped to tenant ${parsedTenant} but claims ${node.tenantId}`,
      elementId: node.id,
      elementType: "node",
      details: [],
    });
  }
}

/** Node attributes that point at other nodes, checked for dangling references. */
function checkNodeReferences(
  node: GraphNode,
  nodesById: ReadonlyMap<string, GraphNode>,
  violations: GraphViolation[],
): void {
  const references: { field: string; id: string; expectedKind?: GraphNode["kind"] }[] = [];

  if (node.kind !== "Source" && node.kind !== "Policy" && node.kind !== "Run") {
    references.push({ field: "runId", id: node.runId, expectedKind: "Run" });
  }

  if (node.kind === "Claim") {
    references.push({ field: "outputRef", id: node.outputRef, expectedKind: "Output" });
  }

  if (node.kind === "Verdict") {
    references.push({ field: "targetRef", id: node.targetRef });
  }

  for (const reference of references) {
    const target = nodesById.get(reference.id);
    if (target === undefined) {
      violations.push({
        code: "GRAPH_REFERENCE_MISSING",
        message: `${node.kind}.${reference.field} references missing node ${reference.id}`,
        elementId: node.id,
        elementType: "node",
        details: [],
      });
      continue;
    }

    if (reference.expectedKind !== undefined && target.kind !== reference.expectedKind) {
      violations.push({
        code: "GRAPH_REFERENCE_MISSING",
        message: `${node.kind}.${reference.field} references a ${target.kind}, expected a ${reference.expectedKind}`,
        elementId: node.id,
        elementType: "node",
        details: [],
      });
    }

    if (target.tenantId !== node.tenantId) {
      violations.push({
        code: "GRAPH_TENANT_MISMATCH",
        message: `${node.kind}.${reference.field} crosses from tenant ${node.tenantId} to ${target.tenantId}`,
        elementId: node.id,
        elementType: "node",
        details: [],
      });
    }
  }

  // Invariant 6: a verdict without its exact immutable policy version is not
  // auditable, because there is no way to establish what rule was applied.
  if (node.kind === "Verdict") {
    const policy = nodesById.get(node.policyRef);
    if (policy === undefined || policy.kind !== "Policy") {
      violations.push({
        code: "GRAPH_VERDICT_POLICY_MISSING",
        message: `verdict ${node.id} does not reference an existing policy version`,
        elementId: node.id,
        elementType: "node",
        details: [`policyRef ${node.policyRef}`],
      });
    } else if (policy.tenantId !== node.tenantId) {
      violations.push({
        code: "GRAPH_TENANT_MISMATCH",
        message: `verdict ${node.id} references a policy in tenant ${policy.tenantId}`,
        elementId: node.id,
        elementType: "node",
        details: [],
      });
    }
  }
}

function checkEdge(
  edge: GraphEdge,
  nodesById: ReadonlyMap<string, GraphNode>,
  violations: GraphViolation[],
): void {
  let expectedId: string | null = null;
  try {
    expectedId = expectedEdgeId(edge);
  } catch {
    expectedId = null;
  }

  if (expectedId !== edge.id) {
    violations.push({
      code: "GRAPH_ID_MISMATCH",
      message: `edge id ${edge.id} does not match the id its type and endpoints derive to`,
      elementId: edge.id,
      elementType: "edge",
      details: expectedId === null ? [] : [`expected ${expectedId}`],
    });
  }

  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);

  for (const [label, endpoint, id] of [
    ["from", from, edge.from],
    ["to", to, edge.to],
  ] as const) {
    if (endpoint === undefined) {
      violations.push({
        code: "GRAPH_EDGE_ENDPOINT_MISSING",
        message: `${edge.type} edge ${label} endpoint ${id} is not in the graph`,
        elementId: edge.id,
        elementType: "edge",
        details: [],
      });
    }
  }

  if (from === undefined || to === undefined) {
    return;
  }

  if (!isEdgePairPermitted(edge.type, from.kind, to.kind)) {
    violations.push({
      code: "GRAPH_EDGE_TYPE_NOT_PERMITTED",
      message: `${edge.type} does not permit ${from.kind} -> ${to.kind}`,
      elementId: edge.id,
      elementType: "edge",
      details: [],
    });
  }

  if (from.tenantId !== edge.tenantId || to.tenantId !== edge.tenantId) {
    violations.push({
      code: "GRAPH_TENANT_MISMATCH",
      message: `${edge.type} edge in tenant ${edge.tenantId} joins ${from.tenantId} to ${to.tenantId}`,
      elementId: edge.id,
      elementType: "edge",
      details: [],
    });
  }

  if (isRunLocalEdgeType(edge.type)) {
    const fromRun = runOf(from);
    const toRun = runOf(to);

    // Only compared when both sides have a run: a Source or Policy endpoint
    // legitimately has none, and demanding one would forbid valid edges.
    if (fromRun !== null && toRun !== null && fromRun !== toRun) {
      violations.push({
        code: "GRAPH_RUN_MISMATCH",
        message: `${edge.type} is run-local but joins run ${fromRun} to run ${toRun}`,
        elementId: edge.id,
        elementType: "edge",
        details: [],
      });
    }
  }
}

/**
 * Detects cycles across all acyclic edge types at once.
 *
 * The current edge matrix cannot express a cycle spanning both types — once a
 * traversal reaches a Chunk it can only reach Chunks — so today this is
 * equivalent to checking each type separately. It is written as one traversal
 * anyway: the matrix is data and will grow, and a future pair that lets a
 * traversal return to Artifact would silently reintroduce non-terminating
 * backward traversal if the check were per-type.
 *
 * Iterative rather than recursive so a long derivation chain cannot overflow
 * the stack — the failure mode would be a crash on the largest real graphs.
 */
function checkAcyclic(
  edges: readonly GraphEdge[],
  nodesById: ReadonlyMap<string, GraphNode>,
  violations: GraphViolation[],
): void {
  const adjacency = new Map<string, string[]>();
  const edgeFor = new Map<string, GraphEdge>();

  for (const edge of edges) {
    if (!isAcyclicEdgeType(edge.type)) {
      continue;
    }
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) {
      continue;
    }

    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
    edgeFor.set(`${edge.from} ${edge.to}`, edge);
  }

  for (const targets of adjacency.values()) {
    targets.sort();
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const reported = new Set<string>();

  for (const root of [...adjacency.keys()].sort()) {
    if ((colour.get(root) ?? WHITE) !== WHITE) {
      continue;
    }

    const stack: { node: string; next: number }[] = [{ node: root, next: 0 }];
    colour.set(root, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { node: string; next: number };
      const targets = adjacency.get(frame.node) ?? [];

      if (frame.next >= targets.length) {
        colour.set(frame.node, BLACK);
        stack.pop();
        continue;
      }

      const target = targets[frame.next] as string;
      frame.next += 1;

      const targetColour = colour.get(target) ?? WHITE;
      if (targetColour === GREY) {
        const edge = edgeFor.get(`${frame.node} ${target}`);
        const id = edge?.id ?? `${frame.node}->${target}`;
        if (!reported.has(id)) {
          reported.add(id);
          violations.push({
            code: "GRAPH_CYCLE_DETECTED",
            message: `${edge?.type ?? "acyclic"} edge closes a cycle at ${target}`,
            elementId: id,
            elementType: "edge",
            details: [`${frame.node} -> ${target}`],
          });
        }
        continue;
      }

      if (targetColour === WHITE) {
        colour.set(target, GREY);
        stack.push({ node: target, next: 0 });
      }
    }
  }
}

/**
 * Invariant 4: a claim may not rest on a chunk the effective policy refused.
 *
 * "Effective" is doing real work. In monitor mode the policy recorded a block
 * and the material was delivered anyway, so the chunk was not actually kept
 * out of context and a claim resting on it is a true record of what happened,
 * not a corrupt one. Treating a monitored block as effective would flood a
 * monitor-mode rollout with violations that describe the tool rather than the
 * system under test.
 */
function checkSupportFromBlockedChunks(
  edges: readonly GraphEdge[],
  nodesById: ReadonlyMap<string, GraphNode>,
  violations: GraphViolation[],
): void {
  const refused = new Set<string>();

  for (const node of nodesById.values()) {
    if (node.kind === "Chunk" && !node.admitted) {
      refused.add(node.id);
    }
  }

  for (const node of nodesById.values()) {
    if (node.kind !== "Verdict" || node.monitored || node.decision === "allow") {
      continue;
    }

    const target = nodesById.get(node.targetRef);
    if (target?.kind === "Chunk") {
      refused.add(target.id);
    }
  }

  for (const edge of edges) {
    if (edge.type !== "SUPPORTED_BY" || !refused.has(edge.to)) {
      continue;
    }

    violations.push({
      code: "GRAPH_SUPPORT_FROM_BLOCKED_CHUNK",
      message: `claim ${edge.from} is supported by chunk ${edge.to}, which the effective policy refused`,
      elementId: edge.id,
      elementType: "edge",
      details: [],
    });
  }
}

/**
 * Invariant 5: a delivered material claim has support, unless a verdict records
 * that a policy allowed it anyway.
 *
 * The exception is deliberately a verdict rather than a flag on the claim: a
 * verdict names the exact immutable policy version that permitted the delivery,
 * so an exception is always attributable. A boolean would let an unsupported
 * claim be waved through with nothing recording who decided that.
 *
 * A monitored verdict counts as a recorded explanation too. In monitor mode an
 * unsupported claim is delivered by design — that is what monitor mode is — and
 * the ledger is not corrupt for saying so: it records both that the claim
 * reached the user and that a named policy version blocked it without
 * enforcement. Treating that as invalid would mark every monitor-mode run
 * broken, which is the rollout path docs/LIMITATIONS.md recommends. The
 * unsupported delivery is a finding for monitor reporting, not a defect in the
 * record of it. This is the same reasoning applied to invariant 4 above.
 */
function checkDeliveredClaimsAreSupported(
  edges: readonly GraphEdge[],
  nodesById: ReadonlyMap<string, GraphNode>,
  violations: GraphViolation[],
): void {
  const supported = new Set<string>();
  for (const edge of edges) {
    if (edge.type === "SUPPORTED_BY") {
      supported.add(edge.from);
    }
  }

  const explainedByPolicy = new Set<string>();
  for (const node of nodesById.values()) {
    if (node.kind !== "Verdict") {
      continue;
    }
    if (node.decision === "allow" || node.monitored) {
      explainedByPolicy.add(node.targetRef);
    }
  }

  for (const node of nodesById.values()) {
    if (node.kind !== "Claim" || !node.material) {
      continue;
    }

    const output = nodesById.get(node.outputRef);
    if (output?.kind !== "Output" || !output.delivered) {
      continue;
    }

    if (supported.has(node.id) || explainedByPolicy.has(node.id)) {
      continue;
    }

    violations.push({
      code: "GRAPH_CLAIM_UNSUPPORTED_DELIVERY",
      message: `material claim ${node.id} was delivered with no support and no recorded policy exception`,
      elementId: node.id,
      elementType: "node",
      details: [`output ${output.id}`],
    });
  }
}

/**
 * Stable ordering so that identical graphs produce identical reports regardless
 * of the order elements were supplied. Without this the CLI's `graph validate`
 * output could not be diffed between runs, which is most of what it is for.
 */
function sortViolations(violations: readonly GraphViolation[]): readonly GraphViolation[] {
  return [...violations].sort((left, right) => {
    return (
      left.code.localeCompare(right.code) ||
      left.elementType.localeCompare(right.elementType) ||
      left.elementId.localeCompare(right.elementId) ||
      left.message.localeCompare(right.message) ||
      left.details.join("|").localeCompare(right.details.join("|"))
    );
  });
}
