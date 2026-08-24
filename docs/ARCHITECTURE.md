# Architecture

## The shape of the thing

Two gates and a ledger.

```
                   ┌─────────────────────────────────────────┐
   sources ──────► │ INBOUND: classify → admit or refuse      │
   tools           └────────────────┬────────────────────────┘
   caches                           │ admitted chunks
                                    ▼
                              context assembly
                                    │
                                    ▼
                                  model
                                    │ candidate output
                                    ▼
                   ┌─────────────────────────────────────────┐
                   │ OUTBOUND: extract claims → ground → rule │
                   └────────────────┬────────────────────────┘
                                    │ allow / block
                                    ▼
                                  user

        every decision above is appended to ─────► LINEAGE GRAPH
```

The gates are synchronous and in the request path. That is the whole design premise and its main cost: `docs/LIMITATIONS.md` §6 is explicit that this is a high adoption bar, and monitor mode exists because of it.

The graph is a record, not a participant. Nothing in the gates reads from it to make a decision. That separation matters: if a verdict depended on the graph, a corrupt ledger could change an outcome, and the ledger's job is to be auditable rather than authoritative.

## Packages, and why the boundaries are where they are

| Package                 | Depends on                         | Why it is separate                                                               |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `@provguard/schema`     | zod                                | The shared vocabulary. Everything speaks it; it speaks to nothing.               |
| `@provguard/inbound`    | schema                             | Classification and slot admission. No knowledge of claims.                       |
| `@provguard/outbound`   | schema                             | Claim extraction and grounding. No knowledge of channels or slots.               |
| `@provguard/judge`      | schema, outbound                   | Optional. Isolated so the deterministic ladder cannot accidentally depend on it. |
| `@provguard/graph`      | schema                             | The lineage model. Does **not** import the guards — see below.                   |
| `@provguard/harness`    | schema                             | Scenarios as data, so the bench and the tests share one corpus.                  |
| `@provguard/middleware` | schema, inbound, outbound, graph   | The inline entry point. No framework, no HTTP.                                   |
| `@provguard/cli`        | all of the above                   | Contracts for humans and CI.                                                     |
| `@provguard/neo4j`      | graph                              | Optional adapter. Nothing depends on it.                                         |
| `@provguard/demo`       | schema, inbound, outbound, harness | A narrated walkthrough.                                                          |

Three boundaries carry real weight:

**`@provguard/graph` does not import the guards.** It records what they decided, via a neutral `RunAudit` expressed in shared schema types. A dependency in that direction would make the lineage model track guard internals, so every refactor of a detector would become a graph change.

**`@provguard/neo4j` is not depended on by anything.** `AGENTS.md` requires core packages to work with no network, key, or database. That is enforced structurally rather than by convention: `pnpm test` with no database passes, and bench output is byte-identical with the adapter absent.

**`@provguard/judge` is separate from `@provguard/outbound`.** The judge may only resolve claims the deterministic ladder left explicitly uncertain, and may only make an outcome stricter. Keeping it in its own package makes an accidental dependency from the deterministic path visible in a manifest.

## Determinism, and where it stops

Deterministic: reason codes, verdicts, claim extraction, the grounding ladder, node and edge IDs, canonical serialization, traversal order, validation report order, and the bench.

Not deterministic, deliberately: `observedAt` on graph nodes, which is wall-clock time because it means "when this fact entered the ledger". It is excluded from identity, so IDs are stable regardless — and `--observed-at` pins it when byte-reproducible output is needed.

The judge is deterministic in its default fixture form (a claim and its chunk set hash to a stable key). A caller-supplied live judge is not, which is why a judge result is recorded as `method: "judge"` and can never be relabelled.

## Failure posture

Malformed input fails closed with a typed error rather than a coerced value: a node that exists but is wrong will be traversed, exported, and cited. Unverifiable claims block by default. Unrecognised chunks are `UNLABELED` at the lowest tier rather than given the benefit of the doubt.

Two deliberate exceptions:

- **Telemetry never fails closed.** A tracer that throws yields a missing span, not a blocked delivery.
- **Storage is not a validator.** A graph that fails a semantic invariant is stored, because it is still a true record of what happened and refusing it would make the defect unexaminable.

## What is not here

No retrieval, no model calls, no prompt construction, no storage of raw material beyond what a caller hands over. See `docs/LIMITATIONS.md` for what the measurements do and do not support.

## Storage and sensitive data

Serialization and the Neo4j adapter share one rule: **raw material is redacted by default and raw persistence is an explicit opt-in.** Redaction touches only non-identity attributes, so ids derive, graphs validate, and traversals behave identically whether or not text was stored.

The asymmetry to keep in mind is that `Source.uri` is _not_ redactable — it is an identity field — so credentials are stripped when the node is created rather than when it is exported or stored. A secret that reaches storage has already leaked; an export filter only protects the copies that pass through it.
