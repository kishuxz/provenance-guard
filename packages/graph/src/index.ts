export {
  GraphViolationCodes,
  GraphError,
  isGraphViolationCode,
  type GraphViolationCode,
} from "./codes.js";

export {
  GRAPH_SCHEMA_VERSION,
  assertTenantId,
  contentDigest,
  deriveGraphId,
  isIdForTenant,
  parseGraphId,
  type IdentityFields,
  type IdentityValue,
  type ParsedGraphId,
} from "./ids.js";

export {
  ArtifactNodeSchema,
  ChunkNodeSchema,
  ClaimNodeSchema,
  GraphNodeSchema,
  NodeKinds,
  OutputNodeSchema,
  PolicyNodeSchema,
  REDACTABLE_ATTRIBUTES,
  RunNodeSchema,
  SourceNodeSchema,
  StepNodeSchema,
  VerdictNodeSchema,
  createNode,
  expectedNodeId,
  stripCredentials,
  identityFields,
  runOf,
  type ArtifactNode,
  type ChunkNode,
  type ClaimNode,
  type GraphNode,
  type GraphNodeInput,
  type NodeKind,
  type OutputNode,
  type PolicyNode,
  type RunNode,
  type SourceNode,
  type StepNode,
  type VerdictNode,
} from "./nodes.js";

export {
  buildGraph,
  type RunAudit,
  type RunAuditChunk,
  type RunAuditClaim,
  type RunAuditPolicy,
} from "./build.js";

export {
  validateGraph,
  type GraphInput,
  type GraphViolation,
  type ValidationReport,
} from "./validate.js";

export { baselineGraph, graphFixtures, type GraphFixture } from "./fixtures.js";

export {
  REDACTED,
  fromCanonicalJSON,
  fromJSONL,
  toCanonicalJSON,
  toJSONL,
  type SerializeOptions,
} from "./serialize.js";

export { MemoryGraphStore } from "./store.js";

export {
  MemoryGraphAdapter,
  conformanceCases,
  type ConformanceCase,
  type GraphStoreAdapter,
  type GraphStoreCapabilities,
} from "./adapter.js";

export {
  FORWARD_STEPS,
  impact,
  type AffectedNode,
  type ImpactOptions,
  type ImpactResult,
} from "./impact.js";

export {
  BACKWARD_STEPS,
  explain,
  trace,
  type Explanation,
  type TraceOptions,
  type TracePath,
  type TraceResult,
} from "./trace.js";

export {
  ACYCLIC_EDGE_TYPES,
  EDGE_MATRIX,
  EdgeTypes,
  GraphEdgeSchema,
  RUN_LOCAL_EDGE_TYPES,
  createEdge,
  expectedEdgeId,
  isAcyclicEdgeType,
  isEdgePairPermitted,
  isRunLocalEdgeType,
  type EdgePair,
  type EdgeType,
  type GraphEdge,
  type GraphEdgeInput,
} from "./edges.js";

export {
  measure,
  perfFixture,
  type PerfFixture,
  type PerfMeasurement,
  type PerfReport,
} from "./perf.js";
