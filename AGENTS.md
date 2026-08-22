# Provenance Guard engineering contract

This file governs every coding agent working in this repository, including agents
started from Conductor worktrees. The goal is not to produce a plausible diff. The
goal is to leave the repository in a verified, reviewable, releasable state.

## Mission

Provenance Guard is an inline reliability layer for AI systems. It prevents material
that was never valid evidence from entering model context and prevents unsupported
claims from reaching users. The finished system must also record a typed lineage graph
that can explain where a claim came from, why a verdict was reached, and what depends
on a polluted artifact.

## Sources of truth

Read these before planning:

1. `docs/PRODUCT_SPEC.md` — user-visible behavior and completion criteria.
2. `docs/GRAPH_ENGINEERING_PLAN.md` — graph model, invariants, traversals, and rollout.
3. `docs/AUTONOMOUS_EXECUTION.md` — work graph, agent loop, lane boundaries, and gates.
4. `docs/LIMITATIONS.md` — claims the project must not overstate.
5. Existing schemas, tests, and public exports — current executable contracts.

When prose and tests disagree, do not silently choose one. Determine whether the test
captures an intentional public contract. Fix stale documentation when behavior is
correct; otherwise change behavior and tests together in a focused PR.

## Required work loop

For each independently reviewable unit:

1. Inspect current main, open issues, open PRs, and CI.
2. Select the highest-priority unblocked item from `docs/AUTONOMOUS_EXECUTION.md`.
3. Create or update a GitHub issue with scope, non-goals, risks, and acceptance tests.
4. Branch from current main using `feat/`, `fix/`, `docs/`, or `chore/`.
5. Write or update a failing acceptance test before implementation when practical.
6. Implement the smallest coherent change without placeholders.
7. Run the relevant focused tests, then the full verification suite.
8. Review the diff for contract drift, hidden nondeterminism, security issues, and
   unsupported claims.
9. Commit in small logical commits using conventional commits.
10. Open a PR that closes the issue and reports exact verification evidence.
11. Repair CI on the same branch until green. Never merge red CI.
12. Squash-merge, delete the branch, update local main, and select the next unblocked
    item.

Do not add AI attribution, generated-by text, or AI co-author trailers to commits, PRs,
issues, documentation, or source files.

## Verification contract

The repository-level gate is:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm exec provguard bench --json
```

If a command cannot run, report the exact environmental blocker. Do not describe work
as complete based only on code inspection. CI must run the same meaningful gates.

Every guard or graph invariant requires a control case, an adversarial case, a stable
reason code or typed error, deterministic repeated output, and a public-call-shape test.

## Engineering constraints

- Deterministic checks run before optional model-assisted judgment.
- An LLM may resolve an explicitly uncertain case, but must never silently overwrite
  deterministic provenance facts. Record which method produced every decision.
- Default to deny when a material claim cannot be verified under configured policy.
  Preserve monitor-only mode for safe rollout.
- IDs, graph serialization, benchmark fixtures, and reason codes must be stable.
- Core packages remain usable without network calls, API keys, Neo4j, or hosted models.
- Database adapters sit behind interfaces; graph semantics do not depend on one vendor.
- Never add TODO stubs, fake adapters, or functions that throw `not implemented`.
- Never weaken a test just to make a change pass.
- Never claim accuracy, false-positive rate, readiness, or performance beyond evidence.
- Preserve backward compatibility unless a focused issue justifies a breaking change and
  includes migration guidance.

## Conductor concurrency rules

Parallel work is allowed only when file ownership and dependencies are independent.

Single-writer work, always followed by independent review:

- shared schemas and reason codes;
- graph identity and temporal semantics;
- public package exports;
- policy behavior;
- CLI output contracts;
- root configuration and CI;
- release/version changes.

Safe parallel lanes include read-only architecture review, benchmark fixture research,
documentation review, threat modeling, DevEx review, and isolated adapter work after the
core graph interfaces have merged. Agents must not edit source-of-truth files in parallel.

## Git safety

- Never commit directly to main or force-push main.
- Never rewrite another lane's branch.
- Never merge with failing or missing required checks.
- Do not perform destructive cleanup outside the current worktree.
- Do not expose credentials, private data, proprietary incidents, or local paths.

## Definition of complete

The project is complete only when every release criterion in `docs/PRODUCT_SPEC.md` is
met, the work graph has no required unfinished node, main CI is green, a clean clone can
run the quickstart, benchmark claims match generated results, and a tagged release has no
known critical or high-severity correctness issue.
