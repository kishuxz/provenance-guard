import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/index.js";

const OBSERVED_AT = "2026-03-04T10:00:00.000Z";

const CLEAN_INPUT = {
  slot: "signals",
  chunks: [
    {
      id: "doc:1",
      raw: "According to the filed 10-K, the company reported $42 million in revenue.",
      provenance: {
        sourceId: "https://vendor.test/10k",
        channel: "RETRIEVED_DOC",
        upstreamStatus: 200,
      },
    },
  ],
  output: "According to the filed 10-K, the company reported $42 million in revenue.",
};

const POLLUTED_INPUT = {
  slot: "signals",
  chunks: [
    {
      id: "d1:stdout",
      raw: 'HTTP/1.1 400 Bad Request\n\n{"error":{"message":"Unknown parameter: sector_growth."}}',
      provenance: { sourceId: "shell-stdout", upstreamStatus: 400 },
    },
  ],
  output: "Battery suppliers are shifting toward compliance-led forecasting.",
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "provguard-graph-"));
}

function captureStdout(): { lines: () => string } {
  const chunks: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value: unknown) => {
    chunks.push(String(value));
  });
  return { lines: () => chunks.join("\n") };
}

function captureStderr(): { lines: () => string } {
  const chunks: string[] = [];
  vi.spyOn(console, "error").mockImplementation((value: unknown) => {
    chunks.push(String(value));
  });
  return { lines: () => chunks.join("\n") };
}

interface GraphDocument {
  nodes: { id: string; kind: string }[];
  edges: { id: string; type: string }[];
}

async function checkWithGraph(
  input: unknown,
  extraArgs: string[] = [],
): Promise<{ dir: string; graphPath: string; code: number; graph: GraphDocument }> {
  const dir = await workspace();
  const inputPath = join(dir, "input.json");
  const graphPath = join(dir, "graph.json");
  await writeFile(inputPath, JSON.stringify(input));

  const stdout = captureStdout();
  const code = await main([
    "check",
    inputPath,
    "--graph",
    graphPath,
    "--observed-at",
    OBSERVED_AT,
    ...extraArgs,
  ]);
  void stdout;

  const graph = JSON.parse(await readFile(graphPath, "utf8")) as GraphDocument;
  return { dir, graphPath, code, graph };
}

function idOfKind(graph: GraphDocument, kind: string): string {
  const node = graph.nodes.find((candidate) => candidate.kind === kind);
  if (node === undefined) {
    throw new Error(`no ${kind} node in exported graph`);
  }
  return node.id;
}

describe("check --graph", () => {
  it("writes a graph that validates clean", async () => {
    const { graphPath } = await checkWithGraph(CLEAN_INPUT);

    const stdout = captureStdout();
    const code = await main(["graph", "validate", graphPath]);

    expect(code).toBe(0);
    expect(stdout.lines()).toContain("no violations");
  });

  it("redacts raw text by default", async () => {
    const { graphPath } = await checkWithGraph(CLEAN_INPUT);
    const raw = await readFile(graphPath, "utf8");

    expect(raw).not.toContain("filed 10-K");
    expect(raw).toContain("[redacted]");
  });

  it("includes raw text only when --unredacted is passed", async () => {
    const { graphPath } = await checkWithGraph(CLEAN_INPUT, ["--unredacted"]);

    expect(await readFile(graphPath, "utf8")).toContain("filed 10-K");
  });

  it("does not change the check exit code", async () => {
    const clean = await checkWithGraph(CLEAN_INPUT);
    const polluted = await checkWithGraph(POLLUTED_INPUT);

    expect(clean.code).toBe(0);
    expect(polluted.code).toBe(1);
  });

  it("records a refused chunk with no INCLUDED_IN edge", async () => {
    const { graph } = await checkWithGraph(POLLUTED_INPUT);

    expect(graph.nodes.some((node) => node.kind === "Chunk")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "INCLUDED_IN")).toBe(false);
  });
});

describe("determinism", () => {
  it("produces byte-identical graphs for repeated runs with --observed-at", async () => {
    const first = await checkWithGraph(CLEAN_INPUT);
    const second = await checkWithGraph(CLEAN_INPUT);

    expect(await readFile(second.graphPath, "utf8")).toBe(await readFile(first.graphPath, "utf8"));
  });

  it("keeps node ids stable even when the observation time differs", async () => {
    const first = await checkWithGraph(CLEAN_INPUT);

    const dir = await workspace();
    const inputPath = join(dir, "input.json");
    const graphPath = join(dir, "graph.json");
    await writeFile(inputPath, JSON.stringify(CLEAN_INPUT));
    captureStdout();
    await main([
      "check",
      inputPath,
      "--graph",
      graphPath,
      "--observed-at",
      "2030-01-01T00:00:00.000Z",
    ]);

    const later = JSON.parse(await readFile(graphPath, "utf8")) as GraphDocument;

    expect(later.nodes.map((node) => node.id)).toEqual(first.graph.nodes.map((node) => node.id));
  });
});

