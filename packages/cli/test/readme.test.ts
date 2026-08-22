import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { formatBenchTable, runBench } from "../src/index.js";

const REPO_ROOT = new URL("../../../", import.meta.url);

/**
 * The README quotes bench output verbatim. Nothing stops that block from going
 * stale when the corpus or the guards change, and a stale block is a published
 * claim that overstates measured results. These tests make drift a build
 * failure: if you change the corpus, you regenerate the README in the same PR.
 */
describe("README bench block", () => {
  it("is byte-identical to generated bench output", async () => {
    const readme = await readRepoFile("README.md");
    const quoted = extractBenchBlock(readme);
    const generated = formatBenchTable(await runBench());

    expect(quoted).toBe(generated.trim());
  });

  it("fails when the quoted block drifts from generated output", async () => {
    // Guards against a vacuous comparison: if extractBenchBlock silently
    // returned "" or the matcher were loose, the test above would pass on a
    // README that says anything at all.
    const readme = await readRepoFile("README.md");
    const tampered = extractBenchBlock(readme).replace("3/8 (37.5%)", "8/8 (100.0%)");
    const generated = formatBenchTable(await runBench());

    expect(tampered).not.toBe(generated.trim());
  });

  it("quotes the measured hard-tier recall rather than a rounded-up claim", async () => {
    const result = await runBench();
    const hardConstructed = result.summary.recall.hard.constructed;

    expect(hardConstructed.numerator).toBeLessThan(hardConstructed.denominator);
    expect(await readRepoFile("README.md")).toContain(hardConstructed.label);
  });
});

describe("README package inventory", () => {
  it("lists every workspace package in the package table", async () => {
    const documented = extractPackageTableNames(await readRepoFile("README.md"));
    const actual = await readdir(new URL("packages/", REPO_ROOT));

    expect([...documented].sort()).toEqual([...actual].sort());
  });

  it("fails when a package is dropped from the table", async () => {
    // Scoping to the table matters: several packages are also named in prose,
    // so a plain "is the string present anywhere" check would pass on a table
    // that had lost the row.
    const documented = extractPackageTableNames(await readRepoFile("README.md"));
    documented.delete("judge");

    expect([...documented].sort()).not.toEqual(
      (await readdir(new URL("packages/", REPO_ROOT))).sort(),
    );
  });
});

describe("README quickstart", () => {
  it("does not reference the emitted CLI path, which is not a stable contract", async () => {
    const readme = await readRepoFile("README.md");

    expect(readme).not.toContain("packages/cli/dist/cli/src/index.js");
    expect(readme).not.toContain("pnpm -r exec tsc -p tsconfig.json");
  });
});

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, REPO_ROOT)), "utf8");
}

/**
 * Returns the contents of the single unlabelled fenced block that carries the
 * bench report. Throws rather than returning a default, so a README that stops
 * quoting the bench fails loudly instead of passing vacuously.
 */
function extractBenchBlock(readme: string): string {
  const lines = readme.split("\n");
  const blocks: string[] = [];
  let open: number | null = null;

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("```")) {
      continue;
    }

    if (open === null) {
      open = index;
    } else {
      blocks.push(lines.slice(open + 1, index).join("\n"));
      open = null;
    }
  }

  const matches = blocks.filter((block) => block.includes("recall on block scenarios:"));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one fenced bench block in README.md, found ${matches.length}`,
    );
  }

  return (matches[0] as string).trim();
}

/**
 * Returns the short names (`schema`, `cli`, ...) of the packages listed as rows
 * in the README package table, ignoring the same names where they appear in
 * prose. Throws if the table is missing.
 */
function extractPackageTableNames(readme: string): Set<string> {
  const rows = readme
    .split("\n")
    .filter((line) => line.startsWith("| `@provguard/"))
    .map((line) => /^\| `@provguard\/([a-z0-9-]+)`/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

  if (rows.length === 0) {
    throw new Error("expected a package table in README.md, found no `@provguard/...` rows");
  }

  return new Set(rows);
}
