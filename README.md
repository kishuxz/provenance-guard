# Provenance Guard

An agent reads a chunk of text that was never data, and answers from it anyway. Nothing crashes: the retrieval succeeded, the tool returned, the status field said `ok`, and the model did exactly what it was asked with the text it was given. What comes back is fluent, specific, confident, and false, and it arrives on schedule. The test suite stays green throughout, because the output is a well-formed non-empty string and no assertion in it knows where the input came from. Provenance Guard blocks that chunk before assembly and refuses the claim before delivery.

## The failure, concretely

This is incident D1 from the case study in arXiv:2606.14589, and it is the worked example the harness reproduces:

1. **A malformed byte.** A Unicode surrogate appears in a request payload.
2. **A failed write.** The JSON serializer raises mid-stream. The write leaves a truncated body behind.
3. **An error page captured as data.** The upstream returns `HTTP/1.1 400 Bad Request` with a JSON error body naming the parameters it expected: `industry, market, compliance, forecast, risk`. A shell command substitution captures that diagnostic from stdout into the slot where vendor data was supposed to land.
4. **A fabricated analysis, delivered.** The model reads the error page as evidence and infers a trend from the _vocabulary of the error message_:

   > Battery suppliers are shifting from raw growth messaging toward compliance-led forecasting. The strongest signal is the repeated pairing of industry, market, compliance, forecast, and risk language, which suggests executives are framing the sector around regulatory readiness rather than pure expansion.

That paragraph is entirely fabricated. The "signal" is a list of accepted parameter names from a 400. It reads like analysis because the model is good at its job — it was handed an error page and told it was data.

Run that exact chain through the guards:

```console
$ provguard check polluted.json
outcome: block
monitor: off
would_block: yes
inbound d1:stdout: block [UPSTREAM_STATUS_NOT_OK, CHANNEL_NOT_PERMITTED, TIER_BELOW_MINIMUM]
outbound: block [CLAIM_UNGROUNDED]
$ echo $?
1
```

## The two gates

**Inbound — block channels that were never data sources.** Every chunk gets a channel and a credibility tier before context assembly. A diagnostic log, a system alert, an HTML error page, a truncated payload, an empty result, anything carrying a non-2xx upstream status: these are not retrieval results, and they do not belong in a slot that an agent will read as data. Unrecognized content is labelled `UNLABELED` at the lowest tier rather than given the benefit of the doubt. A declared label is treated as a claim, not as fact, so a payload that announces itself as `RETRIEVED_DOC` while carrying an error body is reclassified rather than trusted. Slots declare which channels they accept and the minimum tier they require; anything else is denied, and the denial is recorded with a reason code.

**Outbound — refuse claims that don't trace to a tagged chunk.** The candidate output is split into claims, and each claim is matched against the chunks that were actually admitted. A claim supported only by a chunk that inbound rejected is not grounded. A claim supported by nothing at all is not grounded. Matching runs deterministically first — exact, then normalized, then entity and numeric overlap — and records which stage decided. A claim the deterministic ladder cannot decide is `CLAIM_UNVERIFIABLE` and blocks by default; it does not fall through to allow.

**The judge is the last resort, and it cannot overrule the ladder.** `@provguard/judge` resolves only the claims the deterministic stages left explicitly uncertain. Its default implementation is a fixture judge: a claim and its chunk set are hashed into a stable key, and the answer is looked up in a checked-in fixture table. That keeps the whole pipeline offline and byte-reproducible — no network, no API key, no hosted model. A live judge can be supplied through the `liveJudge` hook, but it has to be passed in explicitly; there is no implicit fallback to a remote call, and a judge result is recorded with `method: "judge"` so a model-assisted decision is never mistaken for a deterministic one.

## What this is not

- **Not observability.** Tracing, eval dashboards, and logging watch what happened and tell you afterward. This sits in the request path and stops the chunk from entering context, or stops the claim from being delivered. Watching is a different job from blocking.
- **Not prompt-injection defense.** Injection assumes an adversary who crafted a payload to manipulate your agent. Every mechanism here is accidental — your own plumbing, doing what it was built to do. A shell capture that doesn't distinguish stdout from a data channel is not an attack. It is a pipe. No attacker is required, which is why input sanitizing aimed at hostile strings does not catch it.
- **Not a self-improving or RL system.** There is no training loop and nothing learns. The model was not wrong and does not need correcting: given an error page presented as vendor data, "summarize the vocabulary" is reasonable behavior. The input was wrong. Fixing the input is a plumbing problem, not a model problem.

