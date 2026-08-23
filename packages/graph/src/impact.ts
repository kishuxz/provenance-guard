import type { EdgeType } from "./edges.js";
import type { ClaimNode, GraphNode, OutputNode, RunNode } from "./nodes.js";
import type { MemoryGraphStore } from "./store.js";

/**
 * How to walk one step away from origin, toward what depended on it.
 *
 * Written as its own table rather than as a mechanical reversal of
 * `BACKWARD_STEPS`, so each direction can be read and reviewed on its own
 * terms. The two are near-mirrors today, and a future edge type that is
 * meaningful in only one direction should not have to be expressed as an
 * exception to the other.
 */
export const FORWARD_STEPS: readonly { type: EdgeType; direction: "outgoing" | "incoming" }[] = [
  /** A source's artifacts. */
  { type: "PRODUCED", direction: "outgoing" },
  /** An artifact's chunks. */
  { type: "SPLIT_INTO", direction: "outgoing" },
  /** Anything derived from this. */
  { type: "DERIVED_FROM", direction: "incoming" },
  /** The claims that rested on this chunk. */
  { type: "SUPPORTED_BY", direction: "incoming" },
  /** The output a claim came out of. */
  { type: "EXTRACTED_FROM", direction: "outgoing" },
];

export interface AffectedNode<T extends GraphNode = GraphNode> {
  readonly node: T;
  /** Edges traversed from the origin. 1 is a direct dependant. */
  readonly distance: number;
}

export interface ImpactResult {
  readonly origin: GraphNode;
  readonly claims: readonly AffectedNode<ClaimNode>[];
  readonly outputs: readonly AffectedNode<OutputNode>[];
  readonly runs: readonly AffectedNode<RunNode>[];
  /**
   * Affected outputs that were actually delivered.
   *
   * Kept separate because the difference decides what an incident is. An
   * unsupported claim on an output that was blocked never reached anyone;
   * folding it in with delivered outputs would turn "we have a bug" into "we
   * misled users" in every report.
   */
  readonly deliveredOutputs: readonly AffectedNode<OutputNode>[];
  readonly truncated: boolean;
}

export interface ImpactOptions {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_DEPTH = 64;

/**
 * Returns everything recorded as depending on `originId`.
 *
 * Reports dependants only. What to do about them — retract, re-run, notify — is
 * policy this deliberately does not decide.
 */
export function impact(
  store: MemoryGraphStore,
  tenantId: string,
  originId: string,
  options: ImpactOptions = {},
): ImpactResult {
  const origin = store.requireNode(tenantId, originId);
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  // Breadth-first, so the first time a node is reached is by a shortest path
  // and its recorded distance is the true one. A depth-first walk would report
  // whichever distance it happened to arrive by.
  const distances = new Map<string, number>();
  let queue: string[] = [originId];
  let depth = 0;
  let truncated = false;

  distances.set(originId, 0);

  while (queue.length > 0) {
    if (depth >= maxDepth) {
      truncated = true;
      break;
    }

    const next: string[] = [];
    depth += 1;

    for (const nodeId of queue) {
      for (const neighbour of forwardNeighbours(store, tenantId, nodeId)) {
        if (distances.has(neighbour)) {
          continue;
        }

        if (distances.size >= maxNodes) {
          truncated = true;
          break;
        }

        distances.set(neighbour, depth);
        next.push(neighbour);
      }

      if (truncated) {
        break;
      }
    }

    if (truncated) {
      break;
    }

    queue = next;
  }

  distances.delete(originId);

  const claims: AffectedNode<ClaimNode>[] = [];
  const outputs: AffectedNode<OutputNode>[] = [];
  const runs = new Map<string, AffectedNode<RunNode>>();

  for (const [nodeId, distance] of distances) {
    const node = store.node(tenantId, nodeId);
    if (node === undefined) {
      continue;
    }

    if (node.kind === "Claim") {
      claims.push({ node, distance });
    } else if (node.kind === "Output") {
      outputs.push({ node, distance });
    }

    // A run is affected when anything inside it is. Recorded at the smallest
    // distance of any affected member, so a run touched directly and again
    // transitively reports the direct hop.
    const runId = runIdOf(node);
    if (runId !== null) {
      const run = store.node(tenantId, runId);
      if (run?.kind === "Run") {
        const existing = runs.get(run.id);
        if (existing === undefined || distance < existing.distance) {
          runs.set(run.id, { node: run, distance });
        }
      }
    }
  }

  return {
    origin,
    claims: sortAffected(claims),
    outputs: sortAffected(outputs),
    runs: sortAffected([...runs.values()]),
    deliveredOutputs: sortAffected(outputs.filter((entry) => entry.node.delivered)),
    truncated,
  };
}

function runIdOf(node: GraphNode): string | null {
  switch (node.kind) {
    case "Source":
    case "Policy":
    case "Run":
      return null;
    default:
      return node.runId;
  }
}

function forwardNeighbours(store: MemoryGraphStore, tenantId: string, nodeId: string): string[] {
  const found: string[] = [];

  for (const step of FORWARD_STEPS) {
    const edges =
      step.direction === "outgoing"
        ? store.outgoing(tenantId, nodeId, step.type)
        : store.incoming(tenantId, nodeId, step.type);

    for (const edge of edges) {
      found.push(step.direction === "outgoing" ? edge.to : edge.from);
    }
  }

  return found.sort();
}

function sortAffected<T extends GraphNode>(entries: AffectedNode<T>[]): AffectedNode<T>[] {
  return entries.sort(
    (left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id),
  );
}
