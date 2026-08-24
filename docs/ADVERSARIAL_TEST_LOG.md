# Adversarial test log

## What this is, and is not

**The author of this log also wrote the code it tests.** Every commit from #30 through #70 is the same author's work, including the packaging verifier, the benchmark control, the graph validation and the Neo4j redaction examined below.

- **This is not an independent review.**
- **No release verdict is supplied here**, and none should be inferred. A verdict from the implementer is a self-certification, and two of the findings below are defects in this author's own remediation that this author's own tests passed.
- The `docs/PRODUCT_SPEC.md` criterion "a tagged release follows independent engineering review" remains **open** and cannot be closed by this document.

It is published because the testing found real defects and the evidence is worth keeping where a genuinely separate reviewer can start from it.

## Commit tested

`4edb675edf6e627ff4cfd52e5455511f0fddda70`

## Environment

|                 |                                                                   |
| --------------- | ----------------------------------------------------------------- |
| OS              | Darwin 25.5.0 arm64                                               |
| Node            | v20.20.2                                                          |
| pnpm            | 10.14.0                                                           |
| npm             | 10.8.2                                                            |
| Neo4j           | 5.26.29 (`neo4j:5-community`)                                     |
| Workspace       | fresh `git clone` to `/tmp/pg-adv`, no cached build output        |
| Neo4j container | `pgreview-neo4j-7690`, host port 7690, created for this test only |

## The first attack run was invalid

The first pass reported that the guards blocked **every** attack, including three inputs constructed to be legitimate. That looked like a strong result and was worthless.

The cause: chunks were supplied with no provenance hints.

```js
chunks.map((t, i) => ({ id: `c${i}`, text: t })); // no provenance
```

Unlabelled content is classified `UNLABELED` at tier T5 and refused by the inbound guard, exactly as designed. So nothing reached the outbound gate, every result was an inbound refusal, and neither the false-negative nor the false-positive column measured what it claimed to.

The corrected harness supplies admitted evidence:

```js
const prov = { channel: "RETRIEVED_DOC", tier: "T3", upstreamStatus: 200 };
chunks.map((t, i) => ({ id: `c${i}`, text: t, provenance: { ...prov, sourceId: `s${i}` } }));
```

and asserts `admitted === chunks.length` before drawing any conclusion. This is recorded because the failure mode — a test harness that appears to confirm the system while exercising a different code path — is the same one this project exists to catch, and it caught the author.

## Corrected results

All rows below admitted 1/1 or 2/2 chunks, confirming the outbound gate was actually reached.

### Should allow — no false positives observed

| Input                                | Verdict |
| ------------------------------------ | ------- |
| Verbatim restatement of the chunk    | allow   |
| Postmortem quoting `404 Not Found`   | allow   |
| Guide describing `HTTP 500` handling | allow   |

### Should block — four false negatives

| Attack                                                     | Verdict   | Documented before this log?                      |
| ---------------------------------------------------------- | --------- | ------------------------------------------------ |
| Unicode homoglyph (Cyrillic `о` in "milliоn")              | **allow** | no                                               |
| Negation flip ("did **not** report $42 million")           | **allow** | only as the general "relational inversion" class |
| Contradictory evidence ($42m and $7m chunks both admitted) | **allow** | no                                               |
| Fabrication inside a fenced code block                     | **allow** | yes, but its consequence was understated         |
| Zero-width character inside the number                     | block     | —                                                |
| Hedged fabrication                                         | allow     | yes, §4                                          |
| Question-form fabrication                                  | allow     | yes, §4                                          |

## Findings

### HIGH — the disabled control can be gutted with every benchmark test still passing

The control's body was replaced with a constant, keeping only the counter increment:

```js
controlInvocations += 1;
if (process.env.PG_FAKE === "1") {
  return { control: "delivered", admittedChunks: 1 };
}
```

**Result: 15/15 benchmark tests passed.**

The invocation counter proves the function was _called_, not that it _processed anything_. `docs/REMEDIATION_REPORT.md` claimed "an invocation-count assertion, so a loop that executes nothing cannot report a clean result" — **that claim was false as written**, and is corrected there.

This is HIGH-2's defect class, a constant presented as a measurement, reintroduced inside the fix for HIGH-2.

Tracked and repaired as B3.

### MEDIUM — the pack verifier could not detect an undeclared runtime dependency

Mutation: delete `zod` from `@provguard/schema`'s manifest.

```console
$ pnpm pack-check
pack-install-import: all 9 publishable packages verified
```

A real consumer installing that package alone:

```
BROKEN: ERR_MODULE_NOT_FOUND | Cannot find package 'zod'
       imported from .../node_modules/@provguard/schema/dist/index.js
```

Cause: the verifier installed all nine tarballs into **one shared consumer**, so `zod` — declared by `@provguard/graph` — hoisted into a shared `node_modules` and masked the omission. This is HIGH-1's class, verification not matching how a real consumer installs, inside the verifier built to fix HIGH-1.

**Not shipping broken at `4edb675`.** Every package was solo-installed and imported successfully:

```
@provguard/schema        OK 20 exports
@provguard/inbound       OK 4
@provguard/outbound      OK 16
@provguard/judge         OK 3
@provguard/graph         OK 56
@provguard/harness       OK 4
@provguard/middleware    OK 5
@provguard/cli           OK 7
@provguard/neo4j         OK 3
```

The finding is a latent gap in the guard, not a live break. Tracked and repaired as P3.

### MEDIUM — three undocumented outbound false negatives

Unicode homoglyph substitution, negation flips and contradictory evidence all pass the outbound gate. `CONTRADICTED_BY` exists in the graph model and nothing populates it.

Tracked as E2 and as documented limitations.

### LOW — the fenced-code bypass is understated

`docs/LIMITATIONS.md` §4 records that fenced code is deliberately excluded from claim extraction. It did not state the practical consequence: wrapping fabricated output in a code fence bypasses the outbound gate entirely.

## Claims verified

Reproduced independently of the documents that assert them.

| Claim                                 | Evidence                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Clean-clone gate passes               | install, build, typecheck, lint, format all PASS                                                |
| Test suite                            | **462 passed, 28 skipped**                                                                      |
| Neo4j integration executes, not skips | **43/43 passed** against Neo4j 5.26.29                                                          |
| Neo4j redacts at rest                 | direct Cypher, bypassing the adapter: `Chunk/Claim/Output` all `"[redacted]"`, leak count **0** |
| Packaging sound at this commit        | all nine solo-install and import                                                                |
| npm-vs-pnpm packing correction        | reproduced                                                                                      |
| No known vulnerabilities              | `pnpm audit --audit-level moderate`                                                             |
| No install scripts in dependency tree | **zero** `preinstall`/`install`/`postinstall` across `node_modules/.pnpm`                       |

## Remaining uncertainty

- **The attack corpus is small and author-written.** Twelve inputs by the person who wrote the guards. Absence of further false positives here is weak evidence.
- **Only the outbound gate was attacked systematically.** Inbound classification was exercised incidentally.
- **No fuzzing, no property-based testing, no real traffic.**
- **The three legitimate inputs that passed are the author's idea of legitimate.** The corpus's own `mixed-clean-quoted-error` remains a confirmed false positive, so "no false positives observed here" does not generalise.
- **Whether the four false negatives are fixable without materially raising false positives is unmeasured** at the time of writing.
- **This log cannot establish its own trustworthiness.** It was produced by the implementer.