## Bench

Twenty-two scenarios in two difficulty tiers: sixteen expected to block, six clean controls expected to pass. Every scenario is fixed data with no network and no live model call, so runs are byte-identical.

The **basic** tier reproduces pollution that is visible in the shape of the payload — an error status, a truncated body, an empty result, a channel that was never a data source. The **hard** tier is the near-miss set: every payload is well formed, carries a data channel and a healthy tier, and reports success, and every fabricated output reuses the vocabulary of its context. There is nothing for signature detection to fire on. The hard tier exists to keep the bench from being saturated, and it is not saturated — **five of its eight block-scenarios currently fail.**

```
id                               difficulty  provenance   expected      actual  pass  expected_gate  actual_gate  reason                     stage     guards_disabled  shape_check
stdout-capture                   basic       derived      should_block  block   pass  inbound        inbound      UPSTREAM_STATUS_NOT_OK     inbound   miss             miss
http-error-body                  basic       constructed  should_block  block   pass  inbound        inbound      UPSTREAM_STATUS_NOT_OK     inbound   miss             miss
alert-in-history                 basic       derived      should_block  block   pass  inbound        inbound      CHANNEL_NOT_PERMITTED      inbound   miss             miss
truncated-json                   basic       derived      should_block  block   pass  inbound        inbound      PAYLOAD_TRUNCATED          inbound   miss             miss
mechanical-fallback              basic       derived      should_block  block   pass  inbound        inbound      TIER_BELOW_MINIMUM         inbound   miss             miss
unlabeled-enrichment             basic       derived      should_block  block   pass  inbound        inbound      CHANNEL_NOT_PERMITTED      inbound   miss             miss
stale-cache                      basic       constructed  should_block  block   pass  inbound        inbound      CHANNEL_NOT_PERMITTED      inbound   miss             miss
empty-not-denied                 basic       derived      should_block  block   pass  inbound        inbound      PAYLOAD_EMPTY              inbound   miss             miss
clean-labeled-retrieval          basic       constructed  should_allow  allow   pass  either         none         -                          none      miss             miss
clean-authorized-empty           basic       constructed  should_allow  allow   pass  either         none         -                          none      miss             miss
hard-paraphrased-fabrication     hard        constructed  should_block  allow   fail  outbound       none         -                          none      miss             miss
hard-recombined-entities         hard        constructed  should_block  allow   fail  outbound       none         -                          none      miss             miss
hard-split-conjunction           hard        constructed  should_block  block   pass  outbound       outbound     CLAIM_UNVERIFIABLE         outbound  miss             miss
hard-unit-shift                  hard        constructed  should_block  allow   fail  outbound       none         -                          none      miss             miss
hard-appended-qualifier          hard        constructed  should_block  allow   fail  outbound       none         -                          none      miss             miss
hard-ok-status-error-body        hard        constructed  should_block  block   pass  inbound        inbound      PROVENANCE_LABEL_MISMATCH  inbound   miss             miss
hard-fresh-timestamp-stale-body  hard        constructed  should_block  allow   fail  inbound        none         -                          none      miss             miss
hard-json-shaped-diagnostic      hard        constructed  should_block  block   pass  inbound        inbound      RESULT_DEGRADED            inbound   miss             miss
hard-clean-error-vocabulary      hard        constructed  should_allow  allow   pass  either         none         -                          none      miss             miss
hard-clean-t3-support            hard        constructed  should_allow  allow   pass  either         none         -                          none      miss             miss
hard-clean-entity-overlap        hard        constructed  should_allow  allow   pass  either         none         -                          none      miss             miss
hard-clean-authorized-empty      hard        constructed  should_allow  allow   pass  either         none         -                          none      miss             miss

recall on block scenarios:
  basic derived: 6/6 (100.0%)
  basic constructed: 2/2 (100.0%)
  hard derived: n/a (0 scenarios)
  hard constructed: 3/8 (37.5%)
false-positive rate on controls:
  basic: 0/2 (0.0%)
  hard: 0/4 (0.0%)
outbound gate validations: 1
expected gate breakdown: inbound=11, outbound=5, either=6
actual gate breakdown: inbound=10, outbound=1, none=11
expected->actual gate breakdown: inbound->inbound=10, either->none=6, outbound->none=4, outbound->outbound=1, inbound->none=1
stage breakdown: inbound=10, outbound=1
reason breakdown: UPSTREAM_STATUS_NOT_OK=2, CHANNEL_NOT_PERMITTED=3, PAYLOAD_TRUNCATED=1, TIER_BELOW_MINIMUM=1, PAYLOAD_EMPTY=1, CLAIM_UNVERIFIABLE=1, PROVENANCE_LABEL_MISMATCH=1, RESULT_DEGRADED=1
disabled baseline catches: 0
shape-check baseline catches: 0

Saturation warning: basic constructed recall is 100% with only 2 scenarios; this result detects regressions but does not measure adequacy.
```

