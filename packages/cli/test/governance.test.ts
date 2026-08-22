import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = new URL("../../../", import.meta.url);

/**
 * These files went missing once already: CLAUDE.md opened by telling the reader
 * to read AGENTS.md, and AGENTS.md was not in the repository. A clean clone
 * could not be governed by the rules it was supposed to follow. Asserting they
 * exist and that cross-references resolve turns that failure into a red build
 * instead of something a reviewer has to notice.
 */
const GOVERNING_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "LICENSE",
  "NOTICE",
  "docs/LIMITATIONS.md",
  "docs/PRODUCT_SPEC.md",
  "docs/GRAPH_ENGINEERING_PLAN.md",
  "docs/AUTONOMOUS_EXECUTION.md",
];

/** Checksum of the verbatim Apache License 2.0 text. */
const APACHE_2_0_MD5 = "86d3f3a95c324c9479bd8986968f4327";

describe("governing files", () => {
  it.each(GOVERNING_FILES)("%s is present and non-empty", async (path) => {
    const contents = await readRepoFile(path);

    expect(contents.trim().length).toBeGreaterThan(0);
  });

  it("resolves every repository-relative markdown link in the governing docs", async () => {
    // A pointer to a file that does not exist is how AGENTS.md went unnoticed.
    const failures: string[] = [];

    for (const path of GOVERNING_FILES.filter((file) => file.endsWith(".md"))) {
      const contents = await readRepoFile(path);
      const base = path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/` : "";

      for (const match of contents.matchAll(/\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
        const target = match[1] as string;
        if (/^[a-z]+:/i.test(target)) {
          continue;
        }

        const resolved = target.startsWith("/") ? target.slice(1) : `${base}${target}`;
        if (!(await exists(resolved))) {
          failures.push(`${path} -> ${target}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("license", () => {
  it("is the unmodified Apache License 2.0", async () => {
    // Compared by checksum rather than by substring: a truncated or edited
    // license is still going to contain the words "Apache License".
    const license = await readRepoFile("LICENSE");

    expect(createHash("md5").update(license).digest("hex")).toBe(APACHE_2_0_MD5);
  });

  it("is declared by the root manifest and every workspace package", async () => {
    const manifests = ["package.json"];
    for (const dir of await readdir(new URL("packages/", REPO_ROOT))) {
      manifests.push(`packages/${dir}/package.json`);
    }

    for (const manifest of manifests) {
      const parsed = JSON.parse(await readRepoFile(manifest)) as { license?: string };
      expect(parsed.license, manifest).toBe("Apache-2.0");
    }
  });

  it("carries a copyright statement in NOTICE", async () => {
    const notice = await readRepoFile("NOTICE");

    expect(notice).toMatch(/Copyright \d{4}/);
    expect(notice).toContain("Apache License, Version 2.0");
  });
});

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, REPO_ROOT)), "utf8");
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await readFile(fileURLToPath(new URL(relativePath, REPO_ROOT)));
    return true;
  } catch {
    return false;
  }
}
