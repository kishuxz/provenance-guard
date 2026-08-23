# Second-pass audit of the v0.1 release candidate

## This is not an independent review

**The author of this audit is the author of the implementation.** Every commit from #30 through #58 was written by the same agent that wrote this document.

This file was requested as `docs/INDEPENDENT_REVIEW.md`. It is not called that, and it must not be cited as satisfying the `docs/PRODUCT_SPEC.md` criterion "a tagged release follows independent engineering review". Creating a document whose _filename_ asserts independence, authored by the implementer, would be a false provenance claim published by a project whose stated purpose is preventing false provenance claims. `docs/REVIEW.md` already records that this criterion cannot be satisfied by the author, and nothing here changes that.

What this is: a deliberately hostile second pass by the author, looking for defects the first pass missed. It found two of high severity. That is evidence the method has some value and equally that it is not a substitute — both findings had been sitting in `main` through a self-review that declared no critical or high findings.

**The independent-review criterion remains open and requires a different party.**

## Commit reviewed

`f6c2695` — "docs: add architecture, threat model, integration guide, worked incident and review record (#58)", the tip of `main`.

## Environment

- Fresh `git clone` to `/tmp/pg-audit`, checked out at `f6c2695`, no cached state.
- Node v20.20.2, darwin arm64, pnpm 10.14.0.
- Commands: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm test`, `pnpm exec provguard bench --json`, `pnpm perf`, `npm pack --dry-run`, `pnpm audit`, plus targeted probe scripts reproduced below.

## Findings

### HIGH-1 — Every published package would be broken on install

`dist/` is excluded from the npm tarball. No package declares a `files` field and there is no `.npmignore`, so npm falls back to `.gitignore`, which lists `dist/`. The manifests point `main`/`types`/`exports` at `./dist/index.js`.

Reproduction, after a successful `pnpm build`:

```console
$ cd packages/cli && npm pack --dry-run
npm notice 47B    bin/provguard.js
npm notice 662B   package.json
npm notice 9.0kB  src/graph.ts
npm notice 27.8kB src/index.ts
npm notice 9.2kB  test/bench.test.ts
...
$ npm pack --dry-run 2>&1 | grep -c "dist/"
0
```

End-to-end proof that a consumer is broken:

```console
$ cd packages/schema && npm pack --pack-destination /tmp
$ cd /tmp/pg-consumer && npm install /tmp/provguard-schema-0.1.0.tgz
$ node -e "import('@provguard/schema')"
IMPORT FAILS: ERR_MODULE_NOT_FOUND Cannot find module
  '/private/tmp/pg-consumer/node_modules/@provguard/schema/dist/index.js'