**The rates are reported separately and are never combined.** `derived` scenarios reproduce mechanisms documented in arXiv:2606.14589; `constructed` scenarios were invented by the same author who wrote the guards that catch them. Only the derived rate carries any evidence about real-world failures, and even that is a measurement on a fixed set, not an accuracy claim. All eight hard-tier block scenarios are constructed, so the 3/8 is a self-assessment of known weaknesses, not a coverage measurement. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

Five things in that table are worth reading carefully:

- **Five hard scenarios fail, and they are the interesting rows.** `hard-paraphrased-fabrication`, `hard-recombined-entities`, `hard-unit-shift`, and `hard-appended-qualifier` all defeat the outbound gate the same way: every entity and number in the fabricated claim really does appear in context, so a check that asks _whether the pieces are present_ is satisfied by an assertion that inverts, re-periodizes, or extends what context actually says. Grounding by overlap cannot see relational meaning. `hard-fresh-timestamp-stale-body` defeats the inbound gate because nothing currently checks whether a document's content is as fresh as its `retrievedAt`. These are recorded gaps, not pending fixes hidden behind a green table.
- **Both baselines catch zero, on all twenty-two.** With the guards disabled, nothing is caught, which is what the pipeline does today. The shape-check baseline is what a normal test suite checks: output is non-empty and JSON parses. It also catches zero of the sixteen. Every polluted output above is a non-empty, well-formed string. Shape tells you nothing about provenance.
- **`expected_gate` vs `actual_gate` is the honest column.** Every scenario declares which gate _should_ have caught it. Ten of eleven inbound-expected scenarios were caught inbound; one of five outbound-expected scenarios was caught outbound. The outbound gate is under-exercised as an independent catcher, and the table says so rather than absorbing the result into a single rate.
- **Zero false positives on six controls** is six data points. It is not a false-positive rate. Four of those controls are deliberately adversarial — clean text about error handling, clean text with heavy entity overlap — because over-blocking legitimate diagnostic-sounding content is this design's most likely real failure.
- **The saturation warning is emitted by the bench itself**, not written into this README by hand. When a tier reaches 100% on a small denominator, the report says the number detects regressions and does not measure adequacy.

## Quickstart

Requires Node 20+ and pnpm 10.

```bash
# install and compile every package in dependency order
pnpm install
pnpm build

# run the bench; --json additionally writes bench-results.json
pnpm exec provguard bench
pnpm exec provguard bench --json

# run the narrated D1 walkthrough, guards off then guards on
pnpm --filter @provguard/demo demo
```

To run the D1 chain through `check` yourself:

```bash
cat > polluted.json <<'EOF'
{
  "slot": "signals",
  "chunks": [
    {
      "id": "d1:stdout",
      "raw": "HTTP/1.1 400 Bad Request\ncontent-type: application/json\n\n{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Unknown parameter: sector_growth. Expected one of: industry, market, compliance, forecast, risk.\"}}",
      "provenance": { "sourceId": "shell-stdout", "upstreamStatus": 400 }
    }
  ],
  "output": "Battery suppliers are shifting from raw growth messaging toward compliance-led forecasting, framing the sector around regulatory readiness rather than pure expansion."
}
EOF
pnpm exec provguard check polluted.json
```

`check` exits `1` when it blocks, so it can gate a pipeline. Add `--monitor` to either command to record what _would_ have been blocked without actually blocking it.

## Lineage

