#!/usr/bin/env node
/**
 * Clean-room verification that what we would publish actually works.
 *
 * Every other test in this repository runs inside the workspace, where `dist/`
 * exists on disk and every import resolves through pnpm's symlinks. That is why
 * none of them caught HIGH-1: the published tarballs omitted `dist/` entirely
 * and every test stayed green.
 *
 * This script refuses to look at the workspace. It packs real tarballs, reads
 * their contents from `npm pack --json` rather than inferring them, installs
 * them into an empty consumer project, and then imports, executes and
 * type-checks them from there.
 *
 * Exit code 0 means the artifacts we would publish are installable and usable.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Pin the consumer's TypeScript to the version this repo develops against. */
function typescriptVersion() {
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return (root.devDependencies?.typescript ?? "^5.9.2").replace(/^[\^~]/, "");
}
const KEEP = process.argv.includes("--keep");

const failures = [];
function fail(message) {
  failures.push(message);
  console.error(`  FAIL  ${message}`);
}
function ok(message) {
  console.log(`  ok    ${message}`);
}

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.inherit === true ? "inherit" : "pipe",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

/** Publishable packages: everything in the workspace not marked private. */
function publishablePackages() {
  const packagesDir = join(ROOT, "packages");
  const names = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8").includes("packages/*")
    ? execFileSync("ls", [packagesDir], { encoding: "utf8" }).trim().split("\n")
    : [];

  return names
    .map((dir) => ({
      dir: join(packagesDir, dir),
      manifest: JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")),
    }))
    .filter((entry) => entry.manifest.private !== true);
}

/**
 * Paths a consumer can reach: main, module, types, every `exports` target, and
 * every bin. These are the paths that must exist inside the tarball.
 */
function referencedPaths(manifest) {
  const paths = new Set();
  for (const field of ["main", "module", "types", "typings"]) {
    if (typeof manifest[field] === "string") paths.add(manifest[field]);
  }

  const walkExports = (value) => {
    if (typeof value === "string") {
      paths.add(value);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value)) walkExports(nested);
    }
  };
  walkExports(manifest.exports);

  for (const target of Object.values(manifest.bin ?? {})) paths.add(target);

  return [...paths].map((path) => path.replace(/^\.\//, ""));
}

console.log("Building publishable packages...");
run("pnpm", ["build"], ROOT);

const workspace = mkdtempSync(join(tmpdir(), "provguard-packroom-"));
const tarballDir = join(workspace, "tarballs");
const consumer = join(workspace, "consumer");
mkdirSync(tarballDir);
mkdirSync(consumer);

const packages = publishablePackages();
console.log(`\nPacking ${packages.length} publishable packages into ${tarballDir}\n`);

const packed = [];
for (const entry of packages) {
  // `pnpm pack`, not `npm pack`: pnpm rewrites `workspace:*` dependency ranges
  // to real versions. npm does not, so an npm-packed tarball declares
  // dependencies no registry can resolve and fails to install with
  // EUNSUPPORTEDPROTOCOL.
  const raw = run("pnpm", ["pack", "--json", "--pack-destination", tarballDir], entry.dir);
  const report = JSON.parse(raw.slice(raw.indexOf("{")));
  const tarball = report.filename.startsWith("/")
    ? report.filename
    : join(tarballDir, report.filename);

  // Cross-checked against the tarball itself rather than trusted: the manifest
  // of what we packed and what is actually inside it must agree.
  const listed = run("tar", ["-tzf", tarball], workspace)
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("package/") && !line.endsWith("/"))
    .map((line) => line.slice("package/".length));
  const files = new Set(listed);

  const claimed = new Set((report.files ?? []).map((file) => file.path));
  for (const path of claimed) {
    if (!files.has(path)) {
      fail(
        `${entry.manifest.name}: pnpm pack reported ${path} but the tarball does not contain it`,
      );
    }
  }

  // The published manifest is the one inside the tarball, not the workspace one.
  const publishedManifest = JSON.parse(
    run("tar", ["-xOf", tarball, "package/package.json"], workspace),
  );
  for (const [dep, range] of Object.entries(publishedManifest.dependencies ?? {})) {
    if (String(range).startsWith("workspace:")) {
      fail(`${entry.manifest.name}: published manifest still declares ${dep}@${range}`);
    }
  }

  packed.push({ ...entry, tarball, files, publishedManifest });

  const missing = referencedPaths(publishedManifest).filter((path) => !files.has(path));
  if (missing.length > 0) {
    fail(`${entry.manifest.name}: tarball omits referenced path(s): ${missing.join(", ")}`);
  } else {
    ok(
      `${entry.manifest.name}: all ${referencedPaths(publishedManifest).length} referenced paths present`,
    );
  }

  // A declaration map that points at a file we did not ship is a broken
  // reference too, even though nothing in `exports` names it.
  for (const file of files) {
    if (!file.endsWith(".d.ts.map")) continue;
    const map = JSON.parse(run("tar", ["-xOf", tarball, `package/${file}`], workspace));
    for (const source of map.sources ?? []) {
      const target = resolve(dirname(join("/", file)), source).slice(1);
      if (!files.has(target)) {
        fail(`${entry.manifest.name}: ${file} references missing source ${target}`);
      }
    }
  }

  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!files.has(required)) {
      fail(`${entry.manifest.name}: tarball omits ${required}`);
    }
  }

  for (const field of ["description", "repository", "license", "engines"]) {
    if (publishedManifest[field] === undefined) {
      fail(`${entry.manifest.name}: manifest is missing ${field}`);
    }
  }

  if ([...files].some((file) => file.startsWith("test/"))) {
    fail(`${entry.manifest.name}: tarball ships test files`);
  }
}

