# Autonomous execution plan

## Control loop

Conductor operates a bounded loop:

```text
inspect -> select -> specify -> test -> implement -> verify -> adversarial review
        -> repair -> PR -> CI -> merge -> re-inspect
```

Passing tests are necessary but not sufficient. Review compares behavior to the product
specification and limitations, searches for misleading provenance, and adds a regression
test for every confirmed defect.

## Work graph

Each node becomes a focused issue and PR; do not use one giant branch.

| ID  | Work item                                                          | Depends on     | Owner mode            |
| --- | ------------------------------------------------------------------ | -------------- | --------------------- |
| P0  | Reconcile README, package inventory, quickstart, and current bench | —              | single writer         |
| P1  | Metadata, license decision, architecture, and threat model         | —              | writer + review       |
| G1  | Graph schemas, IDs, reason codes, and public types                 | P0             | single writer         |
| G2  | Graph builder from inbound/outbound audit records                  | G1             | single writer         |
| G3  | Invariant validator and adversarial fixtures                       | G1             | isolated lane         |
| G4  | In-memory store and canonical JSON/JSONL                           | G1, G3         | isolated lane         |
| Q1  | Trace and explain traversals                                       | G2, G4         | isolated lane         |
| Q2  | Impact and invalidation traversal                                  | G2, G4         | isolated lane         |
| C1  | CLI `trace`, `explain`, `impact`, `graph validate`                 | Q1, Q2         | single writer         |
| N1  | Storage adapter contract and conformance suite                     | G4             | single writer         |
| N2  | Neo4j adapter and local Compose demo                               | N1             | isolated lane         |
| I1  | Framework-neutral monitor/enforce middleware                       | C1             | single writer         |
| O1  | OpenTelemetry and benchmark/CI artifacts                           | I1             | single writer         |
| E1  | Larger mixed/adversarial scenario corpus                           | G3             | parallel fixture lane |
| R1  | Security, correctness, DevEx, and claims review                    | required nodes | read-only lanes       |
| R2  | Version, changelog, clean-clone rehearsal, v0.1                    | R1             | single writer         |

Only start implementation nodes after dependencies merge. Read-only review or fixture
research can start earlier without editing shared contracts.

## Recommended lanes

- **Primary implementation:** sole writer for schemas, graph semantics, public exports,
  CLI contracts, root config, and CI.
- **Test/adversary:** develops counterexamples, near misses, malformed graphs, cycles,
  cross-tenant cases, and regression tests without rewriting core semantics in parallel.
- **Engineering review:** checks correctness, API design, complexity, compatibility, and
  performance; reports reproducible blocking findings.
- **Product/claims review:** checks docs and benchmark claims against measured evidence.
- **DevEx review:** performs the clean-clone workflow as a new user.
- **Ship:** runs only after reviews, reruns all gates, and never waives a failure.

## Evaluator questions

After each implementation, answer:

1. Does it satisfy every acceptance criterion?
2. Which public inputs were tested?
3. Can inputs produce nondeterministic IDs, order, or verdicts?
4. Can malformed or cross-tenant edges bypass validation?
5. Can connectivity be mistaken for factual truth?
6. Can an optional LLM change deterministic facts?
7. Are monitor and enforce semantics distinct and recorded?
8. Are claims generated from current code and evidence?
9. Is failure observable and recoverable?
10. Which regression test covers each confirmed defect?

Return work to implementation if any answer is unsupported.

## Stop and escalate

Request human direction for license selection, package publication/public release, changes
to core allow/block semantics, new paid/credential requirements, destructive graph-data
migration, unresolved safety-contract conflicts, critical/high security findings, or an
inability to run required infrastructure/verification. Ordinary bugs and test/CI failures
remain inside the repair loop.

## Final report

List merged issues/PRs in dependency order, package and command inventory, exact test and
benchmark results, performance fixture/environment, review findings, remaining documented
limitations, release URL, and clean-clone evidence.
