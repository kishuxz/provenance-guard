# Performance

What was measured, on what, and on which machine. `docs/PRODUCT_SPEC.md` requires every performance claim to carry its fixture, runtime environment, median, and p95, so nothing here is quoted without all four.

**These are measurements, not a guarantee.** They come from synthetic fixtures on one laptop. They say how the operations scale with graph size; they do not predict your latency.

## Reproducing

```bash
pnpm build
pnpm perf           # prints the table
pnpm perf --json    # also writes perf-results.json
```

Offline, no dependencies beyond the workspace, no network. `PROVGUARD_PERF_ITERATIONS` overrides the iteration count (default 25).

## Fixtures

Synthetic and parameterised, because a fixture whose size is a parameter is the only way to say how cost scales, and a measurement whose fixture cannot be described is not reportable.

| Fixture              | Nodes | Edges | Derivation depth |
| -------------------- | ----- | ----- | ---------------- |
| `chunks=10 depth=3`  | 74    | 92    | 3                |
| `chunks=100 depth=3` | 704   | 902   | 3                |
| `chunks=500 depth=5` | 4504  | 5502  | 5                |

`chunks` controls breadth — how many source→artifact→chunk→claim strands the graph holds. `depth` is the length of the derivation chain a backward traversal must walk.

## Measured run

Node v20.20.2, darwin/arm64, 12 CPUs, 25 iterations per operation. Median and p95 in milliseconds.

```
operation    fixture             iterations  median_ms  p95_ms
validate     chunks=10 depth=3   25          0.512      1.107
serialize    chunks=10 depth=3   25          0.167      0.213
deserialize  chunks=10 depth=3   25          0.183      0.240
store.load   chunks=10 depth=3   25          0.021      0.026
trace        chunks=10 depth=3   25          0.008      0.023
impact       chunks=10 depth=3   25          0.011      0.022
validate     chunks=100 depth=3  25          3.335      4.119
serialize    chunks=100 depth=3  25          1.459      1.739
deserialize  chunks=100 depth=3  25          1.106      1.427
store.load   chunks=100 depth=3  25          0.086      0.135
trace        chunks=100 depth=3  25          0.005      0.006
impact       chunks=100 depth=3  25          0.009      0.010
validate     chunks=500 depth=5  25          20.747     21.639
serialize    chunks=500 depth=5  25          10.320     11.286
deserialize  chunks=500 depth=5  25          8.050      9.034
store.load   chunks=500 depth=5  25          1.020      1.307
trace        chunks=500 depth=5  25          0.008      0.017
impact       chunks=500 depth=5  25          0.024      0.037
```

Median and p95 are reported rather than a mean. A mean hides the tail, and the tail is what a request-path component is judged on.

## Reading this honestly

- **`validate` dominates, and grows with the graph.** ~0.5 ms at 74 nodes, ~21 ms at 4504. It is the most expensive operation by a wide margin. That is acceptable because validation is not on the request path — it runs over a recorded ledger, not before a delivery. If you put it inline, this is the number that will hurt.
- **`trace` and `impact` are effectively flat** across all three fixtures — single-digit microseconds — because both walk one strand, not the whole graph. Do not read that as "traversal is free at any size": these fixtures are wide and shallow, and a graph where one claim rests on thousands of chunks would behave differently. It has not been measured, so nothing is claimed about it.
- **Serialization is linear and unremarkable**, and roughly half the cost of validation at every size.
- **Nothing here measures the guards themselves.** Inbound classification and outbound grounding are not in this harness, so the added request-path latency of `@provguard/middleware` is **not measured** and no figure is offered for it. `docs/LIMITATIONS.md` §6 is where that gap belongs, and it remains open.
- **The Neo4j adapter is not measured either.** `docs/NEO4J.md` says so; database ingestion cost has not been characterised on a declared fixture.

## What would make these numbers better evidence

Real graphs rather than synthetic ones; a deep-and-narrow fixture to complement the wide-and-shallow ones; measurement of the guards in the request path, which is the number a prospective adopter actually needs. None of that is done, and until it is, the honest summary is that the graph layer is fast enough not to be the thing you worry about, and that the thing you should worry about has not been measured.
