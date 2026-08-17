import { describe, expect, it } from "vitest";
import { extractClaims } from "../src/index.js";

describe("extractClaims", () => {
  it("returns offsets that slice back to the exact claim text", () => {
    const output = "The service returned 503. Retries were exhausted after four attempts.";
    const claims = extractClaims(output);

    expect(claims.map((c) => c.text)).toEqual([
      "The service returned 503.",
      "Retries were exhausted after four attempts.",
    ]);
    for (const claim of claims) {
      expect(output.slice(claim.spanStart, claim.spanEnd)).toBe(claim.text);
    }
  });

  it("assigns unique ids", () => {
    const claims = extractClaims("Alpha ships on Tuesday. Beta ships on Friday.");
    expect(claims.map((c) => c.id)).toEqual(["claim-0", "claim-1"]);
  });

  it("skips questions", () => {
    const claims = extractClaims("Which region is affected? The outage hit us-east-1 only.");
    expect(claims.map((c) => c.text)).toEqual(["The outage hit us-east-1 only."]);
  });

  it("skips hedged statements", () => {
    const output = [
      "The cache might be stale.",
      "It seems the deploy is queued.",
      "I think the token expired.",
      "The deploy completed at 14:02.",
    ].join(" ");

    expect(extractClaims(output).map((c) => c.text)).toEqual(["The deploy completed at 14:02."]);
  });

  it("does not mistake the month May for a hedge", () => {
    expect(extractClaims("The contract was signed in May by the vendor.")).toHaveLength(1);
  });

  it("skips fenced code blocks", () => {
    const output = [
      "The handler validates the payload first.",
      "",
      "```ts",
      "const total = compute(rows);",
      "return total > 0;",
      "```",
      "",
      "The result is cached for one hour.",
    ].join("\n");

    expect(extractClaims(output).map((c) => c.text)).toEqual([
      "The handler validates the payload first.",
      "The result is cached for one hour.",
    ]);
  });

  it("treats an unterminated fence as code all the way down", () => {
    const output = ["The parser is strict.", "```", "never closed", "still code"].join("\n");
    expect(extractClaims(output).map((c) => c.text)).toEqual(["The parser is strict."]);
  });

  it("skips pure formatting: rules, bare bullets and table separators", () => {
    const output = ["---", "|---|---|", "- ", "###", "The pipeline runs nightly."].join("\n");
    expect(extractClaims(output).map((c) => c.text)).toEqual(["The pipeline runs nightly."]);
  });

  it("strips list markers but keeps the claim and its true offset", () => {
    const output = "- The queue drained in 12 seconds.";
    const claims = extractClaims(output);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).toBe("The queue drained in 12 seconds.");
    expect(output.slice(claims[0]!.spanStart, claims[0]!.spanEnd)).toBe(claims[0]?.text);
  });

  it("does not split on decimals, versions or abbreviations", () => {
    const output = "The library reached v1.2.3 with a 99.95% success rate, i.e. near parity.";
    const claims = extractClaims(output);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).toBe(output);
  });

  it("drops fragments too short to be factual claims", () => {
    const output = "Yes. OK. 42. The migration added three indexes.";
    expect(extractClaims(output).map((c) => c.text)).toEqual([
      "The migration added three indexes.",
    ]);
  });

  it("returns nothing for empty or whitespace-only output", () => {
    expect(extractClaims("")).toEqual([]);
    expect(extractClaims("   \n\n  ")).toEqual([]);
  });

  it("produces spans satisfying the shared Claim contract", () => {
    const claims = extractClaims("The build finished. The tests passed.");
    for (const claim of claims) {
      expect(claim.text.length).toBeGreaterThan(0);
      expect(claim.spanStart).toBeGreaterThanOrEqual(0);
      expect(claim.spanEnd).toBeGreaterThanOrEqual(claim.spanStart);
    }
  });
});
