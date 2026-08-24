import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import {
  defaultDisabledControl,
  runBench,
  verifyControlEvidence,
  type ControlEvidence,
  type DisabledControl,
} from "../src/index.js";

/**
 * Tests that the benchmark rejects a control which did not process its input.
 *
 * The defect these exist for: the previous design verified only an invocation
 * counter, so `controlInvocations += 1; return CONSTANT` satisfied it and all
 * 15 benchmark tests passed. A counter proves a function was called. These
 * prove it read the chunks it was given, in order, unaltered.
 *
 * Every case below is a control that a counter cannot distinguish from a real
 * one.
 */

/** Runs the bench with a broken control and returns the rejection message. */
async function rejectionFrom(control: DisabledControl): Promise<string> {
  try {
    await runBench({ control });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the benchmark accepted a broken control");
}

/**
 * A synthetic three-chunk scenario.
 *
 * Every scenario in the shipped corpus has exactly one chunk, so ordering,
 * omission and duplication cannot be exercised against it — reversing a
 * one-element list is a no-op. Those properties are real parts of the control
 * contract, so they are tested against a scenario built for the purpose rather
 * than left unverified until the corpus happens to grow.
 */
const MULTI = {
  id: "synthetic-multi-chunk",
  chunks: [
    { id: "c0", text: "First chunk." },
    { id: "c1", text: "Second chunk." },
    { id: "c2", text: "Third chunk." },
  ],
  simulatedOutput: "An output.",
} as unknown as Parameters<DisabledControl>[1];

/** Evidence a faithful control would produce for MULTI. */
function honestEvidence(): ControlEvidence {
  return {
    scenarioId: "synthetic-multi-chunk",
    control: "delivered",
    chunkCount: 3,
    chunkIds: ["c0", "c1", "c2"],
    contentHashes: ["First chunk.", "Second chunk.", "Third chunk."].map(hash16),
    provenanceLabels: ["RETRIEVED_DOC:T3", "RETRIEVED_DOC:T3", "RETRIEVED_DOC:T3"],
    outputHash: hash16("An output."),
  };
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Asserts the verifier rejects a specific corruption of honest evidence. */
function expectVerifierRejects(
  mutate: (evidence: ControlEvidence) => ControlEvidence,
  pattern: RegExp,
): void {
  expect(() => verifyControlEvidence(MULTI, mutate(honestEvidence()))).toThrow(pattern);
}

/** Wraps the real control, corrupting its evidence in one specific way. */
function corrupt(mutate: (evidence: ControlEvidence) => ControlEvidence): DisabledControl {
  return (runtime, scenario) => mutate(defaultDisabledControl(runtime, scenario));
}

describe("the benchmark rejects a control that did not process its input", () => {
  it("rejects the exact PG_FAKE mutation from the adversarial log", async () => {
    // Reproduced verbatim from docs/ADVERSARIAL_TEST_LOG.md. Under the previous
    // design this passed 15/15.
    const fake: DisabledControl = () => ({
      scenarioId: "stdout-capture",
      control: "delivered",
      chunkCount: 1,
      chunkIds: ["c0"],
      contentHashes: ["deadbeef"],
      provenanceLabels: ["RETRIEVED_DOC:T3"],
      outputHash: "deadbeef",
    });

    expect(await rejectionFrom(fake)).toContain("disabled control produced evidence inconsistent");
  });

  it("rejects a control that returns a constant", async () => {
    const constant: DisabledControl = () => ({
      scenarioId: "constant",
      control: "delivered",
      chunkCount: 0,
      chunkIds: [],
      contentHashes: [],
      provenanceLabels: [],
      outputHash: "constant",
    });

    expect(await rejectionFrom(constant)).toContain("reported scenario constant");
  });

  it("rejects a control that returns only one chunk", () => {
    expectVerifierRejects(
      (evidence) => ({
        ...evidence,
        chunkCount: 1,
        chunkIds: evidence.chunkIds.slice(0, 1),
        contentHashes: evidence.contentHashes.slice(0, 1),
        provenanceLabels: evidence.provenanceLabels.slice(0, 1),
      }),
      /saw 1 chunks/,
    );
  });

  it("rejects a control that omits a chunk", () => {
    expectVerifierRejects(
      (evidence) => ({
        ...evidence,
        chunkCount: 2,
        chunkIds: evidence.chunkIds.slice(1),
        contentHashes: evidence.contentHashes.slice(1),
        provenanceLabels: evidence.provenanceLabels.slice(1),
      }),
      /saw 2 chunks/,
    );
  });

  it("rejects a control that duplicates a chunk", () => {
    expectVerifierRejects(
      (evidence) => ({
        ...evidence,
        chunkCount: 4,
        chunkIds: [...evidence.chunkIds, "c2"],
        contentHashes: [...evidence.contentHashes, hash16("Third chunk.")],
        provenanceLabels: [...evidence.provenanceLabels, "RETRIEVED_DOC:T3"],
      }),
      /saw 4 chunks/,
    );
  });

  it("rejects a control that reorders chunks", () => {
    expectVerifierRejects(
      (evidence) => ({
        ...evidence,
        chunkIds: [...evidence.chunkIds].reverse(),
        contentHashes: [...evidence.contentHashes].reverse(),
      }),
      /chunk 0 is c2, expected c0/,
    );
  });

  it("rejects a control that alters chunk content", async () => {
    const altering = corrupt((evidence) => ({
      ...evidence,
      contentHashes: evidence.contentHashes.map(() => "0000000000000000"),
    }));

    expect(await rejectionFrom(altering)).toContain("content was altered in transit");
  });

  it("rejects a control that manufactures identifiers", async () => {
    const forging = corrupt((evidence) => ({
      ...evidence,
      chunkIds: evidence.chunkIds.map((_id, index) => `manufactured-${index}`),
    }));

    expect(await rejectionFrom(forging)).toContain("expected");
  });

  it("rejects a control that alters the output", async () => {
    const rewriting = corrupt((evidence) => ({ ...evidence, outputHash: "0000000000000000" }));

    expect(await rejectionFrom(rewriting)).toContain("output was altered in transit");
  });

  it("rejects a control that withholds, since an unguarded pipeline cannot", async () => {
    const withholding = corrupt((evidence) => ({ ...evidence, control: "withheld" as const }));

    expect(await rejectionFrom(withholding)).toContain("withholds nothing");
  });

  it("rejects a control that emits an unusable provenance label", async () => {
    const unlabelled = corrupt((evidence) => ({
      ...evidence,
      provenanceLabels: evidence.provenanceLabels.map(() => ""),
    }));

    expect(await rejectionFrom(unlabelled)).toContain("provenance label");
  });
});

describe("the real control satisfies its own contract", () => {
  it("accepts the default control for every scenario", async () => {
    // The counterweight: a verifier that rejects everything would pass all the
    // tests above and be useless.
    await expect(runBench()).resolves.toBeDefined();
  });

  it("verifies evidence directly against the scenario it came from", async () => {
    const result = await runBench();

    expect(result.summary.controlInvocations).toBe(result.scenarios.length);
  });

  it("accepts honest multi-chunk evidence", () => {
    // The counterweight to the rejection cases: a verifier that rejected
    // everything would pass all of them and be worthless.
    expect(() => verifyControlEvidence(MULTI, honestEvidence())).not.toThrow();
  });

  it("records that the shipped corpus is entirely single-chunk", async () => {
    // Not an assertion about what the corpus should be — a guard so that the
    // ordering cases above are known to rely on MULTI rather than silently
    // becoming corpus-covered without anyone noticing.
    const { listScenarios } = (await import("@provguard/harness")) as {
      listScenarios: () => { chunks: unknown[] }[];
    };

    expect(listScenarios().every((scenario) => scenario.chunks.length === 1)).toBe(true);
  });
});