describe("trace", () => {
  it("reaches the source of a grounded claim and names the edge types", async () => {
    const { graphPath, graph } = await checkWithGraph(CLEAN_INPUT);

    const stdout = captureStdout();
    const code = await main(["trace", graphPath, idOfKind(graph, "Claim")]);
    const output = stdout.lines();

    expect(code).toBe(0);
    expect(output).toContain("https://vendor.test/10k");
    expect(output).toContain("-[SUPPORTED_BY]->");
    expect(output).toContain("-[SPLIT_INTO]->");
  });

  it("says plainly when a claim rests on nothing, and still exits 0", async () => {
    // "No evidence" is an answer, not a command failure. Exiting non-zero
    // would make it indistinguishable from an unreadable file in a pipeline.
    const { graphPath, graph } = await checkWithGraph(POLLUTED_INPUT);

    const stdout = captureStdout();
    const code = await main(["trace", graphPath, idOfKind(graph, "Claim")]);

    expect(code).toBe(0);
    expect(stdout.lines()).toContain("no supporting path");
  });

  it("emits machine-readable output with --json", async () => {
    const { graphPath, graph } = await checkWithGraph(CLEAN_INPUT);

    const stdout = captureStdout();
    await main(["trace", graphPath, idOfKind(graph, "Claim"), "--json"]);

    const parsed = JSON.parse(stdout.lines()) as { paths: unknown[]; truncated: boolean };
    expect(Array.isArray(parsed.paths)).toBe(true);
    expect(parsed.truncated).toBe(false);
  });
});

