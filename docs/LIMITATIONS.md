# Limitations

What the bench number does not mean, what the guards do not catch, and where the implementation is coarser than it looks. Read this before citing any number from this repo.

## 1. The constructed scenarios do not measure accuracy

Of the eight block-scenarios, two — `http-error-body` and `stale-cache` — were invented by the same author who wrote the guards that catch them. That portion of the bench is a **regression harness**, not an accuracy measurement. It tells you the guards still behave the way they did last commit. It tells you nothing about whether they catch anything real, because the failure and the detector were designed together and the scenario was written knowing what the classifier looks for.

A bench where one author writes both the attacks and the detectors measures the author's consistency, not the system's coverage. This is why `provenance` is a required field on every scenario and why the report never merges the two rates: the constructed 2/2 and the derived 6/6 are different kinds of claim and combining them into "8/8" would launder the weaker one.

**Only the derived rate is evidence about real-world failures**, and it is bounded by everything in the next section.

## 2. The derived scenarios come from one case study

The six derived scenarios reproduce mechanisms from arXiv:2606.14589. That source is:

- **A draft.** Not peer-reviewed at time of writing.
- **A single system.** One agent runtime, one architecture, one deployment. Not a survey.
- **Eight weeks.** A short observation window.
- **Self-annotated, with no independent annotators.** The incidents were classified by the same people who operated the system. There is no inter-annotator agreement to report because there was only one annotator.

The reasonable conclusion is narrow: **these mechanisms are real, and they occurred at least once in a production system.** That is the whole claim. Any of the following would be unsupported:

- That these are the *most common* pollution mechanisms.
- That their relative frequencies in that study generalize to other runtimes.
- That six mechanisms are an exhaustive taxonomy. They are not, and the study does not claim to be.

Frequencies do not transfer across architectures. A system that never shells out cannot have the stdout-capture failure at all; a system built entirely on shell tools may have it constantly.

## 3. Ten scenarios is a small fixed set

Every number in the README is a measurement on ten hand-written scenarios: eight block, two allow. Consequences:

- **The false-positive count is 0 out of 2 controls.** Two clean inputs is not a false-positive rate, and it is by far the weakest number in the report. Real deployments will surface false positives that two controls cannot predict. The realistic failure mode is over-blocking legitimate content that happens to look diagnostic — an incident postmortem quoting a stack trace, a support ticket pasting an HTTP error, a document about error handling.
- **The scenarios are byte-identical fixed data.** That buys reproducibility and costs realism. Real chunks are messier, longer, and mixed — pollution interleaved with genuine data in the same chunk, which none of these scenarios test.
- **The bench is saturated.** Everything passes, so the current numbers cannot distinguish a good guard from a barely-adequate one. A bench nothing fails has stopped being informative about improvements; it only detects regressions.
- **The outbound gate caught zero.** All eight were blocked inbound, so outbound never saw an ungrounded claim from a delivered chunk. Its independent behavior is covered by its own package tests, not by this bench.

## 4. Claim extraction is sentence-level

The outbound guard segments candidate output into sentences and grounds each one independently. **A claim spanning two sentences will be missed**, because neither half is individually ungrounded:

> Revenue grew substantially this quarter. Most of it came from the enterprise segment.

If a chunk supports the first sentence, the second is evaluated on its own, and an attribution that only exists across the sentence boundary has no single sentence to attach to. Related gaps: claims built by pronoun reference to an earlier sentence, and claims implied by juxtaposition rather than stated.

Questions, hedged statements, and fenced code are deliberately excluded from extraction. That is the right default — hedged text is not an assertion — but it means an unsupported claim phrased as a hedge passes.

## 5. `Grounding.method` is coarser than the deterministic ladder

The grounding check runs a ladder of deterministic stages before any model call: exact match, then normalized match, then named-entity and numeric-literal overlap, then lexical. The shared `Grounding.method` union in `@provguard/schema` has only three members — `exact`, `fuzzy`, `judge`.

Everything deterministic and non-verbatim therefore **reports as `fuzzy`**, collapsing several distinct stages into one label. The precise stage that decided is preserved on `ClaimAssessment.decidedBy`, which distinguishes `exact`, `normalized`, `entity`, `numeric`, `lexical`, `judge`, and `none`.

This was a deliberate trade: widening the schema enum would be a cross-package change affecting four packages and three parallel workstreams, for a field that is reported but not branched on. It is a real wart. If you are consuming `Grounding.method` for anything that matters, **read `ClaimAssessment.decidedBy` instead** — `method` will tell you a numeric-overlap match and a loose lexical match are the same thing, and they are not.

## 6. Blocking requires the production request path

The guards only prevent a bad delivery if they sit **inline, synchronously, between context assembly and the model, and between the model and the user**. That is a high adoption bar. It means accepting added latency in the request path, and accepting that a bug in the guard can block legitimate traffic — a new way for the system to fail, in exchange for closing an existing one. Most teams will not put an unproven component there, and that caution is correct.

**Monitor mode exists for exactly this reason.** `--monitor` on either command runs every check and records what *would* have been blocked, while allowing delivery. It is the honest first deployment: it produces a false-positive rate on your own traffic, which is the number this repo most conspicuously lacks. Run it there before considering blocking mode.

Monitor mode prevents nothing. A chain observed in monitor mode was still delivered to the user.

## Summary

| Claim | Support |
| --- | --- |
| These mechanisms occur in production | One draft case study, one system, eight weeks, self-annotated |
| The guards catch them deterministically | 6/6 derived and 2/2 constructed on a fixed ten-scenario set |
| The guards don't over-block | 2 clean controls — not a false-positive rate |
| Normal test suites miss these | Shape baseline catches 0/8; every polluted output is a well-formed non-empty string |
| The guards work on your system | **Not supported.** Run monitor mode and find out |
