import type { ReasonCode } from "@provguard/schema";

import type { EdgeType, GraphEdge } from "./edges.js";
import type { GraphNode, PolicyNode, SourceNode, VerdictNode } from "./nodes.js";
import type { MemoryGraphStore } from "./store.js";

/**
 * How to walk one step toward origin.
 *
 * "Backward" is not "reverse every edge", and treating it that way silently
 * produces forward paths that read like provenance. `SUPPORTED_BY` runs claim
 * to chunk, so backward from a claim follows it outgoing. `SPLIT_INTO` runs
 * artifact to chunk, so backward from a chunk follows it incoming. The two
 * directions live in one table for the same reason the edge matrix does: this
 * is a contract several readers have to agree on.
 */
export const BACKWARD_STEPS: readonly { type: EdgeType; direction: "outgoing" | "incoming" }[] = [
  /** An output rests on the claims extracted from it. */
  { type: "EXTRACTED_FROM", direction: "incoming" },
  /** A claim rests on the chunks offered as evidence for it. */
  { type: "SUPPORTED_BY", direction: "outgoing" },
  /** A chunk came out of the artifact it was split from. */
  { type: "SPLIT_INTO", direction: "incoming" },
  /** A chunk or artifact may descend from an earlier one. */
  { type: "DERIVED_FROM", direction: "outgoing" },
  /** An artifact was produced by a step or a source. */
  { type: "PRODUCED", direction: "incoming" },
];

export interface TracePath {
  /** Node IDs from the target back to a terminal, inclusive of both. */
  readonly nodes: readonly string[];
  /** Edge IDs joining them, one shorter than `nodes`. */
  readonly edges: readonly string[];
}

export interface TraceResult {
  readonly target: GraphNode;
  readonly paths: readonly TracePath[];
  /** Distinct `Source` nodes any path reached, sorted by ID. */
  readonly sources: readonly SourceNode[];
  /** True when a bound stopped the walk, so the paths are not exhaustive. */
  readonly truncated: boolean;
}