```

Compounding: the tarball _does_ ship `src/` and `test/`, so consumers receive test files and TypeScript sources they did not ask for, while missing the code they did.

**Required fix.** Add `"files": ["dist"]` (plus `bin` for the CLI) to every publishable manifest, and add a packaging test that packs a workspace package, installs the tarball, and imports it. Nothing in the current suite would catch this, because every test runs against the workspace where `dist/` exists on disk.

### HIGH-2 — The "guards disabled" baseline is a hardcoded constant presented as a measurement

`packages/cli/src/index.ts:306` sets, for every scenario:

```ts
disabledBaseline: "miss",
shapeBaseline: shapeCheckCatches(scenario.simulatedOutput) ? "catch" : "miss",
```

and `summarizeBench` at line 341 returns `disabledBaselineCatches: 0` as a literal. No code path anywhere runs the pipeline with guards disabled — `grep -rn "disabled" packages/cli/src/index.ts` returns only the column header and these two constants.

The shape baseline beside it _is_ genuinely computed, which makes the asymmetry easy to miss.

This constant is then published as evidence. `README.md:112`:

> **Both baselines catch zero, on all twenty-eight.** With the guards disabled, nothing is caught, which is what the pipeline does today.

and the bench table carries a `guards_disabled` column reading `miss` on all 28 rows, in a results table where every neighbouring column is a measurement.

The value is not _wrong_ — with the guards disabled nothing blocks, so zero is correct by construction. That is exactly the problem: it is true by definition and presented as observed. `AGENTS.md` requires that claims not exceed evidence, and `docs/LIMITATIONS.md` spends a section arguing that a number whose provenance is not what it appears to be is worse than no number. This is that defect, in the project's most-read claim surface.

**Required fix.** Either compute it — run each scenario through a genuinely disabled pipeline and record the real outcome — or delete the column and the README claim and state plainly that a disabled pipeline blocks nothing by definition. Computing it is preferable: it converts an assertion into evidence and would catch a future regression where a "disabled" path stopped being disabled.

### MEDIUM-1 — Untrusted graph JSON is loaded into the store without validation

`MemoryGraphStore.load()` performs no validation. The CLI reads attacker-controllable JSON and constructs a store directly (`packages/cli/src/index.ts:694-695`) with no `validateGraph` call, unlike `graph validate` which does validate.

A node whose `id` encodes one tenant while its `tenantId` field names another is served to the second tenant:

```console
P1 store returns forged node to globex: true
P1 validateGraph flags it: GRAPH_ID_MISMATCH,GRAPH_TENANT_MISMATCH
P2 adapter refused: GRAPH_ID_MISMATCH
```

The supported ingest path is sound — `MemoryGraphAdapter.ingest` refuses it — and `trace`/`impact` reject a cross-tenant _argument_. The gap is the raw store trusting its input while its own doc comment says "every read is tenant-scoped", which oversells what a `tenantId`-field filter provides when that field is attacker-controlled.

Not high because reaching it requires supplying the graph, and in the CLI the supplier is the operator. It becomes high in any service that ingests third-party graph documents.

**Required fix.** Validate in `load()`, or refuse to construct a store from an unvalidated graph, or — at minimum — document the requirement in `docs/THREAT_MODEL.md` and have the CLI validate before loading.

### MEDIUM-2 — The Neo4j adapter persists unredacted material, undocumented

`packages/neo4j/src/index.ts` contains no redaction; `grep -n "redact"` returns nothing. Chunk, claim, and output text are written to the database verbatim.

This is defensible — a lineage store you cannot read is not useful — but `docs/NEO4J.md` never says so, and the surrounding documentation emphasises that exports redact by default. A reader who has absorbed "exports redact raw text by default" may reasonably assume storage does too.

**Required fix.** State it explicitly in `docs/NEO4J.md` and `docs/THREAT_MODEL.md`: the database holds raw material, and its access control is the operator's responsibility.

### MEDIUM-3 — Publishable packages lack `repository` and `description`

No package declares `repository` or `description`. Both are needed for npm provenance attestation and basic discoverability. Nine of ten packages are publishable (`@provguard/demo` is `private`).

**Required fix.** Add both to every publishable manifest before any publish.

### LOW-1 — One raw Node error reaches the user

`provguard trace <directory> x` prints `EISDIR: illegal operation on a directory, read`. Every other failure path produces a written message. Cosmetic; no stack trace leaks.

## What I checked and found sound

Reported so the scope of the audit is legible, not as reassurance.

- **Clean-clone gate**: install / build / typecheck / lint / format / test / `bench --json` all pass; 413 passed, 22 skipped, 24 files. The 22 skips are Neo4j tests skipping without a database, by design.
- **Monitor vs enforce**: fuzzed 50 input pairs across empty, whitespace, truncated, HTML-error, stack-trace, shell-diagnostic, degraded-payload and clean inputs. Decision and reason codes identical in every pair; monitor delivered in 50/50. No input found where monitor relaxes the policy.
- **Tenant isolation on supported paths**: `trace`/`impact` refuse a cross-tenant target; adapter refuses foreign-tenant and forged-ID batches.
- **Redaction**: a distinctive secret string is absent from redacted canonical JSON and present only with `redact: false`.
- **CLI failure handling**: malformed JSON, non-array `nodes`, missing `output`, non-array `chunks`, and unparseable graphs all produce written messages, not stack traces.
- **Test vacuity**: no test block lacks an assertion. The two anti-vacuity tests in the adapter suite genuinely fail deliberately-broken adapters.
- **Supply chain**: `pnpm audit` — no known vulnerabilities. Two direct runtime dependencies, `zod` and `neo4j-driver` (the latter only in the optional adapter). Lockfile consistent under `--frozen-lockfile`.
- **Benchmark rates**: reproduced from a clean clone; README block byte-identical to generated output.

## Decision

**BLOCK.**

Two high-severity findings. HIGH-1 means every published artifact is broken on install, which is disqualifying for a release whose criteria include publishing readiness. HIGH-2 is a claims-integrity defect in the README — a constant presented as a measurement — in a project whose central argument is that unearned confidence is the failure mode worth engineering against.

Neither is hard to fix. Both should be fixed, and the fixes verified by tests that would have caught them, before v0.1.0 is considered again.

Separately and independently of those two: the independent-review criterion is still unmet, and cannot be met by this author.
