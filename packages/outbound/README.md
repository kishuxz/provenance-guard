# @provguard/outbound

The outbound provenance guard. It answers one question: **does every factual claim in this output trace back to a chunk that was actually in context?**

## Usage

```ts
import { auditOutput } from "@provguard/outbound";

const { groundings, verdict } = auditOutput(modelOutput, chunksThatWereInContext);

if (verdict.decision === "block") {
  // verdict.reasons carries a ReasonCode and claimId per failing claim
}
```

## How a claim is decided

Deterministic checks run in a fixed order, and the first one to reach a conclusion decides:

1. **exact** — the claim's own words appear verbatim in a chunk.
2. **normalized** — they appear once case, whitespace and punctuation are folded away.
3. **entity / numeric overlap** — every named entity and numeric literal in the claim appears in context. A claim is only as sourced as its least sourced specific, so _all_ of them must be present. Partly-invented specifics are rejected outright, because that is what a fluent fabrication looks like.

Only when all of these are inconclusive is a claim marked `unverifiable` and deferred. The stage that decided is always recorded on `ClaimAssessment.decidedBy`; the shared `Grounding.method` union is coarser, so everything deterministic but non-verbatim reports as `fuzzy` there.

Verdicts roll up strictly: any ungrounded claim **blocks**, any unverifiable claim **quarantines**, otherwise **allow**.

## The low-tier gate

A match whose supporting chunks are _all_ tier T4 or T5 does not ground anything, even on an exact match.

This is the failure mode the guard exists for. When a model restates an error string or an unlabeled blob back at you, the claim matches its "source" perfectly — and that exact match is precisely what makes it convincing. Those claims come back `ungrounded` under `CLAIM_SUPPORT_LOW_TIER`, a distinct code from an ordinary miss, while keeping the method that found the match so the decision stays explainable.

Later stages still run first, so a _trusted_ chunk supporting the same claim by a weaker method wins over an untrusted verbatim one.

## The judge hook

`auditOutputWithJudge` accepts a caller-injected `judge: (claim, chunks) => Promise<Grounding>`. This package never calls an LLM itself.

The judge is advisory, and advisory in one direction only:

- it is consulted **only** on `unverifiable` claims — wherever a deterministic result exists, that result stays load-bearing;
- it can escalate `unverifiable` to `ungrounded`, because a model saying "this is fabricated" is safe to act on;
- it can **never** ground a claim, because a model's say-so is not provenance;
- a judge that throws degrades to the deterministic verdict rather than failing the audit.

Its opinion is recorded on `ClaimAssessment.advisory` either way, with `applied` saying whether it changed anything.

## Determinism

No clock, no randomness, no network, no model call. The same output and the same chunks always produce the same verdict.
