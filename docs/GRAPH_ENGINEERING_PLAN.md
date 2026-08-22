# Graph engineering plan

## Why a graph

Provenance is a relationship problem. A flat verdict says a claim was blocked; a lineage
graph shows which source produced which artifact, which step transformed it, which chunks
entered context, which claims depended on them, which policy evaluated them, and which
outputs were affected. The graph is evidence structure, not truth by connectivity.

## Canonical model

Nodes: `Source`, `Run`, `Step`, `Artifact`, `Chunk`, `Claim`, `Policy`, `Verdict`, and
`Output`. Every node has a tenant-scoped stable ID and schema version.

Edges: `PRODUCED`, `CONSUMED`, `DERIVED_FROM`, `SPLIT_INTO`, `EXTRACTED_FROM`,
`SUPPORTED_BY`, `CONTRADICTED_BY`, `EVALUATED_BY`, `DECIDES`, and `INCLUDED_IN`.

## Required invariants

1. IDs are deterministic and collision-resistant.
2. Edge endpoints exist and satisfy tenant/run boundaries.
3. `DERIVED_FROM` and `SPLIT_INTO` cannot create cycles.
4. `SUPPORTED_BY` cannot target a chunk blocked by the effective policy.
5. A delivered material claim has support unless policy records an allowed exception.
6. Every verdict references the exact immutable policy version used.
7. Exports redact raw secret material by default.
8. Replaying the same ordered audit produces an equivalent canonical graph.

## Required traversals

- **Trace:** return deterministic backward paths from claim/output to sources.
- **Explain:** return target, verdict, policy, reasons, method, and minimal decision paths.
- **Impact:** return direct and transitive dependent claims, outputs, and runs.
- **Validate:** return all schema, endpoint, edge-matrix, isolation, cycle, and decision
  violations with stable codes.

## Storage sequence

1. Pure typed graph model and validator.
2. In-memory store used by core tests and CLI.
3. Canonical JSON/JSONL import and export.
4. Adapter contract with capabilities and transaction boundary.
5. Neo4j adapter and Docker Compose demonstration.

Neo4j remains optional. Core guards cannot require a network, key, database, or model.
Use parameterized Cypher, tenant-scoped constraints, common lookup indexes, atomic audit
ingestion, cross-tenant query protection, and the same conformance suite as memory storage.

## Performance evaluation

Measure graph construction, validation, serialization, database ingestion, trace/explain/
impact traversal by graph size/depth, and added request-path latency. Report median and p95
on declared fixtures; optimize only after measuring a bottleneck.

## Safe self-improvement loop

The loop may improve fixtures and versioned policies, never rewrite historical facts:

1. Collect monitor-mode false blocks, misses, and uncertain claims.
2. Redact and normalize them into candidate scenarios.
3. Cluster failures using graph structure and reason codes.
4. Propose a policy or deterministic detector change.
5. Run historical and adversarial benchmarks.
6. Reject regressions automatically.
7. Require human approval to activate the policy.
8. Record policy and evaluation lineage in the graph.

An agent can propose repeatedly; it cannot promote its own production policy.
