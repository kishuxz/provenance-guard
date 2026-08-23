import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { validateGraph, type ChunkNode, type GraphNode } from "@provguard/graph";

import { createGuard, type CandidateChunk, type GuardMode } from "../src/index.js";

const AT = "2026-03-04T10:00:00.000Z";

const POLLUTED: CandidateChunk[] = [
  {
    id: "d1:stdout",
    text: 'HTTP/1.1 400 Bad Request\n\n{"error":{"message":"Unknown parameter: sector_growth."}}',
    provenance: { sourceId: "shell-stdout", upstreamStatus: 400 },
  },
];

const CLEAN: CandidateChunk[] = [
  {
    id: "doc:1",
    text: "According to the filed 10-K, the company reported $42 million in revenue.",
    provenance: {
      sourceId: "https://vendor.test/10k",
      channel: "RETRIEVED_DOC",
      upstreamStatus: 200,
    },
  },
];

const FABRICATED = "Battery suppliers are shifting toward compliance-led forecasting.";
const GROUNDED = "According to the filed 10-K, the company reported $42 million in revenue.";

function guard(mode: GuardMode) {
  return createGuard({ mode, observedAt: AT });
}

describe("monitor and enforce differ in exactly one way", () => {
  it("records the same decision and reason codes in both modes", async () => {
    // The requirement most easily faked: if monitor mode quietly relaxed the
    // policy, a monitor rollout would produce no usable evidence at all.
    const enforced = await guard("enforce").run(POLLUTED, FABRICATED);
    const monitored = await guard("monitor").run(POLLUTED, FABRICATED);

    expect(monitored.decision).toBe(enforced.decision);
    expect(monitored.reasonCodes).toEqual(enforced.reasonCodes);
    expect(enforced.decision).toBe("block");
  });

  it("differs only in whether the decision was acted on", async () => {
    const enforced = await guard("enforce").run(POLLUTED, FABRICATED);
    const monitored = await guard("monitor").run(POLLUTED, FABRICATED);

    expect(enforced.delivered).toBe(false);
    expect(monitored.delivered).toBe(true);
    expect(enforced.monitored).toBe(false);
    expect(monitored.monitored).toBe(true);
  });

  it("delivers a clean output in both modes", async () => {
    for (const mode of ["monitor", "enforce"] as const) {
      const result = await guard(mode).run(CLEAN, GROUNDED);

      expect(result.decision, mode).toBe("allow");
      expect(result.delivered, mode).toBe(true);
    }
  });
});

describe("monitor mode prevents nothing", () => {
  it("admits a refused chunk into context, and says it would have refused it", async () => {
    // Withholding the chunk would change what the model sees, which is the
    // behavioural change monitor mode exists to avoid. You cannot compare
    // would-block outcomes against real traffic if the traffic is not real.
    const result = guard("monitor").admitContext(POLLUTED);

    expect(result.context.map((chunk) => chunk.id)).toEqual(["d1:stdout"]);
    expect(result.decisions[0]?.wouldRefuse).toBe(true);
    expect(result.decisions[0]?.refused).toBe(false);
  });

  it("keeps the same chunk out of context under enforcement", async () => {
    const result = guard("enforce").admitContext(POLLUTED);

    expect(result.context).toEqual([]);
    expect(result.decisions[0]?.wouldRefuse).toBe(true);
    expect(result.decisions[0]?.refused).toBe(true);
  });

  it("records an identical inbound verdict in both modes", async () => {
    const monitored = guard("monitor").admitContext(POLLUTED);
    const enforced = guard("enforce").admitContext(POLLUTED);

    expect(monitored.decisions[0]?.verdict).toEqual(enforced.decisions[0]?.verdict);
  });

  it("admits a clean chunk in both modes", () => {
    for (const mode of ["monitor", "enforce"] as const) {
      expect(guard(mode).admitContext(CLEAN).context, mode).toHaveLength(1);
    }
  });
});

