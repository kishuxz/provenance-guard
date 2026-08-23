# v0.1 review record

## The most important thing on this page

**This review was performed by the same agent that wrote the code.** `docs/PRODUCT_SPEC.md` requires a tagged release to follow _independent_ engineering review. That has not happened.

Everything below is a self-review. It is worth what a self-review is worth: it catches mechanical problems and misses the ones the author cannot see. `docs/LIMITATIONS.md` §1 makes the same argument about the benchmark — an author writing both the attacks and the detectors measures their own consistency — and it applies here with equal force. **The independent-review criterion is open.**

## Clean-clone rehearsal

Fresh `git clone` at `9f45234`, no cached state, on Node v20.20.2 / darwin-arm64.

| Gate                               | Result                           |
| ---------------------------------- | -------------------------------- |
| `pnpm install --frozen-lockfile`   | pass                             |
| `pnpm build`                       | pass                             |
| `pnpm typecheck`                   | pass                             |
| `pnpm lint`                        | pass                             |
| `pnpm format`                      | pass                             |
| `pnpm test`                        | 413 passed, 22 skipped, 24 files |
| `pnpm exec provguard bench --json` | exit 0                           |

The 22 skips are the Neo4j integration tests, which skip without a reachable database by design. CI runs them against a real service container and asserts the suite executed — the most recent run reports `neo4j integration suite: 22/22 passed`.

Beyond the gate, in the same clean clone: `pnpm perf`, `pnpm --filter @provguard/demo demo`, the README's `check` example (reproduced its documented output byte-for-byte, exit 1), `check --graph`, `trace`, `explain`, `impact`, and `graph validate` all ran as documented.

## Claims review

- **README bench block is byte-identical to generated output** in the clean clone, verified by comparison, and pinned by a test that fails the build on drift.
- Reported rates: basic derived 6/6, basic constructed 2/2, hard constructed 3/8, mixed constructed 2/4. False positives 0/2 basic, 0/4 hard, **1/2 mixed**.
- No performance number appears in the README. `docs/PERFORMANCE.md` carries fixture, environment, median, and p95 for every figure, and states what is not measured.
- No accuracy, false-positive-rate, or readiness claim beyond the fixed corpus was found.

## Security review

Checked, with the check rather than by assertion:

| Item                                                     | Result     |
| -------------------------------------------------------- | ---------- |
| Hardcoded credentials in source                          | none found |
| Network calls in core packages                           | none found |
| Core package depending on `@provguard/neo4j`             | none       |
| `TODO` / `not implemented` / placeholder implementations | none       |
| AI attribution in commits, PRs, or source                | none       |

The Docker Compose file contains `neo4j/provguardtest` for a local throwaway instance, labelled as such in the file and in `docs/NEO4J.md`. It is a development default, not a secret.

Controls verified by test rather than inspection: tenant isolation including neighbour lookups, ID forgery resistance, Cypher parameterisation, history-rewrite detection, credential stripping at node creation, redaction defaults, judge subordination, and telemetry failure isolation. See `docs/THREAT_MODEL.md`.

## Correctness findings from the build itself

These were found and fixed during the work, and are listed because a review that reports nothing found is not a review:

1. **The conformance suite's atomicity case was vacuous.** Its corrupt batch contained no element the store did not already hold, so a partial write was a no-op and a non-atomic adapter passed. Fixed by putting a genuinely new element ahead of the bad one, and pinned by an anti-vacuity test.
2. **The instrumentation tests passed for the wrong reason.** They asserted a blocked decision on an output with no entity or number, which extraction correctly finds nothing to ground.
3. **`parseArgs` ran outside `main`'s try/catch**, so a malformed CLI flag threw a stack trace instead of exiting 2.
4. **The builder stated one relationship twice** (`PRODUCED` and `DERIVED_FROM` between the same pair), producing two trace paths that rendered identically.
5. **Redaction conflicted with identity.** `Source.uri` was marked redactable but is an identity field, so every redacted export would have failed `GRAPH_ID_MISMATCH`.
6. **A cross-type cycle fixture was impossible** under the edge matrix; the claim in the comment was wrong and was corrected rather than the fixture forced.
7. **The monitor-mode criterion I first wrote for the middleware contradicted `docs/LIMITATIONS.md`**, in the flattering direction.

## Open findings

None at critical or high severity from this self-review.

Medium and below, all documented rather than fixed:

- **Independent review has not occurred.** Release criterion, open.
- **One confirmed false positive** on realistic input (`mixed-clean-quoted-error`). Documented in `docs/LIMITATIONS.md` as contradicting the "does not over-block" claim.
- **Seven failing block-scenarios** across the hard and mixed tiers, each a named, documented gap.
- **Guard request-path latency is unmeasured.** The number an adopter most needs.
- **Neo4j ingestion performance is uncharacterised.**
- **No security contact or disclosure process.**
- **No migration tooling** for a `GRAPH_SCHEMA_VERSION` bump.

## Release readiness

Every v0.1 criterion in `docs/PRODUCT_SPEC.md` is met **except** "a tagged release follows independent engineering review". That one cannot be satisfied by the author, and is the reason no tag has been created.
