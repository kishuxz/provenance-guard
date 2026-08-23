# Threat model

## What this defends against, stated narrowly

**Accidental context pollution.** Your own plumbing putting something into context that was never evidence: an error page captured from stdout, a cache re-serving a stale body, a partial write leaving a truncated record, a connector substituting a placeholder and reporting success.

No attacker is required. That is the defining property, and it is why input sanitising aimed at hostile strings does not catch any of it. A shell capture that does not distinguish stdout from a data channel is not an attack; it is a pipe.

## What this does **not** defend against

- **Prompt injection.** An adversary who crafts a payload to manipulate your agent is out of scope. Some injected content will happen to trip the inbound classifier, and that is luck, not coverage. Do not deploy this as injection defence.
- **A compromised model or runtime.** If the model is malicious or the process is compromised, a guard running in that process is not a control.
- **A caller who lies to the API.** The guards classify what they are given. A caller that fabricates `Provenance` or asserts a chunk was admitted when it was not is inside the trust boundary.
- **Truth.** A grounded claim is a claim that traces to admitted evidence. If the evidence is wrong, the claim is wrong and grounded. Connectivity in the lineage graph is not truth, and nothing in this system evaluates whether a source is correct.

## Trust boundaries

| Boundary              | Trusted?                                 | Notes                                                                                                                                           |
| --------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller → guards       | Trusted                                  | The caller supplies chunks and their declared provenance.                                                                                       |
| Declared chunk labels | **Not trusted**                          | Since #27, a declared label is treated as a claim: a payload announcing itself as `RETRIEVED_DOC` while carrying an error body is reclassified. |
| Chunk content         | Not trusted                              | It is the thing being judged.                                                                                                                   |
| Judge (if supplied)   | **Not trusted**                          | May only resolve claims the deterministic ladder left uncertain, and only toward stricter. Recorded as `method: "judge"`.                       |
| Tracer (if supplied)  | Not trusted for liveness                 | Wrapped so a throwing tracer cannot block delivery.                                                                                             |
| Storage adapter       | Trusted for integrity, not for judgement | Stores what it is given; `graph validate` judges it.                                                                                            |
| Tenant boundary       | **Enforced**                             | Every read takes `tenantId` as a required argument.                                                                                             |

## Specific threats and the control

**Cross-tenant read.** Every store and adapter method requires `tenantId`; it is not an optional filter. Neighbour lookups scope _both_ endpoints, because that read starts from an ID the caller supplied and is the one most likely to forget the check. Conformance cases cover it, including against a live Neo4j.

**ID forgery.** Node IDs derive from identity fields hashed as canonical JSON, not a delimiter join — otherwise a caller controlling one field could forge another node's identity by moving content across the field boundary. Tenant IDs are restricted to a charset that cannot contain the `:` separator. Both have tests.

**Cypher injection.** Every value is a parameter; no caller-supplied value is interpolated. String-interpolating a tenant ID would make isolation depend on input being well formed.

**History rewriting.** A node whose stored ID does not re-derive from its own fields is reported as `GRAPH_ID_MISMATCH`. Appending is normal; editing is detectable.

**Secret leakage through the ledger.** Source URI credentials are stripped at node creation, so they are never recorded — an export filter only protects copies that pass through it, not the database or the logs. Chunk, claim, and output text are redacted on export by default. Every redactable attribute is a non-identity field, so a redacted export still validates.

**A judge overturning a deterministic decision.** Structurally prevented and tested: a judge asserting everything is grounded cannot turn a deterministic block into an allow.

**Telemetry as a denial-of-service.** A throwing tracer yields a missing span, never a blocked delivery.

## Residual risks, unmitigated

- **Over-blocking.** Now measured, not hypothetical: `mixed-clean-quoted-error`, a genuine incident postmortem quoting a 503, is blocked. See `docs/LIMITATIONS.md`. This is the most likely way this system harms a deployment.
- **Cross-sentence fabrication.** `mixed-cross-sentence-both-grounded` fails. Both halves ground; the fabrication is in the join.
- **Relational and unit fabrication.** Four hard-tier scenarios defeat overlap-based grounding by inverting a relationship, changing a period, or appending a qualifier.
- **Unchecked freshness.** `hard-fresh-timestamp-stale-body` is not caught; nothing compares content freshness against `retrievedAt`.
- **Guard latency is unmeasured.** `docs/PERFORMANCE.md` measures the graph layer, not the gates. A component you put in the request path whose latency you have not measured is a risk you are accepting blind.
- **A bug in the guard blocks legitimate traffic.** This is a new failure mode traded for an existing one. Monitor mode is the mitigation, and it mitigates nothing until you switch to enforcement.

## Reporting

No security contact is configured and there is no disclosure process. For a project at this maturity that is a gap, and it is stated rather than papered over.
