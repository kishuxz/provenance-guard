# Provenance Guard product specification

## Product promise

Provenance Guard blocks invalid evidence before context assembly, refuses material claims
that cannot be traced to admitted evidence, and records an inspectable lineage graph for
every decision.

The primary user is an engineer operating a tool-using agent, RAG pipeline, or automated
reporting system. The primary adoption path is a framework-neutral TypeScript library and
CLI. Framework adapters are integrations, not the core product.

## Required user journeys

### Check one candidate delivery

Given a slot, candidate chunks, and candidate output, return allow/block/monitor outcome,
stable reason codes, admitted and rejected chunks, extracted claims and grounding
decisions, a trace identifier, and a lineage graph or persisted graph reference.

### Explain a verdict

Given a verdict or claim identifier, return the shortest evidence path and the exact policy
decision. Explanations come from recorded graph facts, not newly generated prose presented
as fact.

### Trace backward

Given an output or claim, traverse backward through claim, agent step, admitted chunk,
artifact, tool call, and original source.

### Analyze downstream impact

Given a rejected or invalidated artifact, find every output, claim, and run that directly
or transitively depends on it.

### Roll out safely

Run policies in monitor-only mode, compare would-block outcomes, and switch to enforcement
without changing recorded decision semantics.

## Public interfaces

The release provides typed TypeScript APIs and CLI commands for `check`, `bench`, `trace`,
`explain`, and `impact`; deterministic JSON output; a storage-neutral graph interface; a
zero-infrastructure in-memory/JSON implementation; one graph database adapter; and
versioned persisted schemas with migration guidance.

## Non-goals for v0.1

- Autonomous retraining of foundation models.
- A general web fact checker or prompt-injection detector.
- Replacing observability or distributed tracing.
- Claiming truth from graph connectivity alone.
- Requiring a hosted LLM, graph database, or cloud account.

## Quality requirements

- Offline core behavior is deterministic and serialization is stable.
- Malformed records fail closed with typed errors.
- Every edge references existing, tenant-compatible nodes.
- Declared acyclic relationships cannot contain cycles.
- Decisions record policy version, method, timestamp, and relevant input hashes.
- Benchmark reports separate derived, constructed, control, and difficulty categories.
- Performance claims include fixture, runtime environment, median, and p95.

## v0.1 release criteria

- README matches the implemented hard-scenario harness and judge.
- Root quickstart succeeds from a clean clone.
- Repository has accurate description, topics, and an explicitly selected license.
- Graph schemas, invariants, serialization, and in-memory traversal are implemented.
- `trace`, `explain`, and `impact` work through library and CLI.
- A database adapter and local demonstration are documented and integration-tested.
- CI publishes benchmark and test evidence.
- Architecture, threat model, limitations, integration guide, and a worked incident exist.
- Monitor and enforce modes are demonstrated end to end.
- A tagged release follows independent engineering review.
