# Limitations

What the bench number does not mean, what the guards do not catch, and where the implementation is coarser than it looks. Read this before citing any number from this repo.

## 1. The constructed scenarios do not measure accuracy

Of the twenty block-scenarios, fourteen were invented by the same author who wrote the guards: `http-error-body` and `stale-cache` in the basic tier, and **all eight hard-tier and all four mixed-tier scenarios**. That portion of the bench is a **regression harness**, not an accuracy measurement. It tells you the guards still behave the way they did last commit. It tells you nothing about whether they catch anything real, because the failure and the detector were designed together and the scenario was written knowing what the classifier looks for.

A bench where one author writes both the attacks and the detectors measures the author's consistency, not the system's coverage. This is why `provenance` is a required field on every scenario and why the report never merges the rates: the constructed rates and the derived 6/6 are different kinds of claim and combining them would launder the weaker one.

The hard and mixed tiers invert the usual direction of this bias without escaping it. Their scenarios were written to defeat the guards rather than to confirm them, and five of eight hard and two of four mixed succeed. That makes the 3/8 an honest report of known weaknesses — but it is still the author grading his own work, and an author's list of his system's blind spots is not the same as the list. The failures are evidence; the _absence_ of further failures is not.

**Only the derived rate is evidence about real-world failures**, and it is bounded by everything in the next section.

## 2. The derived scenarios come from one case study

The six derived scenarios reproduce mechanisms from arXiv:2606.14589. That source is:

- **A draft.** Not peer-reviewed at time of writing.
- **A single system.** One agent runtime, one architecture, one deployment. Not a survey.
- **Eight weeks.** A short observation window.
- **Self-annotated, with no independent annotators.** The incidents were classified by the same people who operated the system. There is no inter-annotator agreement to report because there was only one annotator.

The reasonable conclusion is narrow: **these mechanisms are real, and they occurred at least once in a production system.** That is the whole claim. Any of the following would be unsupported:

- That these are the _most common_ pollution mechanisms.
- That their relative frequencies in that study generalize to other runtimes.
- That six mechanisms are an exhaustive taxonomy. They are not, and the study does not claim to be.

Frequencies do not transfer across architectures. A system that never shells out cannot have the stdout-capture failure at all; a system built entirely on shell tools may have it constantly.

## 3. Twenty-eight scenarios is a small fixed set

Every number in the README is a measurement on twenty-eight hand-written scenarios: twenty block, eight allow. Consequences:

- **The predicted false positive has now happened.** Earlier versions of this document said the realistic failure mode was over-blocking legitimate content that looks diagnostic — "an incident postmortem quoting a stack trace, a support ticket pasting an HTTP error". The `mixed` tier added exactly that case, and **the guards block it**: `mixed-clean-quoted-error` is a real postmortem quoting a 503, refused with `CLAIM_UNGROUNDED`. False-positive rates are now 0/2 basic, 0/4 hard, **1/2 mixed**. Eight controls is still not a rate. But the failure is no longer hypothetical, and it is the strongest available evidence that this design over-blocks on exactly the content it was predicted to over-block on.
- **The scenarios are byte-identical fixed data.** That buys reproducibility and costs realism. Real chunks are messier and longer than these. Chunks carrying genuine data _and_ pollution are now covered by the `mixed` tier, which is where the first false positive appeared; they are still hand-written rather than sampled from a real pipeline.
- **The basic tier is saturated; the hard and mixed tiers are not.** Basic passes 8/8, so those numbers only detect regressions — the bench emits its own saturation warning when a tier reaches 100% on a small denominator. Hard fails 5 of 8 and mixed fails 2 of 4, so those two tiers carry the information about improvement rather than regression. Only the basic tier gates the `bench` command's exit code; a command that exited non-zero on the measurement tiers could not be run in CI without either being ignored or being "fixed" by deleting the scenarios that fail.
- **The outbound gate caught one of five it was expected to catch.** Every basic block-scenario is blocked inbound, so outbound never sees an ungrounded claim from a delivered chunk there. The hard tier was built to exercise outbound as an independent catcher, and it establishes that overlap-based grounding does not survive paraphrase (`hard-paraphrased-fabrication`), relational inversion (`hard-recombined-entities`), a silently changed period (`hard-unit-shift`), or an appended fabricated qualifier (`hard-appended-qualifier`). Outbound's remaining behavior is covered by its own package tests, not by this bench.
- **One inbound gap is measured and open.** `hard-fresh-timestamp-stale-body` is not caught: nothing compares a document's content freshness against its `retrievedAt`, so a cache can re-serve a stale body under a current timestamp and a data channel and be admitted.

