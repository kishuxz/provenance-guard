import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { main } from "../src/index.js";
import { CliErrorCodes } from "../src/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStderr(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(console, "error").mockImplementation((value: unknown) => {
    chunks.push(String(value));
  });
  return { text: () => chunks.join("\n") };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "provguard-fserr-"));
}

/** Every command that takes a path, so no boundary is left with a raw errno. */
const PATH_COMMANDS: readonly (readonly string[])[] = [
  ["check"],
  ["trace", "some-node-id"],
  ["explain", "some-node-id"],
  ["impact", "some-node-id"],
  ["graph", "validate"],
];

function invocation(command: readonly string[], path: string): string[] {
  return command[0] === "graph"
    ? ["graph", "validate", path]
    : [command[0] as string, path, ...command.slice(1)];
}

describe("a directory where a file was expected", () => {
  it("reports it actionably instead of leaking EISDIR", async () => {
    // The finding: `EISDIR: illegal operation on a directory, read` told the
    // user nothing and was whatever wording Node used on that platform.
    const dir = await workspace();
    const stderr = captureStderr();

    const code = await main(["trace", dir, "some-node-id"]);

    expect(code).toBe(2);
    expect(stderr.text()).toContain("is a directory, not a file");
    expect(stderr.text()).not.toContain("EISDIR");
  });

  it("is handled at every path-taking command", async () => {
    const dir = await workspace();

    for (const command of PATH_COMMANDS) {
      const stderr = captureStderr();
      const code = await main(invocation(command, dir));

      expect(code, command[0]).toBe(2);
      expect(stderr.text(), command[0]).not.toContain("EISDIR");
      vi.restoreAllMocks();
    }
  });
});

describe("missing and unreadable paths", () => {
  it("says the file does not exist rather than ENOENT", async () => {
    const dir = await workspace();
    const stderr = captureStderr();

    const code = await main(["graph", "validate", join(dir, "absent.json")]);

    expect(code).toBe(2);
    expect(stderr.text()).toContain("does not exist");
    expect(stderr.text()).not.toContain("ENOENT");
  });

  it("says the file cannot be read rather than EACCES", async () => {
    if (process.getuid?.() === 0) {
      // root reads anything; the assertion would be vacuous.
      return;
    }

    const dir = await workspace();
    const path = join(dir, "locked.json");
    await writeFile(path, "{}");
    await chmod(path, 0o000);

    const stderr = captureStderr();
    const code = await main(["graph", "validate", path]);

    expect(code).toBe(2);
    expect(stderr.text()).toContain("cannot be read");
    expect(stderr.text()).not.toContain("EACCES");
  });
});

describe("malformed documents", () => {
  it("distinguishes malformed JSON from a well-formed non-graph", async () => {
    // Different problems deserve different messages: a truncated file and a
    // document of the wrong shape leave the user guessing if both say the same.
    const dir = await workspace();
    const broken = join(dir, "broken.json");
    const wrongShape = join(dir, "wrong.json");
    await writeFile(broken, "{not json");
    await writeFile(wrongShape, JSON.stringify({ hello: "world" }));

    const first = captureStderr();
    expect(await main(["graph", "validate", broken])).toBe(2);
    expect(first.text()).toContain("not valid JSON");
    vi.restoreAllMocks();

    const second = captureStderr();
    expect(await main(["graph", "validate", wrongShape])).toBe(2);
    expect(second.text()).toContain("not a valid graph document");
  });

  it("reports a malformed check input", async () => {
    const dir = await workspace();
    const path = join(dir, "input.json");
    await writeFile(path, "{oops");

    const stderr = captureStderr();
    const code = await main(["check", path]);

    expect(code).toBe(2);
    expect(stderr.text()).toContain("not valid JSON");
  });

  it("reports a refused graph document as an input error", async () => {
    const dir = await workspace();
    const path = join(dir, "graph.json");
    // Structurally parseable, but the node id does not derive from its fields.
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        redacted: false,
        nodes: [
          {
            schemaVersion: 1,
            kind: "Run",
            id: `pg:acme:Run:${"0".repeat(32)}`,
            tenantId: "acme",
            observedAt: "2026-03-04T10:00:00.000Z",
            runKey: "r",
            startedAt: "2026-03-04T10:00:00.000Z",
          },
        ],
        edges: [],
      }),
    );

    const stderr = captureStderr();
    const code = await main(["trace", path, "x"]);

    expect(code).toBe(2);
    expect(stderr.text()).toContain("refused");
  });
});

describe("output discipline", () => {
  it("prints no stack trace by default", async () => {
    const dir = await workspace();
    const stderr = captureStderr();

    await main(["trace", dir, "some-node-id"]);

    expect(stderr.text()).not.toMatch(/\n\s+at /);
  });

  it("surfaces the cause only with --debug", async () => {
    const dir = await workspace();

    const quiet = captureStderr();
    await main(["graph", "validate", join(dir, "absent.json")]);
    expect(quiet.text()).not.toContain("cause:");
    vi.restoreAllMocks();

    const loud = captureStderr();
    await main(["graph", "validate", join(dir, "absent.json"), "--debug"]);
    expect(loud.text()).toContain("cause:");
  });

  it("emits a stable machine-readable object with --json", async () => {
    const dir = await workspace();
    const stderr = captureStderr();

    const code = await main(["graph", "validate", join(dir, "absent.json"), "--json"]);

    expect(code).toBe(2);
    const parsed = JSON.parse(stderr.text()) as { error: { code: string; hint: string } };
    expect(CliErrorCodes).toContain(parsed.error.code);
    expect(parsed.error.code).toBe("INPUT_NOT_FOUND");
    expect(parsed.error.hint.length).toBeGreaterThan(0);
  });

  it("does not resolve the supplied path to an absolute path", async () => {
    // A message is a log line and a log line is a disclosure surface. The path
    // the user typed is as actionable as its fully-resolved form and says less.
    const stderr = captureStderr();
    await main(["graph", "validate", "./no-such-graph.json"]);

    expect(stderr.text()).toContain("./no-such-graph.json");
    expect(stderr.text()).not.toContain(process.cwd());
  });
});
