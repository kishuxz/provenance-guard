WORKFLOW — follow this exactly, it is how we work:

- Create a GitHub issue first with `gh issue create`, describing the unit of work and its acceptance criteria.
- Branch from main: feat/foundation-schema
- Commit in small logical commits as you go, not one giant commit at the end.
- Push the branch and open a PR with `gh pr create`, body containing "Closes #<issue>".
- Run `gh pr checks --watch`. If CI is red, fix it with a new commit on the same branch and re-run. Do not merge a red PR.
- Once CI is green, merge with `gh pr merge --squash --delete-branch`, then confirm main is updated.
- Commit messages: conventional commits, imperative mood. Absolutely no AI attribution — no "Generated with Claude Code" line, no Co-Authored-By trailer, nothing referencing Claude or an AI assistant in any commit, PR title, or PR body.
- Never commit directly to main. Never force-push main.
- Run typecheck, lint, and test locally before pushing, so CI is not where you first learn something is broken.

Engineering rules:

- No placeholder implementations, no TODO stubs, no functions that throw "not implemented". If something cannot be built, say so instead of faking it.
- Deterministic checks first. Fall back to an LLM call only when a deterministic method cannot decide, and always record which method produced each result.
- Every guard needs a test that deliberately introduces the violation it targets and asserts the guard fires. A guard without a failing-case test is unverified.
- Tests must construct inputs the way real callers do, not the way the implementation expects.
- Stay inside your assigned package. Do not create or edit root config, CI, or another package's files.
- Before starting work, verify main contains @provguard/schema. If it does not, stop and report rather than inventing types.