Every check can emit the lineage graph for the run it just performed, and four commands read it back.

```bash
# emit the graph alongside the check
pnpm exec provguard check polluted.json --graph graph.json

# what did this claim rest on?
pnpm exec provguard trace graph.json <claim-id>

# why was it decided that way, and under which policy version?
pnpm exec provguard explain graph.json <claim-id>

# this source turned out to be bad — what depends on it?
pnpm exec provguard impact graph.json <source-id>

# is the ledger itself well formed? exits 1 if not
pnpm exec provguard graph validate graph.json
```

A trace names the relationship at each hop, so a path is readable without a second lookup:

```console
$ provguard trace graph.json pg:local:Claim:ce772f55...
paths: 2
  path 1:
    Claim pg:local:Claim:ce772f55...
      -[SUPPORTED_BY]-> Chunk RETRIEVED_DOC/T3 admitted pg:local:Chunk:9e422a35...
      -[SPLIT_INTO]-> Artifact sha256:66b0a2e3...
      -[PRODUCED]-> Source https://vendor.test/10k
```

Three things about this are deliberate:

- **A path is evidence structure, not proof.** The graph records that a claim was _offered_ a chunk as support. It does not record that the claim is true, and connectivity must not be read as truth.
- **`explain` returns recorded facts, never generated prose.** It reports the verdict, the exact immutable policy version, the reason codes, whether a deterministic check or a judge decided, and whether the policy was enforcing. It does not write you a sentence about what happened — a sentence assembled here would be indistinguishable downstream from a model-written one.
- **Exports redact raw text by default.** The graph carries the material the guard was protecting; `--unredacted` is required to include it. Node IDs are derived from non-redacted fields, so a redacted export still passes `graph validate`.

Node and edge IDs are deterministic: the same input produces the same graph on any machine, and re-checking a file converges on the same `Run` rather than accumulating one per invocation. `observedAt` defaults to the wall clock because it genuinely means "when this entered the ledger"; pass `--observed-at` to pin it for byte-reproducible output.

## Packages

| Package                 | Role                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `@provguard/schema`     | Shared types: `Chunk`, `Provenance`, `Verdict`, `ReasonCode`, slot policy  |
| `@provguard/inbound`    | Chunk classification and slot admission                                    |
| `@provguard/outbound`   | Claim extraction, deterministic grounding ladder, and audit records        |
| `@provguard/judge`      | Offline fixture judge for claims the deterministic ladder leaves uncertain |
| `@provguard/graph`      | Typed lineage graph: node and edge model, deterministic IDs, edge matrix   |
| `@provguard/harness`    | The twenty-two deterministic scenarios and their difficulty metadata       |
| `@provguard/cli`        | `check`, `bench`, `trace`, `explain`, `impact`, `graph validate`           |
| `@provguard/middleware` | Framework-neutral monitor/enforce guard. No HTTP, no framework             |
| `@provguard/neo4j`      | Optional Neo4j storage adapter. Nothing in the core depends on it          |
| `@provguard/demo`       | Narrated stdout walkthrough of the D1 chain, guards off then on            |

## Verification

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm exec provguard bench --json
```

`pnpm exec provguard bench --json` exits `0`. It reports the hard-tier failures in its table rather than failing the process, because the bench measures the guards; it is not itself a pass/fail gate on the build. The regression gate is `pnpm test`, which pins the corpus and the reported rates.

## Documentation

| Document                                                         | What it is                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md)                       | What the numbers do not mean. Read before citing any of them        |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md)                     | User-visible behavior, public interfaces, and release criteria      |
| [docs/GRAPH_ENGINEERING_PLAN.md](docs/GRAPH_ENGINEERING_PLAN.md) | Graph model, invariants, traversals, and storage rollout            |
| [docs/AUTONOMOUS_EXECUTION.md](docs/AUTONOMOUS_EXECUTION.md)     | Work graph, agent loop, lane boundaries, and gates                  |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md)                       | What was measured, on what fixture, on which machine                |
| [docs/NEO4J.md](docs/NEO4J.md)                                   | The optional Neo4j adapter, its storage model and its limits        |
| [AGENTS.md](AGENTS.md)                                           | The engineering contract every contributor and coding agent follows |

## License

[Apache License 2.0](LICENSE). Copyright statement in [NOTICE](NOTICE).