export interface TraceOptions {
  readonly maxPaths?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_PATHS = 100;
const DEFAULT_MAX_DEPTH = 64;

/**
 * Returns the recorded backward paths from a claim or output to its sources.
 *
 * A returned path is evidence structure, not proof. The graph records that a
 * claim was offered a chunk as support; it does not record that the claim is
 * true, and nothing here should be read as saying so.
 */
export function trace(
  store: MemoryGraphStore,
  tenantId: string,
  targetId: string,
  options: TraceOptions = {},
): TraceResult {
  const target = store.requireNode(tenantId, targetId);
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const paths: TracePath[] = [];
  let truncated = false;

  // Depth-first with an explicit path stack. `visiting` prevents revisiting a
  // node already on the current path: validateGraph forbids cycles, but trace
  // must terminate on a graph that has not been validated, which is exactly
  // when you most want to look at it.
  const walk = (
    nodeId: string,
    nodeTrail: string[],
    edgeTrail: string[],
    visiting: Set<string>,
  ) => {
    if (paths.length >= maxPaths) {
      truncated = true;
      return;
    }

    if (nodeTrail.length > maxDepth) {
      truncated = true;
      return;
    }

    const next = backwardNeighbours(store, tenantId, nodeId).filter(
      (candidate) => !visiting.has(candidate.to),
    );

    if (next.length === 0) {
      // Terminal: nothing further to rest on. A single-node path is still a
      // path — it records that the target rests on nothing, which is a fact.
      paths.push({ nodes: [...nodeTrail], edges: [...edgeTrail] });
      return;
    }

    for (const candidate of next) {
      visiting.add(candidate.to);
      nodeTrail.push(candidate.to);
      edgeTrail.push(candidate.edge.id);

      walk(candidate.to, nodeTrail, edgeTrail, visiting);

      edgeTrail.pop();
      nodeTrail.pop();
      visiting.delete(candidate.to);
    }
  };

  walk(targetId, [targetId], [], new Set([targetId]));

  const sorted = sortPaths(paths);
  const sources = collectSources(store, tenantId, sorted);

  return { target, paths: sorted, sources, truncated };
}

export interface Explanation {
  readonly target: GraphNode;
  /** The verdict that decided this target, or `null` when none was recorded. */
  readonly verdict: VerdictNode | null;
  /** The exact immutable policy version the verdict used. */
  readonly policy: PolicyNode | null;
  readonly reasonCodes: readonly ReasonCode[];
  readonly method: VerdictNode["method"] | null;
  /** Whether the policy was in monitor mode when this was decided. */
  readonly monitored: boolean | null;
  /** The shortest recorded backward paths. Empty when the target rests on nothing. */
  readonly decisionPaths: readonly TracePath[];
  readonly sources: readonly SourceNode[];
}

/**
 * Returns the recorded facts behind a decision.
 *
 * Deliberately structural. `docs/PRODUCT_SPEC.md` requires explanations to come
 * from recorded graph facts rather than newly generated prose presented as
 * fact, so there is no summary string here: a sentence assembled by this
 * library would be indistinguishable downstream from a model-written one, and a
 * provenance tool that emits unattributable prose about provenance defeats
 * itself. Rendering is the caller's job.
 *
 * Every field is `null` rather than invented when the graph does not record it.
 */
export function explain(
  store: MemoryGraphStore,
  tenantId: string,
  targetId: string,
  options: TraceOptions = {},
): Explanation {
  const traced = trace(store, tenantId, targetId, options);
  const verdict = verdictFor(store, tenantId, targetId);
  const policy =
    verdict === null ? null : (store.node(tenantId, verdict.policyRef) as PolicyNode | undefined);

  return {
    target: traced.target,
    verdict,
    policy: policy?.kind === "Policy" ? policy : null,
    reasonCodes: verdict?.reasonCodes ?? [],
    method: verdict?.method ?? null,
    monitored: verdict?.monitored ?? null,
    decisionPaths: shortestPaths(traced.paths),
    sources: traced.sources,
  };
}

/**
 * The verdict deciding `targetId`.
 *
 * When more than one was recorded the lowest ID wins, so the answer is stable.
 * Multiple verdicts on one target is not itself an error — a target can be
 * evaluated by successive policy versions — so this picks deterministically
 * rather than refusing.
 */
function verdictFor(
  store: MemoryGraphStore,
  tenantId: string,
  targetId: string,
): VerdictNode | null {
  for (const edge of store.incoming(tenantId, targetId, "DECIDES")) {
    const node = store.node(tenantId, edge.from);
    if (node?.kind === "Verdict") {
      return node;
    }
  }

  return null;
}

interface Neighbour {
  readonly to: string;
  readonly edge: GraphEdge;
}

function backwardNeighbours(
  store: MemoryGraphStore,
  tenantId: string,
  nodeId: string,
): Neighbour[] {
  const found: Neighbour[] = [];

  for (const step of BACKWARD_STEPS) {
    const edges =
      step.direction === "outgoing"
        ? store.outgoing(tenantId, nodeId, step.type)
        : store.incoming(tenantId, nodeId, step.type);

    for (const edge of edges) {
      found.push({ to: step.direction === "outgoing" ? edge.to : edge.from, edge });
    }
  }

  // Sorted by edge ID, which is derived and therefore stable, so path order
  // does not depend on how the store happened to be loaded.
  return found.sort((left, right) => left.edge.id.localeCompare(right.edge.id));
}

function collectSources(
  store: MemoryGraphStore,
  tenantId: string,
  paths: readonly TracePath[],
): SourceNode[] {
  const sources = new Map<string, SourceNode>();

  for (const path of paths) {
    for (const nodeId of path.nodes) {
      const node = store.node(tenantId, nodeId);
      if (node?.kind === "Source") {
        sources.set(node.id, node);
      }
    }
  }

  return [...sources.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** All paths of minimal length, so "minimal decision path" is not one arbitrary pick. */
function shortestPaths(paths: readonly TracePath[]): TracePath[] {
  if (paths.length === 0) {
    return [];
  }

  const shortest = Math.min(...paths.map((path) => path.nodes.length));
  return paths.filter((path) => path.nodes.length === shortest);
}

function sortPaths(paths: readonly TracePath[]): TracePath[] {
  return [...paths].sort((left, right) => {
    return (
      left.nodes.length - right.nodes.length ||
      left.nodes.join(">").localeCompare(right.nodes.join(">"))
    );
  });
}
