# Changelog

Notable changes to Provenance Guard. Dates are the merge date on `main`.

## [0.1.0] — unreleased

Not yet tagged. `docs/PRODUCT_SPEC.md` requires a tagged release to follow independent engineering review, and that has not happened. See `docs/REVIEW.md`.

### Added

- **Lineage graph** (`@provguard/graph`): nine node kinds, ten edge types, deterministic tenant-scoped identity, and the edge matrix as data (#32).
- **Invariant validator** reporting every violation with a stable `GRAPH_*` code, plus adversarial fixtures covering each code and five near misses that must stay silent (#34).
- **Graph builder** from neutral guard audit records (#38).
- **In-memory store, canonical JSON/JSONL, and redacted export** (#40).
- **`trace` and `explain` traversals** (#42) and **`impact`** (#44).
- **CLI `trace`, `explain`, `impact`, `graph validate`**, and `check --graph` (#46).
- **Storage adapter contract and conformance suite** (#48).
- **Neo4j adapter** and Docker Compose demonstration, passing the same conformance suite (#50).
- **Framework-neutral monitor/enforce middleware** (`@provguard/middleware`) (#52).
- **Instrumentation hooks, performance harness, and CI evidence artifacts** (#54).
- **Mixed-content scenario tier** (#56).
- **Apache-2.0 licence**, `NOTICE`, and the governing documents, which previously existed only outside the repository (#36).
- Documentation: architecture, threat model, integration guide, worked incident, Neo4j adapter, performance, review record.

### Changed

- **README and `docs/LIMITATIONS.md` reconciled with measured results** (#30). The README had reported ten scenarios all passing for a corpus that had grown to 22 with five failures, and its quickstart did not run.
- Invariant 5 treats a **monitored** verdict as a recorded explanation for an unsupported delivery, so a monitor-mode run does not validate as corrupt (#38).
- **`Source.uri` credentials are stripped at node creation** rather than redacted on export, because an export filter only protects copies that pass through it — and because `uri` is an identity field, so redacting it would have made every redacted export fail validation (#40).
- Only the **basic** tier gates the `bench` exit code; `hard` and `mixed` are measurement tiers whose failures are the point (#56).

### Measured results

Basic derived 6/6. Basic constructed 2/2. Hard constructed 3/8. Mixed constructed 2/4.

False positives: 0/2 basic, 0/4 hard, **1/2 mixed**.

`mixed-clean-quoted-error` — a genuine incident postmortem quoting an HTTP 503 — is **blocked**. `docs/LIMITATIONS.md` predicted this over-blocking failure before any scenario exercised it. It is recorded as contradicting the claim that the guards do not over-block.

`hard-split-conjunction` blocks via `CLAIM_UNVERIFIABLE` because its second sentence is pronoun-heavy, **not** because the fabricated causal relationship was detected. `mixed-cross-sentence-both-grounded` covers the case where both halves ground cleanly, and it fails.

### Known gaps

Seven failing block-scenarios, one confirmed false positive, unmeasured guard latency, uncharacterised Neo4j ingestion performance, no security disclosure process, and no schema migration tooling. All are documented in `docs/LIMITATIONS.md`, `docs/THREAT_MODEL.md`, and `docs/REVIEW.md` rather than being left for a reader to discover.

### Remediation of the second-pass audit (unreleased)

Fixes for every finding in `docs/SECOND_PASS_AUDIT.md`. Evidence in
`docs/REMEDIATION_REPORT.md`. Version remains **0.1.0, unreleased**.

- **Packaging** (#61) — explicit `files` allowlist on all nine publishable
  packages, full publish metadata, per-package README and LICENSE, and a
  clean-room pack-install-import verifier in CI. Previously `npm pack` omitted
  `dist/` entirely and did not rewrite `workspace:*` ranges; `pnpm pack` did
  both correctly, so correctness depended on the publishing tool.
- **Benchmark** (#63) — the hardcoded disabled baseline is replaced by a
  measured differential: every scenario runs guarded and against an executed
  control, and `guard_effect` reports whether the guards changed the outcome.
  Guarded rates are unchanged.
- **Graph imports** (#65) — graph documents are validated for schema, identity,
  tenant and run scope before any state is mutated; rejected loads are atomic.
- **Neo4j** (#69) — stored material is redacted by default; raw persistence is
  an explicit opt-in that only a literal boolean enables.
- **CLI** (#68) — filesystem and parse failures produce stable codes, actionable
  messages and documented exit codes, with no stack trace by default.