describe("grounding never rests on refused evidence", () => {
  it("does not ground a claim on a chunk the policy refuses, even in monitor mode", async () => {
    // Monitor mode changes what reaches the model; it must not change what
    // counts as evidence, or the outbound gate would report a claim as
    // supported by material the policy rejected.
    const monitored = await guard("monitor").run(POLLUTED, FABRICATED);

    expect(monitored.decision).toBe("block");
    expect(monitored.reasonCodes.length).toBeGreaterThan(0);
  });
});

describe("the recorded graph", () => {
  it("validates clean in both modes", async () => {
    for (const mode of ["monitor", "enforce"] as const) {
      const result = await guard(mode).run(POLLUTED, FABRICATED);

      expect(validateGraph(result.graph).violations, mode).toEqual([]);
    }
  });

  it("marks the unenforced block as monitored, so it is not mistaken for an allow", async () => {
    const result = await guard("monitor").run(POLLUTED, FABRICATED);
    const verdicts = result.graph.nodes.filter((node) => node.kind === "Verdict");

    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((verdict) => verdict.kind === "Verdict" && verdict.monitored)).toBe(true);
    expect(
      verdicts.some((verdict) => verdict.kind === "Verdict" && verdict.decision === "block"),
    ).toBe(true);
  });

  it("records the refused chunk with admitted false in both modes", async () => {
    for (const mode of ["monitor", "enforce"] as const) {
      const result = await guard(mode).run(POLLUTED, FABRICATED);
      const chunk = result.graph.nodes.find((node): node is ChunkNode => node.kind === "Chunk");

      expect(chunk?.admitted, mode).toBe(false);
    }
  });

  it("records the output as delivered only when it was", async () => {
    const enforced = await guard("enforce").run(POLLUTED, FABRICATED);
    const monitored = await guard("monitor").run(POLLUTED, FABRICATED);

    const outputOf = (nodes: readonly GraphNode[]) => nodes.find((node) => node.kind === "Output");

    expect(outputOf(enforced.graph.nodes)).toMatchObject({ delivered: false });
    expect(outputOf(monitored.graph.nodes)).toMatchObject({ delivered: true });
  });

  it("is identical between modes apart from mode-dependent facts", async () => {
    const enforced = await guard("enforce").run(POLLUTED, FABRICATED);
    const monitored = await guard("monitor").run(POLLUTED, FABRICATED);

    // Same chunks, same claims: only the policy mode, the monitored flag and
    // delivery differ.
    expect(monitored.graph.nodes.filter((node) => node.kind === "Chunk")).toEqual(
      enforced.graph.nodes.filter((node) => node.kind === "Chunk"),
    );
  });
});

describe("the judge stays subordinate", () => {
  it("is not consulted for a claim a deterministic check decided", async () => {
    let called = 0;
    const result = await createGuard({
      mode: "enforce",
      observedAt: AT,
      judge: async (claim) => {
        called += 1;
        return {
          claimId: claim.id,
          status: "grounded",
          supportingChunkIds: [],
          method: "judge",
          score: 1,
        };
      },
    }).run(CLEAN, GROUNDED);

    expect(result.decision).toBe("allow");
    expect(called).toBe(0);
  });

  it("cannot turn a deterministic block into an allow", async () => {
    // A judge that says everything is fine must not overturn the ladder.
    const result = await createGuard({
      mode: "enforce",
      observedAt: AT,
      judge: async (claim) => ({
        claimId: claim.id,
        status: "grounded",
        supportingChunkIds: [],
        method: "judge",
        score: 1,
      }),
    }).run(POLLUTED, FABRICATED);

    expect(result.decision).toBe("block");
    expect(result.delivered).toBe(false);
  });
});

describe("framework neutrality", () => {
  it("declares no web framework dependency", async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };

    const frameworks = ["express", "fastify", "koa", "hapi", "next", "hono", "@types/express"];
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(frameworks, `${name} is a web framework`).not.toContain(name);
      expect(name.startsWith("@provguard/"), `${name} is not a provguard package`).toBe(true);
    }
  });

  it("does not import node:http anywhere in its source", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain("node:http");
    expect(source).not.toContain("express");
  });
});

describe("configuration errors fail loudly", () => {
  it("rejects a slot the policy does not declare", () => {
    expect(() => createGuard({ mode: "enforce", slot: "nonexistent" })).toThrow(/not declared/);
  });
});
