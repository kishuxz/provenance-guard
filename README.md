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

**Inbound — block channels that were never data sources.** Every chunk gets a channel and a credibility tier before context assembly. A diagnostic log, a system alert, an HTML error page, a truncated payload, an empty result, anything carrying a non-2xx upstream status: these are not retrieval results, and they do not belong in a slot that an agent will read as data. Unrecognized content is labelled `UNLABELED` at the lowest tier rather than given the benefit of the doubt. Slots declare which channels they accept and the minimum tier they require; anything else is denied, and the denial is recorded with a reason code.

**Outbound — refuse claims that don't trace to a tagged chunk.** The candidate output is split into claims, and each claim is matched against the chunks that were actually admitted. A claim supported only by a chunk that inbound rejected is not grounded. A claim supported by nothing at all is not grounded. Matching runs deterministically first — exact, then normalized, then entity and numeric overlap — and records which stage decided.

## What this is not

- **Not observability.** Tracing, eval dashboards, and logging watch what happened and tell you afterward. This sits in the request path and stops the chunk from entering context, or stops the claim from being delivered. Watching is a different job from blocking.
- **Not prompt-injection defense.** Injection assumes an adversary who crafted a payload to manipulate your agent. Every mechanism here is accidental — your own plumbing, doing what it was built to do. A shell capture that doesn't distinguish stdout from a data channel is not an attack. It is a pipe. No attacker is required, which is why input sanitizing aimed at hostile strings does not catch it.
- **Not a self-improving or RL system.** There is no training loop and nothing learns. The model was not wrong and does not need correcting: given an error page presented as vendor data, "summarize the vocabulary" is reasonable behavior. The input was wrong. Fixing the input is a plumbing problem, not a model problem.

## Bench

Ten scenarios, eight expected to block and two clean controls expected to pass. Every scenario is fixed data with no network and no live model call, so runs are byte-identical.

```
id                       provenance   expected      actual  pass  reason                  stage    guards_disabled  shape_check
stdout-capture           derived      should_block  block   pass  UPSTREAM_STATUS_NOT_OK  inbound  miss             miss
http-error-body          constructed  should_block  block   pass  UPSTREAM_STATUS_NOT_OK  inbound  miss             miss
alert-in-history         derived      should_block  block   pass  CHANNEL_NOT_PERMITTED   inbound  miss             miss
truncated-json           derived      should_block  block   pass  PAYLOAD_TRUNCATED       inbound  miss             miss
mechanical-fallback      derived      should_block  block   pass  TIER_BELOW_MINIMUM      inbound  miss             miss
unlabeled-enrichment     derived      should_block  block   pass  CHANNEL_NOT_PERMITTED   inbound  miss             miss
stale-cache              constructed  should_block  block   pass  CHANNEL_NOT_PERMITTED   inbound  miss             miss
empty-not-denied         derived      should_block  block   pass  PAYLOAD_EMPTY           inbound  miss             miss
clean-labeled-retrieval  constructed  should_allow  allow   pass  -                       none     miss             miss
clean-authorized-empty   constructed  should_allow  allow   pass  -                       none     miss             miss

derived catch rate: 6/6 (100.0%)
constructed catch rate: 2/2 (100.0%)
false positives: 0
stage breakdown: inbound=8
reason breakdown: UPSTREAM_STATUS_NOT_OK=2, CHANNEL_NOT_PERMITTED=3, PAYLOAD_TRUNCATED=1, TIER_BELOW_MINIMUM=1, PAYLOAD_EMPTY=1
disabled baseline catches: 0
shape-check baseline catches: 0
```

**The two rates are reported separately and are not combined.** The six derived scenarios reproduce mechanisms documented in arXiv:2606.14589; the two constructed block-scenarios were invented by the same author who wrote the guards. Only the derived rate carries any evidence about real-world failures, and even that is a measurement on a fixed ten-scenario set, not an accuracy claim. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

Three things in that table are worth reading carefully:

- **Both baselines catch zero.** With the guards disabled, nothing is caught, which is the point — this is what the pipeline does today. The shape-check baseline is what a normal test suite checks: output is non-empty and JSON parses. It also catches zero of the eight. Every polluted output above is a non-empty, well-formed string. Shape tells you nothing about provenance.
- **All eight were caught inbound, and outbound caught zero of them.** That is not evidence that the outbound gate is unnecessary; it means inbound blocked these chunks first, so outbound never saw an ungrounded claim to reject. This scenario set does not exercise the outbound gate as an independent catcher. The `check` example above, run as a single chunk, shows both gates firing.
- **Zero false positives on two controls** is two data points. It is not a false-positive rate.

## Quickstart

Requires Node 20+ and pnpm 10.

```bash
# install
pnpm install

# build (no root build script yet; this compiles every package in dependency order)
pnpm -r exec tsc -p tsconfig.json

# run the bench; --json also writes bench-results.json
node packages/cli/dist/cli/src/index.js bench --json

# run the demo: the D1 chain from above
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
node packages/cli/dist/cli/src/index.js check polluted.json
```

`check` exits `1` when it blocks, so it can gate a pipeline. Add `--monitor` to either command to record what _would_ have been blocked without actually blocking it.

## Packages

| Package               | Role                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `@provguard/schema`   | Shared types: `Chunk`, `Provenance`, `Verdict`, `ReasonCode`, slot policy |
| `@provguard/inbound`  | Chunk classification and slot admission                                   |
| `@provguard/outbound` | Claim extraction and grounding                                            |
| `@provguard/harness`  | The ten deterministic scenarios                                           |
| `@provguard/cli`      | `provguard check` and `provguard bench`                                   |