## 4. Claim extraction is sentence-level

The outbound guard segments candidate output into sentences and grounds each one independently. **A claim spanning two sentences will be missed**, because neither half is individually ungrounded:

> Revenue grew substantially this quarter. Most of it came from the enterprise segment.

If a chunk supports the first sentence, the second is evaluated on its own, and an attribution that only exists across the sentence boundary has no single sentence to attach to. Related gaps: claims built by pronoun reference to an earlier sentence, and claims implied by juxtaposition rather than stated.

The `hard-split-conjunction` scenario tests exactly this and does block — but **it blocks for the wrong reason, and the distinction matters.** Its second sentence ("The configuration change deployed that day is what resolved it.") leans on a pronoun and a relative date, so it carries almost no specifics for the deterministic ladder to match, and the ladder returns `CLAIM_UNVERIFIABLE` rather than a judgement about the causal claim. Since #28 an unverifiable claim blocks by default, so the outcome is correct. Nothing in the guard saw the fabricated causal link. A cross-sentence claim whose halves are both individually rich in matching entities still passes. `mixed-cross-sentence-both-grounded` now covers that case, and **it fails**: both halves ground cleanly, the fabrication exists only in the join, and nothing sees it.

Questions, hedged statements, and fenced code are deliberately excluded from extraction. That is the right default — hedged text is not an assertion — but it means an unsupported claim phrased as a hedge passes.

## 5. `Grounding.method` is coarser than the deterministic ladder

The grounding check runs a ladder of deterministic stages before any model call: exact match, then normalized match, then named-entity and numeric-literal overlap, then lexical. The shared `Grounding.method` union in `@provguard/schema` has only three members — `exact`, `fuzzy`, `judge`.

Everything deterministic and non-verbatim therefore **reports as `fuzzy`**, collapsing several distinct stages into one label. The precise stage that decided is preserved on `ClaimAssessment.decidedBy`, which distinguishes `exact`, `normalized`, `entity`, `numeric`, `lexical`, `judge`, and `none`.

This was a deliberate trade: widening the schema enum would be a cross-package change affecting four packages and three parallel workstreams, for a field that is reported but not branched on. It is a real wart. If you are consuming `Grounding.method` for anything that matters, **read `ClaimAssessment.decidedBy` instead** — `method` will tell you a numeric-overlap match and a loose lexical match are the same thing, and they are not.

## 6. Blocking requires the production request path

The guards only prevent a bad delivery if they sit **inline, synchronously, between context assembly and the model, and between the model and the user**. That is a high adoption bar. It means accepting added latency in the request path, and accepting that a bug in the guard can block legitimate traffic — a new way for the system to fail, in exchange for closing an existing one. Most teams will not put an unproven component there, and that caution is correct.

**Monitor mode exists for exactly this reason.** `--monitor` on either command runs every check and records what _would_ have been blocked, while allowing delivery. It is the honest first deployment: it produces a false-positive rate on your own traffic, which is the number this repo most conspicuously lacks. Run it there before considering blocking mode.

Monitor mode prevents nothing. A chain observed in monitor mode was still delivered to the user.

## Summary

| Claim                                    | Support                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| These mechanisms occur in production     | One draft case study, one system, eight weeks, self-annotated                         |
| The guards catch shape-visible pollution | 6/6 derived and 2/2 constructed on the fixed basic tier                               |
| The guards catch near-miss pollution     | **Only partly.** 3/8 constructed on the hard tier; the five failures are listed above |
| The guards don't over-block              | 6 clean controls — not a false-positive rate                                          |
| Normal test suites miss these            | Shape baseline catches 0/16; every polluted output is a well-formed non-empty string  |
| The guards work on your system           | **Not supported.** Run monitor mode and find out                                      |
