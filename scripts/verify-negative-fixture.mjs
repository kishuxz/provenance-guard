#!/usr/bin/env node
/**
 * Proves the pack verifier can fail.
 *
 * A guard that has never been demonstrated failing is not a guard. This removes
 * `zod` from @provguard/schema's manifest — an undeclared runtime dependency, a
 * real and common publishing defect — runs the verifier, and asserts it is
 * rejected.
 *
 * The shared-consumer verifier accepted exactly this mutation: `zod` was
 * declared by @provguard/graph and hoisted into the shared node_modules,
 * satisfying schema's undeclared import. Solo consumers close that hole.
 *
 * The manifest is always restored, including on failure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "packages", "schema", "package.json");
const original = readFileSync(MANIFEST, "utf8");

let rejected = false;
let detail = "";

try {
  const manifest = JSON.parse(original);
  if (manifest.dependencies?.zod === undefined) {
    console.error("negative fixture is stale: @provguard/schema no longer declares zod");
    process.exit(1);
  }
  delete manifest.dependencies.zod;
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("fixture applied: removed zod from @provguard/schema dependencies\n");

  try {
    execFileSync("node", [join(ROOT, "scripts", "pack-install-import.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    rejected = true;
    // `fail()` writes to stderr; the summary line goes to stderr too.
    detail = `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`
      .split("\n")
      .filter((line) => line.includes("FAIL") || line.includes("failure"))
      .slice(0, 4)
      .join("\n");
  }
} finally {
  writeFileSync(MANIFEST, original);
  console.log("fixture reverted: @provguard/schema manifest restored");
}

console.log("");
if (!rejected) {
  console.error(
    "NEGATIVE FIXTURE FAILED: the verifier accepted a package with an undeclared\n" +
      "runtime dependency. A consumer installing it alone would get ERR_MODULE_NOT_FOUND.",
  );
  process.exit(1);
}

console.log("negative fixture rejected as expected:");
console.log(detail || "  (verifier exited non-zero)");
