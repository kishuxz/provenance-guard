# Neo4j adapter

`@provguard/neo4j` stores the lineage graph in Neo4j. It exists to demonstrate that the graph's semantics do not depend on one vendor, which is only demonstrated by passing the **same** conformance suite the in-memory store passes.

## Neo4j is optional, structurally

Nothing in the core depends on this package. `@provguard/graph`, `@provguard/cli`, and both guards have no dependency on it, and `provguard check`, `bench`, `trace`, `explain`, `impact`, and `graph validate` all work with no database, no network, and no credentials. The offline bench output is byte-identical whether or not this package is installed.

If you never want a database, you never need one. The in-memory store is not a stand-in for "real" storage; it is the reference implementation this adapter is checked against.

## Running it locally

```bash
docker compose -f packages/neo4j/docker-compose.yml up -d

# the integration tests skip unless a database is reachable
PROVGUARD_NEO4J_URI=bolt://localhost:7687 pnpm exec vitest run packages/neo4j

docker compose -f packages/neo4j/docker-compose.yml down -v
```

The credentials in the Compose file are for a local, throwaway instance. They are not a default to carry anywhere that matters.

```ts
import { Neo4jGraphAdapter } from "@provguard/neo4j";

const adapter = new Neo4jGraphAdapter({
  uri: "bolt://localhost:7687",
  username: "neo4j",
  password: "provguardtest",
});

await adapter.initialise(); // idempotent: constraints and indexes use IF NOT EXISTS
await adapter.ingest("acme", graph);
const snapshot = await adapter.snapshot("acme");
await adapter.close();
```

## Storage model

Every node carries `:PgNode` plus its kind; every edge carries `:PgEdge` plus its type. The shared label makes tenant-scoped constraints and sweeps expressible in one statement, and the specific label keeps kind and type filters index-friendly.

`initialise` creates, all with `IF NOT EXISTS`:

- a uniqueness constraint on `(tenantId, id)` for nodes and for edges;
- an index on `(tenantId)`, and on `(tenantId, kind)` for nodes;
- an index on `(tenantId, type)` for edges.

Without those indexes every `trace` degrades to a label scan.

## Tenant isolation

Every statement filters on `tenantId`, and **every value is a parameter**. No caller-supplied value is interpolated into Cypher. String-interpolating a tenant ID would make isolation depend on the caller's input being well formed — the same class of mistake as SQL injection.

Neighbour lookups scope **both** endpoints to the tenant, not just the edge. Matching only the edge's `tenantId` would let a caller who guessed an ID in another tenant walk out of their own data. The conformance suite has a case for exactly this, and it runs unchanged against the real database.

## Atomicity

`ingest` writes the whole batch in one transaction, and structural validation runs _before_ the transaction opens rather than rolling back after a partial write. A half-ingested lineage graph is worse than no graph: it looks complete and is not.

This is verified against a real database, not asserted in a comment — a batch containing a new valid node and one malformed node leaves the database byte-identical to its prior state.

## What is refused and what is not

Refused: structurally corrupt elements, and batches carrying another tenant's elements.

**Not** refused: a graph that fails a semantic invariant. A claim supported by a chunk the guard rejected is still a true record of what happened, and refusing to store it would make the defect unexaminable. Judging the record is `provguard graph validate`'s job, not storage's.

## Round-trip fidelity

A stored graph comes back canonically identical to what was written, and still validates — so IDs survive the round trip. Two details make that work:

- The driver returns integers as its own 64-bit `Integer` type. Every integer in this schema is small (an ordinal, a span offset, an HTTP status), so they are converted back to `number`.
- Neo4j stores scalars, not nested objects, so array attributes are JSON-encoded. `reasonCodes` is the only one today; it is encoded by name rather than by a generic serializer that would silently flatten a future nested field.

## Sensitive data

**The adapter redacts raw material by default.** Chunk, claim and output text are replaced with `[redacted]` before they reach the wire, matching what `toCanonicalJSON` and `toJSONL` already do. A store holding every chunk of raw material a guard ever saw is a standing disclosure risk, and a system whose documentation says redaction is the default should not quietly except its database.

Redaction happens before the values become query parameters, not at the query, because parameters end up in database query logs.

Only non-identity attributes are redacted, so node ids still derive from their remaining fields and a redacted graph still validates and remains queryable by id. What you lose is the ability to read the material back — not the ability to trace it.

### Opting in to raw text

```ts
const adapter = new Neo4jGraphAdapter({
  uri: process.env.PROVGUARD_NEO4J_URI,
  username: process.env.PROVGUARD_NEO4J_USER,
  password: process.env.PROVGUARD_NEO4J_PASSWORD,
  persistRawText: true, // must be the literal boolean
});
```

Turn this on only when you control the database's access, retention and backups, and need the original text for investigation.

**Only the literal boolean `true` enables it.** A string, a number, or any other type throws rather than defaulting, because both silent failures are bad in different directions: `"false"` is truthy and would silently enable raw storage, while quietly ignoring a typo would leave you believing you had switched it on. Neither should be discovered from the contents of a database.

Credentials and stored text never appear in adapter errors — failures report counts and node ids only.

## Limitations

- Performance is not characterised. No figures are published because none have been measured on a declared fixture, and `docs/LIMITATIONS.md` explains why an unmeasured number is worse than none.
- There is no migration tooling. `GRAPH_SCHEMA_VERSION` is checked on import of serialized graphs, but a schema bump would need a migration path written for it.
- This is one adapter demonstrating vendor-neutrality. It is not a claim that Neo4j is a supported production deployment target.