describe("explain", () => {
  it("reports the decision, method and exact policy version", async () => {
    const { graphPath, graph } = await checkWithGraph(POLLUTED_INPUT);

    const stdout = captureStdout();
    const code = await main(["explain", graphPath, idOfKind(graph, "Claim")]);
    const output = stdout.lines();

    expect(code).toBe(0);
    expect(output).toContain("decision: block");
    expect(output).toContain("method: deterministic");
    expect(output).toMatch(/policy: default@1 \(sha256:/);
  });

  it("marks a monitor-mode decision as not enforced", async () => {
    const { graphPath, graph } = await checkWithGraph(POLLUTED_INPUT, ["--monitor"]);

    const stdout = captureStdout();
    await main(["explain", graphPath, idOfKind(graph, "Claim")]);
    const output = stdout.lines();

    expect(output).toContain("mode: monitor");
    expect(output).toContain("this decision was not enforced");
    // The block is still recorded; monitor mode does not soften it.
    expect(output).toContain("decision: block");
  });

  it("does not invent a decision for a node that has none", async () => {
    const { graphPath, graph } = await checkWithGraph(CLEAN_INPUT);

    const stdout = captureStdout();
    await main(["explain", graphPath, idOfKind(graph, "Artifact")]);

    expect(stdout.lines()).toContain("verdict: none recorded");
  });
});

describe("impact", () => {
  it("reports dependants of a source and whether the output was delivered", async () => {
    const { graphPath, graph } = await checkWithGraph(CLEAN_INPUT);

    const stdout = captureStdout();
    const code = await main(["impact", graphPath, idOfKind(graph, "Source")]);
    const output = stdout.lines();

    expect(code).toBe(0);
    expect(output).toContain("affected claims: 1");
    expect(output).toContain("delivered outputs: 1");
  });

  it("reports no delivered outputs when the run was blocked", async () => {
    const { graphPath, graph } = await checkWithGraph(POLLUTED_INPUT);

    const stdout = captureStdout();
    await main(["impact", graphPath, idOfKind(graph, "Source")]);

    expect(stdout.lines()).toContain("delivered outputs: 0");
  });
});

describe("graph validate", () => {
  it("exits 1 and lists violations for a corrupt graph", async () => {
    const { graphPath } = await checkWithGraph(CLEAN_INPUT, ["--unredacted"]);
    const document = JSON.parse(await readFile(graphPath, "utf8")) as {
      nodes: Record<string, unknown>[];
    };

    // Rewrite a chunk's content hash without recomputing its id: the signature
    // of someone editing history rather than appending to it.
    const chunk = document.nodes.find((node) => node.kind === "Chunk") as Record<string, unknown>;
    chunk.contentHash = "sha256:rewritten";
    await writeFile(graphPath, JSON.stringify(document));

    const stdout = captureStdout();
    const code = await main(["graph", "validate", graphPath]);

    expect(code).toBe(1);
    expect(stdout.lines()).toContain("GRAPH_ID_MISMATCH");
  });

  it("rejects an unknown subcommand rather than guessing", async () => {
    const stderr = captureStderr();
    const code = await main(["graph", "frobnicate", "x.json"]);

    expect(code).toBe(2);
    expect(stderr.lines()).toContain("validate");
  });
});

describe("untrusted graph documents", () => {
  it("refuses a forged-ownership graph rather than serving it", async () => {
    // Graph JSON read from a path is untrusted input. Before this was fixed the
    // CLI loaded it straight into the store, which filtered reads on a tenantId
    // field the document itself supplied.
    const { graphPath } = await checkWithGraph(CLEAN_INPUT, ["--unredacted"]);
    const document = JSON.parse(await readFile(graphPath, "utf8")) as {
      nodes: Record<string, unknown>[];
    };
    const target = document.nodes.find((node) => node.kind === "Run") as Record<string, unknown>;
    target.tenantId = "globex";
    await writeFile(graphPath, JSON.stringify(document));

    const stderr = captureStderr();
    const code = await main(["trace", graphPath, String(target.id), "--tenant", "globex"]);

    expect(code).toBe(2);
    expect(stderr.lines()).toContain("refusing to load");
  });

  it("applies the same refusal to explain and impact", async () => {
    const { graphPath } = await checkWithGraph(CLEAN_INPUT, ["--unredacted"]);
    const document = JSON.parse(await readFile(graphPath, "utf8")) as {
      nodes: Record<string, unknown>[];
    };
    const chunk = document.nodes.find((node) => node.kind === "Chunk") as Record<string, unknown>;
    chunk.contentHash = "sha256:rewritten";
    await writeFile(graphPath, JSON.stringify(document));

    for (const command of ["explain", "impact"]) {
      const stderr = captureStderr();
      const code = await main([command, graphPath, String(chunk.id)]);

      expect(code, command).toBe(2);
      expect(stderr.lines(), command).toContain("refusing to load");
      vi.restoreAllMocks();
    }
  });

  it("still validates and reports on a graph that fails a semantic invariant", async () => {
    // graph validate must keep working on exactly the graphs the store accepts
    // but the invariants reject, or a real defect becomes unexaminable.
    const { graphPath } = await checkWithGraph(CLEAN_INPUT, ["--unredacted"]);
    const document = JSON.parse(await readFile(graphPath, "utf8")) as {
      nodes: Record<string, unknown>[];
    };
    const chunk = document.nodes.find((node) => node.kind === "Chunk") as Record<string, unknown>;
    chunk.admitted = false;
    await writeFile(graphPath, JSON.stringify(document));

    const stdout = captureStdout();
    const code = await main(["graph", "validate", graphPath]);

    expect(code).toBe(1);
    expect(stdout.lines()).toContain("GRAPH_SUPPORT_FROM_BLOCKED_CHUNK");
  });
});

describe("failure modes", () => {
  it("reports a missing node id with a message, not a stack trace", async () => {
    const { graphPath } = await checkWithGraph(CLEAN_INPUT);

    const stderr = captureStderr();
    const code = await main(["trace", graphPath, `pg:local:Claim:${"0".repeat(32)}`]);

    expect(code).toBe(2);
    expect(stderr.lines()).toContain("is not present in tenant local");
  });

  it("reports an unreadable graph file", async () => {
    const stderr = captureStderr();
    const code = await main(["trace", join(await workspace(), "absent.json"), "x"]);

    expect(code).toBe(2);
    expect(stderr.lines().length).toBeGreaterThan(0);
  });

  it("requires a value for --tenant", async () => {
    const stderr = captureStderr();
    const code = await main(["trace", "g.json", "id", "--tenant"]);

    expect(code).toBe(2);
    expect(stderr.lines()).toContain("--tenant requires a value");
  });

  it("will not read another tenant's graph", async () => {
    const { graphPath, graph } = await checkWithGraph(CLEAN_INPUT);

    const stderr = captureStderr();
    const code = await main(["trace", graphPath, idOfKind(graph, "Claim"), "--tenant", "other"]);

    expect(code).toBe(2);
    expect(stderr.lines()).toContain("is not present in tenant other");
  });

  it("prints usage for an unknown command", async () => {
    const stderr = captureStderr();
    const code = await main(["wat"]);

    expect(code).toBe(2);
    expect(stderr.lines()).toContain("provguard trace");
  });
});
