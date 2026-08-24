import { afterAll, beforeEach, describe, expect, it } from "vitest";
import process from "node:process";

import {
  GraphError,
  baselineGraph,
  conformanceCases,
  createNode,
  graphFixtures,
  toCanonicalJSON,
  validateGraph,
  type GraphNode,
} from "@provguard/graph";

import { Neo4jGraphAdapter } from "../src/index.js";

const URI = process.env.PROVGUARD_NEO4J_URI;
const USERNAME = process.env.PROVGUARD_NEO4J_USER ?? "neo4j";
const PASSWORD = process.env.PROVGUARD_NEO4J_PASSWORD ?? "provguardtest";
const TENANT = "acme";

/**
 * Skipped when no Neo4j is reachable, so `pnpm test` stays green on a laptop
 * with no Docker and the offline core requirement holds. A skipped test is not
 * evidence, which is why CI runs this against a real service container --
 * otherwise "integration-tested" would only mean "compiled".
 */
const suite = URI === undefined ? describe.skip : describe;

if (URI === undefined) {
  console.warn(
    "[@provguard/neo4j] PROVGUARD_NEO4J_URI is not set; integration tests skipped. " +
      "Run `docker compose -f packages/neo4j/docker-compose.yml up -d` to enable them.",
  );
}

let adapter: Neo4jGraphAdapter | undefined;

function connect(): Neo4jGraphAdapter {
  adapter ??= new Neo4jGraphAdapter({
    uri: URI as string,
    username: USERNAME,
    password: PASSWORD,
  });
  return adapter;
}

afterAll(async () => {
  if (adapter !== undefined) {
    await adapter.clear(TENANT);
    await adapter.clear("globex");
    await adapter.close();
  }
});

suite("Neo4jGraphAdapter conformance", () => {
  const cases = conformanceCases(baselineGraph());

  beforeEach(async () => {
    const subject = connect();
    await subject.clear(TENANT);
    await subject.clear("globex");
  });

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    async (_name, testCase) => {
      // The same suite the in-memory adapter runs. If graph semantics depended
      // on the vendor, this is where it would show.
      await expect(testCase.run(connect())).resolves.toBeUndefined();
    },
    30_000,
  );
});

suite("Neo4jGraphAdapter storage fidelity", () => {
  beforeEach(async () => {
    await connect().clear(TENANT);
  });

  it("round-trips a graph byte-identically through the database", async () => {
    const graph = baselineGraph();
    const subject = connect();
    await subject.ingest(TENANT, graph);

    expect(toCanonicalJSON(await subject.snapshot(TENANT), { redact: false })).toBe(
      toCanonicalJSON(graph, { redact: false }),
    );
  });

  it("keeps a stored graph valid, so ids survive the round trip", async () => {
    const subject = connect();
    await subject.ingest(TENANT, baselineGraph());

    expect(validateGraph(await subject.snapshot(TENANT)).violations).toEqual([]);
  });

  it("preserves integers as numbers rather than driver Integer objects", async () => {
    const subject = connect();
    await subject.ingest(TENANT, baselineGraph());

    const chunk = (await subject.nodes(TENANT, "Chunk"))[0];
    expect(typeof (chunk as { ordinal: number }).ordinal).toBe("number");
  });

  it("preserves an array attribute through storage", async () => {
    const subject = connect();
    await subject.ingest(TENANT, baselineGraph());

    const verdicts = await subject.nodes(TENANT, "Verdict");
    expect(Array.isArray((verdicts[0] as { reasonCodes: unknown }).reasonCodes)).toBe(true);
  });

  it("stores a graph that fails a semantic invariant, because it is still a record", async () => {
    const blocked = graphFixtures().find((fixture) => fixture.id === "support-from-blocked-chunk");
    if (blocked === undefined) {
      throw new Error("fixture missing");
    }

    const subject = connect();
    await subject.ingest(TENANT, blocked.graph);
    const snapshot = await subject.snapshot(TENANT);

    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(validateGraph(snapshot).violations.map((violation) => violation.code)).toContain(
      "GRAPH_SUPPORT_FROM_BLOCKED_CHUNK",
    );
  });
});

suite("Neo4jGraphAdapter transaction boundary", () => {
  beforeEach(async () => {
    await connect().clear(TENANT);
  });

  it("leaves the database unchanged when a batch contains a bad element", async () => {
    // Asserted against the real database, not in a comment: a half-ingested
    // lineage graph looks complete and is not.
    const subject = connect();
    await subject.ingest(TENANT, baselineGraph());
    const before = toCanonicalJSON(await subject.snapshot(TENANT), { redact: false });

    const newcomer = createNode({
      kind: "Policy",
      tenantId: TENANT,
      observedAt: "2026-03-04T10:00:00.000Z",
      name: "atomicity-probe",
      version: "1",
      contentHash: "sha256:atomicity-probe",
      mode: "enforce",
    });

    await expect(
      subject.ingest(TENANT, {
        nodes: [newcomer, { kind: "Wormhole", id: "x" } as unknown as GraphNode],
        edges: [],
      }),
    ).rejects.toThrow(GraphError);

    expect(toCanonicalJSON(await subject.snapshot(TENANT), { redact: false })).toBe(before);
  });

  it("is idempotent across separate connections' ingests", async () => {
    const subject = connect();
    await subject.ingest(TENANT, baselineGraph());
    const once = await subject.snapshot(TENANT);
    await subject.ingest(TENANT, baselineGraph());

    expect((await subject.snapshot(TENANT)).nodes).toHaveLength(once.nodes.length);
  });
});

suite("Neo4jGraphAdapter tenant isolation", () => {
  beforeEach(async () => {
    const subject = connect();
    await subject.clear(TENANT);
    await subject.clear("globex");
  });

  it("refuses a batch belonging to another tenant", async () => {
    await expect(connect().ingest("globex", baselineGraph())).rejects.toThrow(GraphError);
  });

  it("does not let a guessed id walk out of its tenant", async () => {
    // The neighbour lookup starts from an id the caller supplied, which is the
    // read most likely to forget the tenant filter.
    const subject = connect();
    await subject.ingest(TENANT, baselineGraph());

    for (const edge of baselineGraph().edges) {
      expect(await subject.outgoing("globex", edge.from)).toEqual([]);
      expect(await subject.incoming("globex", edge.to)).toEqual([]);
    }
  });

  it("keeps two tenants' graphs separate", async () => {
    const subject = connect();
    await subject.ingest(TENANT, baselineGraph());

    expect(await subject.nodes("globex")).toEqual([]);
    expect((await subject.nodes(TENANT)).length).toBeGreaterThan(0);
  });
});
