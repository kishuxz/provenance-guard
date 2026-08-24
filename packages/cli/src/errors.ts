import { readFile } from "node:fs/promises";

/**
 * Stable error codes for CLI failures.
 *
 * A public contract: a pipeline may branch on these, so a code must not change
 * meaning. They exist because the alternative — matching on message text — makes
 * every wording improvement a breaking change, and because Node's own errno
 * strings vary by platform.
 */
export const CliErrorCodes = [
  /** A directory was given where a file was expected. */
  "INPUT_IS_DIRECTORY",
  /** The path does not exist. */
  "INPUT_NOT_FOUND",
  /** The path exists but cannot be read. */
  "INPUT_NOT_READABLE",
  /** The file is not valid JSON. */
  "INPUT_MALFORMED_JSON",
  /** The file is not valid JSONL. */
  "INPUT_MALFORMED_JSONL",
  /** The document parsed but is not a usable graph. */
  "INPUT_INVALID_GRAPH",
  /** The document parsed but is not a usable check input. */
  "INPUT_INVALID_CHECK",
  /** The output path could not be written. */
  "OUTPUT_NOT_WRITABLE",
] as const;

export type CliErrorCode = (typeof CliErrorCodes)[number];

/**
 * Documented exit codes.
 *
 * `1` is reserved for "the guard blocked something", which is a *result*, not a
 * failure — a pipeline gates on it. Everything here is the command failing to
 * run at all, which is a different thing and must be distinguishable.
 */
export const EXIT_USAGE = 2;

export class CliError extends Error {
  readonly code: CliErrorCode;
  /** What the user should do about it. */
  readonly hint: string;
  /** The underlying error, kept for `--debug` and never printed by default. */
  override readonly cause: unknown;

  constructor(code: CliErrorCode, message: string, hint: string, cause?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
    this.cause = cause;
  }

  /** Stable machine-readable form for `--json`. */
  toJSON(): { error: { code: CliErrorCode; message: string; hint: string } } {
    return { error: { code: this.code, message: this.message, hint: this.hint } };
  }
}

interface ErrnoLike {
  code?: unknown;
}

/**
 * Reads a file, converting filesystem failures into actionable errors.
 *
 * The path is echoed as the user supplied it, not resolved to an absolute path.
 * A message is a log line and a log line is a disclosure surface; `./graph.json`
 * is as actionable as `/home/alice/customers/acme/graph.json` and says less.
 */
export async function readInputFile(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as ErrnoLike).code;

    if (code === "EISDIR") {
      throw new CliError(
        "INPUT_IS_DIRECTORY",
        `${what} path is a directory, not a file: ${path}`,
        "Pass the path to a file.",
        error,
      );
    }

    if (code === "ENOENT") {
      throw new CliError(
        "INPUT_NOT_FOUND",
        `${what} file does not exist: ${path}`,
        "Check the path, or generate the file first.",
        error,
      );
    }

    if (code === "EACCES" || code === "EPERM") {
      throw new CliError(
        "INPUT_NOT_READABLE",
        `${what} file cannot be read: ${path}`,
        "Check the file's permissions.",
        error,
      );
    }

    throw new CliError(
      "INPUT_NOT_READABLE",
      `${what} file could not be read: ${path}`,
      "Check that the path is a readable file.",
      error,
    );
  }
}

/** Parses JSON, reporting the position of the failure rather than a bare throw. */
export function parseJsonInput(text: string, path: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(
      "INPUT_MALFORMED_JSON",
      `${what} file is not valid JSON: ${path}`,
      detailOf(error),
      error,
    );
  }
}

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Node's JSON messages carry a position, which is the actionable part.
  return message.length > 0 ? message : "Check the file contents.";
}

/**
 * Renders a failure for the terminal.
 *
 * Two lines, no stack. A stack trace tells a user nothing they can act on and
 * buries the one line that does; `--debug` is where the cause belongs.
 */
export function formatCliError(error: CliError, debug: boolean): string {
  const lines = [error.message, `  ${error.hint}`];

  if (debug && error.cause instanceof Error) {
    lines.push(`  cause: ${error.cause.message}`);
    if (typeof error.cause.stack === "string") {
      lines.push(error.cause.stack);
    }
  }

  return lines.join("\n");
}

/** Wraps an unknown throw as a CliError so every failure has a code. */
export function asCliError(error: unknown, code: CliErrorCode, hint: string): CliError {
  if (error instanceof CliError) {
    return error;
  }

  return new CliError(code, error instanceof Error ? error.message : String(error), hint, error);
}