console.log("\nInstalling tarballs into an empty consumer project\n");
// Overrides force every @provguard dependency to resolve to the tarball we
// just built. Without them npm would go to the registry for the inter-package
// dependencies and verify nothing about what we are shipping.
const overrides = Object.fromEntries(
  packed.map((entry) => [entry.manifest.name, `file:${entry.tarball}`]),
);
writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify(
    {
      name: "provguard-consumer",
      version: "1.0.0",
      type: "module",
      private: true,
      dependencies: overrides,
      devDependencies: { typescript: typescriptVersion() },
      overrides,
    },
    null,
    2,
  )}\n`,
);

try {
  run("npm", ["install", "--no-audit", "--no-fund"], consumer);
  ok("npm install of all tarballs succeeded");
} catch (error) {
  fail(`npm install of tarballs failed: ${String(error.stderr ?? error.message).split("\n")[0]}`);
}

console.log("\nImporting every public entry point from the consumer\n");
for (const entry of packed) {
  const name = entry.manifest.name;
  try {
    const output = run(
      "node",
      [
        "--input-type=module",
        "-e",
        `import * as m from ${JSON.stringify(name)};
        const keys = Object.keys(m);
        if (keys.length === 0) { console.error("no exports"); process.exit(1); }
        console.log(keys.length);`,
      ],
      consumer,
    );
    ok(`import ${name} -> ${output.trim()} exports`);
  } catch (error) {
    fail(
      `import ${name} failed: ${
        String(error.stderr ?? error.message)
          .trim()
          .split("\n")[0]
      }`,
    );
  }
}

console.log("\nExecuting every published binary from the consumer\n");
for (const entry of packed) {
  for (const [bin, target] of Object.entries(entry.manifest.bin ?? {})) {
    const binPath = join(consumer, "node_modules", ".bin", bin);
    if (!existsSync(binPath)) {
      fail(`${entry.manifest.name}: bin ${bin} was not linked (declares ${target})`);
      continue;
    }
    try {
      // No arguments prints usage and exits 2 by contract; that is a
      // successful execution of a real binary, not a crash.
      run("node", [binPath], consumer);
      ok(`bin ${bin} executed`);
    } catch (error) {
      if (error.status === 2) {
        ok(`bin ${bin} executed (usage, exit 2)`);
      } else {
        fail(`bin ${bin} failed with status ${String(error.status)}`);
      }
    }
  }
}

console.log("\nResolving declarations with tsc from the consumer\n");
writeFileSync(
  join(consumer, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        types: [],
      },
      files: ["probe.ts"],
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(consumer, "probe.ts"),
  `${packed
    .map((entry, index) => `import * as m${index} from ${JSON.stringify(entry.manifest.name)};`)
    .join(
      "\n",
    )}\nexport const probe = [${packed.map((_, index) => `m${index}`).join(", ")}].length;\n`,
);

try {
  // The consumer's own installed tsc, not npx: hermetic, and it verifies the
  // declarations resolve under a real consumer's toolchain rather than a
  // transient one.
  run(
    "node",
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    consumer,
  );
  ok("tsc resolved declarations for every package");
} catch (error) {
  const detail = [error.stdout, error.stderr, error.message]
    .map((part) => String(part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("\n")
    .split("\n")
    .slice(0, 6);
  fail(`tsc failed to resolve declarations:\n        ${detail.join("\n        ")}`);
}

if (!KEEP) {
  rmSync(workspace, { recursive: true, force: true });
} else {
  console.log(`\nWorkspace kept at ${workspace}`);
}

console.log("");
if (failures.length > 0) {
  console.error(`pack-install-import: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`pack-install-import: all ${packed.length} publishable packages verified`);
