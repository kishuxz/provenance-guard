import { describe, expect, it, vi } from "vitest";

import { main, renderDemo, runWalkthrough } from "../src/demo.js";
import { FABRICATED_ANALYSIS, SCENARIO_ID } from "../src/chain.js";

describe("the walkthrough runs", () => {
  it("prints when executed, without throwing", () => {
    const printed: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });

    try {
      main();
    } finally {
      spy.mockRestore();
    }

    expect(printed.length).toBeGreaterThan(60);
    expect(printed.join("\n")).toContain("PROVENANCE GUARD");
  });

  it("cites the harness scenario it dramatizes", () => {
    const text = renderDemo().join("\n");
    expect(text).toContain(SCENARIO_ID);
    expect(text).toContain("arXiv:2606.14589");
  });

  it("is deterministic across runs", () => {
    expect(renderDemo()).toEqual(renderDemo());
  });
});

describe("pass 1 - guards disabled", () => {
  it("walks every step of the chain", () => {
    const text = renderDemo().join("\n");
    for (const step of [
      "Step 1 of 5",
      "Step 2 of 5",
      "Step 3 of 5",
      "Step 4 of 5",
      "Step 5 of 5",
    ]) {
      expect(text).toContain(step);
    }
  });

  it("shows the malformed byte, the truncated write and the HTTP 400 page", () => {
    const text = renderDemo().join("\n");

    expect(text).toContain("U+D800");
    expect(text).toContain('"status":"fil'); // the write stops mid-token
    expect(text).toContain("HTTP/1.1 400 Bad Request");
    expect(text).toContain("2>&1"); // the capture that files stderr as data
  });

  it("delivers the fabricated analysis in full", () => {
    const text = renderDemo().join("\n");
    // Wrapping breaks the paragraph across lines, so compare on collapsed whitespace.
    const collapsed = text.replace(/\s+/g, " ");
    expect(collapsed).toContain(FABRICATED_ANALYSIS);
  });

  it("ends by reporting that nothing went wrong", () => {
    const text = renderDemo().join("\n");
    expect(text).toContain("errors=0");
    expect(text).toContain("checks_passed=4/4");
    expect(text).toContain("No error was raised");
  });
});

describe("pass 2 - guards enabled", () => {
  it("rejects every captured chunk before the agent sees it", () => {
    const result = runWalkthrough();

    expect(result.inbound).toHaveLength(2);
    for (const decision of result.inbound) {
      expect(decision.verdict.decision, decision.label).toBe("block");
      expect(decision.verdict.reasons.length).toBeGreaterThan(0);
    }
  });

  it("rejects the truncated body and the error page for the right reasons", () => {
    const result = runWalkthrough();
    const codesFor = (label: string): string[] =>
      result.inbound.find((d) => d.label.includes(label))?.verdict.reasons.map((r) => r.code) ?? [];

    expect(codesFor("truncated")).toContain("PAYLOAD_TRUNCATED");
    expect(codesFor("HTTP 400")).toContain("UPSTREAM_STATUS_NOT_OK");
    for (const label of ["truncated", "HTTP 400"]) {
      expect(codesFor(label), label).toContain("CHANNEL_NOT_PERMITTED");
      expect(codesFor(label), label).toContain("TIER_BELOW_MINIMUM");
    }
  });

  it("leaves the agent with an empty signals slot", () => {
    expect(runWalkthrough().signalsSlot).toEqual([]);
  });

  it("blocks the fabricated paragraph, with a reason for every claim", () => {
    const result = runWalkthrough();

    expect(result.outboundVerdict.decision).toBe("block");
    expect(result.claims).toHaveLength(3);
    for (const assessment of result.claims) {
      expect(assessment.grounding.status, assessment.claim.text).toBe("ungrounded");
      expect(assessment.reason?.code, assessment.claim.text).toBeTruthy();
    }
  });

  it("distinguishes an invented claim from one propped up by the error text", () => {
    const result = runWalkthrough();
    const codes = result.claims.map((assessment) => assessment.reason?.code);

    // "Our scan covered 400 supplier disclosures" is only 'supported' because
    // 400 was the HTTP status on the error page -- a T5 chunk.
    expect(codes).toContain("CLAIM_SUPPORT_LOW_TIER");
    // The invented suppliers and dates have no support at all.
    expect(codes).toContain("CLAIM_UNGROUNDED");
  });

  it("prints each claim with its reason code", () => {
    const text = renderDemo().join("\n");

    expect(text).toContain("CLAIM_SUPPORT_LOW_TIER");
    expect(text).toContain("CLAIM_UNGROUNDED");
    expect(text).toContain("OUTBOUND VERDICT: BLOCK");
  });
});

describe("the closing summary", () => {
  it("contrasts the two outcomes in two lines", () => {
    const lines = renderDemo();
    const guardsOff = lines.find((line) => line.includes("Guards off:"));
    const guardsOn = lines.find((line) => line.includes("Guards on:"));

    expect(guardsOff).toBeDefined();
    expect(guardsOn).toBeDefined();
    expect(guardsOff).toContain("delivered");
    expect(guardsOn).toContain("blocked");
  });

  it("keeps narration within terminal width", () => {
    // Quoted evidence is exempt: the payloads are shown verbatim, because
    // wrapping a truncated JSON body would hide where it actually stops.
    const narration = renderDemo().filter((line) => !line.trimStart().startsWith("|"));

    for (const line of narration) {
      expect(line.length, line).toBeLessThanOrEqual(78);
    }
  });
});
