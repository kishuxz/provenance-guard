# Integration guide

## Before anything else: run monitor mode

Do not start with enforcement. `docs/LIMITATIONS.md` is blunt about why: the false-positive rate on your traffic is the number this repo most conspicuously lacks, and it is the number that decides whether this is safe for you. There is now one **confirmed** false positive on a realistic input — a genuine incident postmortem quoting an HTTP 503 is blocked — so the question is not whether over-blocking happens but how often it happens to you.

Monitor mode prevents nothing. A chain observed in monitor mode was still delivered. That is what makes it safe to turn on.

## The two call sites

```ts
import { createGuard } from "@provguard/middleware";

const guard = createGuard({ mode: "monitor" });

// 1. Before context assembly.
const admitted = guard.admitContext(candidateChunks);
const context = admitted.context;

// 2. After the model, before delivery.
const result = await guard.run(candidateChunks, candidateOutput);
if (!result.delivered) {
  // enforce mode only; monitor mode always delivers
}
```

In monitor mode `admitted.context` contains **every** chunk, including ones the guard would refuse. That is deliberate: withholding them would change what the model sees, and you could no longer compare would-block outcomes against your real traffic. `admitted.decisions[i].wouldRefuse` is what you record.

## What to record while monitoring

For each run: `result.decision`, `result.reasonCodes`, and the count of chunks where `wouldRefuse` is true. Those three answer "what would have changed" without changing anything.

Then look at the blocks by hand. A block on an incident postmortem, a support ticket, or a document _about_ errors is a false positive, and you should expect some.

## Switching to enforcement

Change `mode` to `"enforce"`. Nothing else changes: the recorded decision and reason codes are identical in both modes, and there is a test asserting exactly that. Only `delivered` differs.

## Keeping the lineage

```ts
const result = await guard.run(chunks, output);
// result.graph is a GraphInput for this run
```

Persist it with `toCanonicalJSON` (redacted by default), or through a `GraphStoreAdapter`. `@provguard/neo4j` is one; the in-memory store needs no infrastructure and is the reference implementation, not a stand-in.

From the CLI:

```bash
provguard check input.json --graph run.json
provguard trace   run.json <claim-id>
provguard explain run.json <claim-id>
provguard impact  run.json <source-id>
provguard graph validate run.json    # exits 1 on violations
```

## Adding a judge

Only if you have claims the deterministic ladder leaves uncertain, and only with your own model call — this project never makes one for you. You own the key, the latency, and the failure mode.

```ts
createGuard({ mode: "enforce", judge: async (claim, chunks) => ({/* Grounding */}) });
```

A judge cannot overturn a deterministic decision and can only make an outcome stricter. Its result is recorded as `method: "judge"` so a model-assisted decision is never mistaken for a derived one.

## Observability

Pass any object with `startSpan(name)`. An OpenTelemetry tracer satisfies it structurally; there is no dependency on `@opentelemetry/api`.

```ts
createGuard({ mode: "enforce", tracer: trace.getTracer("provguard") });
```

A tracer that throws is swallowed. Telemetry will not block your traffic.

## Things that will bite you

- **Latency is unmeasured.** `docs/PERFORMANCE.md` measures the graph layer, not the gates. You are putting an unmeasured component in the request path; measure it in your own environment.
- **`Grounding.method` is coarser than the ladder.** Read `ClaimAssessment.decidedBy` if the distinction matters. See `docs/LIMITATIONS.md` §5.
- **Claim extraction is sentence-level.** A fabrication that exists only across a sentence boundary is not caught, and there is a failing scenario proving it.
- **Slots must be declared.** `createGuard` throws for an undeclared slot rather than falling back to a default, because a silent fallback would mean a policy you did not write.
