# A worked incident

Incident D1 from arXiv:2606.14589, end to end: what happened, what the guards do, and what the lineage graph lets you ask afterwards.

Every console block below is real output from a clean clone at `9f45234`, not illustrative.

## What happened

1. A Unicode surrogate appeared in a request payload.
2. The JSON serializer raised mid-stream. The write left a truncated body.
3. The upstream returned `HTTP/1.1 400 Bad Request` with a JSON error body naming the parameters it expected: `industry, market, compliance, forecast, risk`. A shell command substitution captured that diagnostic from stdout into the slot where vendor data was supposed to land.
4. The model read the error page as evidence and produced a confident analysis built from the vocabulary of the error message.

Nothing crashed. The retrieval "succeeded", the tool returned, the status field said `ok`, and the test suite stayed green — the output was a well-formed non-empty string, and no assertion knew where the input came from.

## The guards

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

Three inbound reasons, independently: the payload carries a non-2xx upstream status, `SYSTEM_ALERT` is not a channel the `signals` slot accepts, and T5 is below the slot's minimum tier. Any one of them blocks. The outbound gate would have refused the claim anyway, because nothing in admitted context supports it.

## Where did that chunk come from?

```console
$ provguard trace incident.json <chunk-id>
target: pg:local:Chunk:a1ded9d1231109acd1d5c86ecb04e830
kind: Chunk
paths: 2
  path 1:
    Chunk SYSTEM_ALERT/T5 REFUSED pg:local:Chunk:a1ded9d1231109acd1d5c86ecb04e830
      -[SPLIT_INTO]-> Artifact sha256:19777f0e1b57fc2e72290e835f32b07ec0c33a7a44fec7763b65b390ea0fd3b7
      -[PRODUCED]-> Source shell-stdout
  path 2:
    Chunk SYSTEM_ALERT/T5 REFUSED pg:local:Chunk:a1ded9d1231109acd1d5c86ecb04e830
      -[SPLIT_INTO]-> Artifact sha256:19777f0e1b57fc2e72290e835f32b07ec0c33a7a44fec7763b65b390ea0fd3b7
      -[PRODUCED]-> Step retrieve retrieve
      -[PRODUCED]-> Run pg:local:Run:f0a311bc78be67eb004cb69838260d1f
sources: shell-stdout
```

`Source shell-stdout` is the finding. The chunk is recorded as `REFUSED` and it is still in the graph — a refused chunk that nothing can point at is a refusal you cannot audit later.

## Why was the claim blocked, and under what rule?

```console
$ provguard explain incident.json <claim-id>
target: pg:local:Claim:9d35d987d9037af3f1207f6dbd8f6247
kind: Claim
decision: block
method: deterministic
mode: enforce
reasons: CLAIM_UNGROUNDED
policy: default@1 (sha256:6bdb1ef0c4dd82247ec84db591d299f3d5521521d57cf40164b298e3d2b49e0b)
evidence:
  Claim pg:local:Claim:9d35d987d9037af3f1207f6dbd8f6247
```

Four things worth reading:

- `method: deterministic` — no model decided this.
- `mode: enforce` — the decision was acted on. In monitor mode this would additionally print `this decision was not enforced`.
- The policy is identified by **version and content hash**, not just a name, so the exact rule is recoverable.
- `evidence:` lists the claim and nothing else. It rests on nothing. That is the finding, stated as an absence.

## What else depended on that source?

```console
$ provguard impact incident.json <source-id>
origin: pg:local:Source:c6a617861b7b8b2cc074764ac8cdea65
kind: Source
affected claims: 0
affected outputs: 0
delivered outputs: 0
affected runs: 1
  pg:local:Run:f0a311bc78be67eb004cb69838260d1f (distance 1)
```

`delivered outputs: 0` is the number that matters in an incident review: **nothing reached a user.** One run was touched. No claim ever rested on the chunk, because the inbound gate stopped it before context assembly — being bad is not the same as having consequences, and the report distinguishes them.

Had this run in monitor mode, `delivered outputs` would be 1, and the review would be a different conversation.

## Is the record itself trustworthy?

```console
$ provguard graph validate incident.json
graph valid: no violations
$ echo $?
0
```

Every edge endpoint exists, every ID re-derives from its own fields, no declared-acyclic relationship contains a cycle, and the verdict references a policy version that is present. A ledger you cannot check is a ledger you have to trust.

## What this incident does not show

The basic tier catches this class of failure reliably (6/6 derived). The failure modes that are **not** caught are in `docs/LIMITATIONS.md`: paraphrased fabrication, relational inversion, unit shift, appended qualifiers, stale bodies under fresh timestamps, and cross-sentence fabrication. A worked example of something that works is not evidence about the cases that do not.
