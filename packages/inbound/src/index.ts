import { createHash } from "node:crypto";

import type {
  ChannelType,
  Chunk,
  ContextSlot,
  CredibilityTier,
  Provenance,
  Reason,
  SlotPolicy,
  Verdict,
} from "@provguard/schema";

export const DEFAULT_POLICY = {
  slots: [
    {
      name: "signals",
      allowedChannels: ["USER_MESSAGE", "RETRIEVED_DOC", "TOOL_RESULT", "AGENT_OUTPUT"],
      minTier: "T3",
    },
    {
      name: "evidence",
      allowedChannels: ["RETRIEVED_DOC", "TOOL_RESULT"],
      minTier: "T3",
    },
    {
      name: "working_memory",
      allowedChannels: ["USER_MESSAGE", "RETRIEVED_DOC", "TOOL_RESULT", "AGENT_OUTPUT"],
      minTier: "T3",
    },
  ],
  defaultRule: {
    decision: "deny",
    appliesWhen: "no_slot_match",
  },
} as const satisfies SlotPolicy;

const TIER_RANK: Record<CredibilityTier, number> = {
  T1: 1,
  T2: 2,
  T3: 3,
  T4: 4,
  T5: 5,
};

export function classifyChunk(raw: string, hints: Partial<Provenance> = {}): Chunk {
  const text = String(raw);
  const trimmed = text.trim();
  const contentHash = hints.contentHash ?? `sha256:${hash(text)}`;
  const sourceId = hints.sourceId ?? `source:${hash(text).slice(0, 16)}`;
  const detectedStatus = detectStatus(text, hints.upstreamStatus);
  const signature = classifySignature(text, trimmed, detectedStatus);
  const inferred = inferProvenance(signature, hints, detectedStatus);

  return {
    id: `chunk:${hash([sourceId, contentHash, text].join("\n")).slice(0, 16)}`,
    text,
    provenance: {
      sourceId,
      channel: inferred.channel,
      tier: inferred.tier,
      retrievedAt: hints.retrievedAt ?? "1970-01-01T00:00:00.000Z",
      contentHash,
      ...(detectedStatus === undefined ? {} : { upstreamStatus: detectedStatus }),
      ...(hints.parentSourceId === undefined ? {} : { parentSourceId: hints.parentSourceId }),
    },
  };
}

export function checkSlot(chunk: Chunk, slot: ContextSlot): Verdict {
  const reasons: Reason[] = payloadReasons(chunk);

  if (!slot.allowedChannels.includes(chunk.provenance.channel)) {
    reasons.push({
      code: "CHANNEL_NOT_PERMITTED",
      message: `Channel ${chunk.provenance.channel} is not permitted in slot ${slot.name}.`,
      chunkId: chunk.id,
    });
  }

  if (!tierMeetsMinimum(chunk.provenance.tier, slot.minTier)) {
    reasons.push({
      code: "TIER_BELOW_MINIMUM",
      message: `Tier ${chunk.provenance.tier} is below minimum ${slot.minTier} for slot ${slot.name}.`,
      chunkId: chunk.id,
    });
  }

  return {
    decision: reasons.length === 0 ? "allow" : "block",
    reasons,
  };
}

export function assembleContext(
  chunks: Chunk[],
  policy: SlotPolicy,
): { assembled: Record<string, Chunk[]>; verdicts: Verdict[] } {
  const assembled: Record<string, Chunk[]> = {};
  const verdicts: Verdict[] = [];

  for (const slot of policy.slots) {
    assembled[slot.name] = [];

    for (const chunk of chunks) {
      const verdict = checkSlot(chunk, slot);
      verdicts.push(verdict);

      if (verdict.decision === "allow") {
        assembled[slot.name]?.push(chunk);
      }
    }
  }

  return { assembled, verdicts };
}

type Signature =
  | "empty"
  | "truncated_json"
  | "http_error"
  | "html_error"
  | "stack_trace"
  | "shell_diagnostic"
  | "degraded_result"
  | "non_ok_status"
  | "recognized_ok_status"
  | "unrecognized";

/** Signatures whose content contradicts any claim of being usable data. */
const SUSPICIOUS_SIGNATURES: readonly Signature[] = [
  "empty",
  "truncated_json",
  "http_error",
  "html_error",
  "stack_trace",
  "shell_diagnostic",
  "degraded_result",
  "non_ok_status",
];

function isSuspicious(signature: Signature): boolean {
  return SUSPICIOUS_SIGNATURES.includes(signature);
}

/**
 * The best tier a channel can justify on its own.
 *
 * A declared tier is a claim about how much the content deserves to be
 * trusted, and a caller can claim anything. The channel bounds it: a cache
 * cannot assert it is verified primary material no matter what it writes in
 * the label. Ceilings only ever lower a declared tier, never raise it.
 */
const TIER_CEILING: Record<ChannelType, CredibilityTier> = {
  USER_MESSAGE: "T1",
  TOOL_RESULT: "T2",
  RETRIEVED_DOC: "T3",
  CACHE: "T4",
  AGENT_OUTPUT: "T4",
  SYSTEM_ALERT: "T5",
  DIAGNOSTIC_LOG: "T5",
  UNLABELED: "T5",
};

/** The more suspicious of two tiers. */
function worseTier(left: CredibilityTier, right: CredibilityTier): CredibilityTier {
  return TIER_RANK[left] >= TIER_RANK[right] ? left : right;
}

function inferProvenance(
  signature: Signature,
  hints: Partial<Provenance>,
  upstreamStatus: number | undefined,
): Pick<Provenance, "channel" | "tier"> {
  if (signature === "http_error" || signature === "html_error" || signature === "non_ok_status") {
    return { channel: "SYSTEM_ALERT", tier: "T5" };
  }

  if (signature === "stack_trace" || signature === "shell_diagnostic") {
    return { channel: "DIAGNOSTIC_LOG", tier: "T5" };
  }

  if (signature === "empty" || signature === "truncated_json") {
    return { channel: "UNLABELED", tier: "T5" };
  }

  if (signature === "degraded_result") {
    return { channel: "DIAGNOSTIC_LOG", tier: "T5" };
  }

  // Nothing in the content contradicts the declaration, so the declared
  // channel stands -- but the tier is still only a claim, capped by what that
  // channel can justify and by whether an explicit ok status backs it up.
  if (hints.channel !== undefined && hints.tier !== undefined) {
    const ceiling =
      signature === "recognized_ok_status"
        ? worseTier(
            TIER_CEILING[hints.channel],
            tierForExplicitOkStatus(hints.channel, upstreamStatus),
          )
        : TIER_CEILING[hints.channel];
    return { channel: hints.channel, tier: worseTier(hints.tier, ceiling) };
  }

  if (signature === "recognized_ok_status" && hints.channel !== undefined) {
    return {
      channel: hints.channel,
      tier: tierForExplicitOkStatus(hints.channel, upstreamStatus),
    };
  }

  return { channel: "UNLABELED", tier: "T5" };
}

function tierForExplicitOkStatus(
  channel: ChannelType,
  upstreamStatus: number | undefined,
): CredibilityTier {
  if (upstreamStatus === undefined || !isOkStatus(upstreamStatus)) {
    return "T5";
  }

  if (channel === "TOOL_RESULT") {
    return "T2";
  }

  if (channel === "RETRIEVED_DOC") {
    return "T3";
  }

  if (channel === "CACHE") {
    return "T4";
  }

  return "T5";
}

function classifySignature(
  text: string,
  trimmed: string,
  upstreamStatus: number | undefined,
): Signature {
  if (trimmed.length === 0) {
    return "empty";
  }

  if (upstreamStatus !== undefined && !isOkStatus(upstreamStatus)) {
    return "non_ok_status";
  }

  if (analyzeErrorResponse(text).isErrorResponse) {
    return "http_error";
  }

  if (detectTruncatedJson(trimmed)) {
    return "truncated_json";
  }

  // A success-shaped payload carrying a fallback or placeholder result is a
  // diagnostic wearing a result's clothes.
  if (detectDegradedResult(text)) {
    return "degraded_result";
  }

  if (detectStackTrace(text)) {
    return "stack_trace";
  }

  if (detectShellDiagnostic(text)) {
    return "shell_diagnostic";
  }

  if (upstreamStatus !== undefined && isOkStatus(upstreamStatus)) {
    return "recognized_ok_status";
  }

  return "unrecognized";
}

function payloadReasons(chunk: Chunk): Reason[] {
  const reasons: Reason[] = [];
  const trimmed = chunk.text.trim();

  if (trimmed.length === 0) {
    reasons.push({
      code: "PAYLOAD_EMPTY",
      message: "Payload is empty or whitespace-only.",
      chunkId: chunk.id,
    });
  }

  if (detectTruncatedJson(trimmed)) {
    reasons.push({
      code: "PAYLOAD_TRUNCATED",
      message: "Payload appears to be truncated JSON.",
      chunkId: chunk.id,
    });
  }

  if (
    chunk.provenance.upstreamStatus !== undefined &&
    !isOkStatus(chunk.provenance.upstreamStatus)
  ) {
    reasons.push({
      code: "UPSTREAM_STATUS_NOT_OK",
      message: `Upstream status ${chunk.provenance.upstreamStatus} is not a 2xx status.`,
      chunkId: chunk.id,
    });
  }

  reasons.push(...labelMismatchReasons(chunk, trimmed));

  return reasons;
}

/** Channels whose contents are meant to be reasoned from as data. */
const DATA_CHANNELS: readonly ChannelType[] = [
  "USER_MESSAGE",
  "RETRIEVED_DOC",
  "TOOL_RESULT",
  "AGENT_OUTPUT",
];

/**
 * Reasons arising from the label disagreeing with the payload.
 *
 * The label is re-checked here rather than trusted from classification,
 * because `checkSlot` is reachable with a chunk any caller assembled by hand.
 * A declaration of `TOOL_RESULT` at `T2` with a 200 status is a claim about
 * the content; if the content says otherwise, the disagreement is itself the
 * finding, and it is reported before the channel and tier consequences so the
 * caller learns why the chunk was reclassified rather than only that it was.
 */
function labelMismatchReasons(chunk: Chunk, trimmed: string): Reason[] {
  const { channel, tier, upstreamStatus } = chunk.provenance;
  const signature = classifySignature(chunk.text, trimmed, upstreamStatus);
  if (!isSuspicious(signature)) {
    return [];
  }

  const reasons: Reason[] = [];
  const claimsSuccess = upstreamStatus !== undefined && isOkStatus(upstreamStatus);
  const claimsData = DATA_CHANNELS.includes(channel) && TIER_RANK[tier] <= TIER_RANK["T3"];

  if (claimsSuccess || claimsData) {
    const claim = claimsSuccess
      ? `status ${String(upstreamStatus)}`
      : `channel ${channel} at tier ${tier}`;
    reasons.push({
      code: "PROVENANCE_LABEL_MISMATCH",
      message: `Payload is classified ${signature} but declares ${claim}.`,
      chunkId: chunk.id,
    });
  }

  if (signature === "degraded_result") {
    reasons.push({
      code: "RESULT_DEGRADED",
      message: "Payload reports success while carrying a fallback or placeholder result.",
      chunkId: chunk.id,
    });
  }

  return reasons;
}

function detectStatus(text: string, hintedStatus: number | undefined): number | undefined {
  if (hintedStatus !== undefined) {
    return hintedStatus;
  }

  return analyzeErrorResponse(text).status;
}

const STATUS_PHRASES =
  "Bad Request|Unauthorized|Forbidden|Not Found|Request Timeout|Conflict|Gone|Payload Too Large|URI Too Long|Unsupported Media Type|Unprocessable Entity|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout|Service Temporarily Unavailable";

/** Words that appear when text is *about* failure as well as when it *is* failure. */
const ERROR_MARKERS =
  /\b(?:error|errors|exception|failed|failure|unavailable|timeout|timed out|denied|forbidden|invalid|unreachable|refused)\b/gi;

/**
 * Whether a payload IS an error response, as opposed to a document that
 * discusses error responses.
 *
 * Matching a status code anywhere in the text cannot tell those apart: an API
 * reference explaining what 404 Not Found means contains the same token as a
 * 404 body. What separates them is structure and proportion. A real error
 * response leads with its status line, carries response headers, and is mostly
 * error. A document about errors mentions a code in the middle of a body that
 * is mostly prose.
 *
 * So structural signals carry nearly all the weight, and marker density can
 * only ever add a little -- never enough on its own to call something an
 * error. A long document about failure stays admissible no matter how many
 * times it says "error".
 */
interface ErrorResponseAnalysis {
  status: number | undefined;
  isErrorResponse: boolean;
  score: number;
  signals: string[];
}

const ERROR_RESPONSE_THRESHOLD = 0.6;

function analyzeErrorResponse(text: string): ErrorResponseAnalysis {
  const signals: string[] = [];
  let score = 0;
  let status: number | undefined;

  const record = (signal: string, weight: number, found: number | undefined): void => {
    signals.push(signal);
    score += weight;
    status ??= found;
  };

  // A status line in the first position is what makes a payload a response.
  // Anchored to the start of the payload, not to the start of any line, so a
  // quoted example inside a document does not qualify.
  const leading = /^[\s\u{FEFF}]*HTTP\/\d(?:\.\d)?\s+([45]\d{2})\b/u.exec(text);
  if (leading?.[1] !== undefined) record("status_line_at_start", 1, Number(leading[1]));

  // A bare "503 Service Unavailable" occupying its own line is a status line
  // with the protocol stripped. Mid-sentence, the same words are prose.
  const bare = new RegExp(
    `^[ \\t]*([45]\\d{2})[ \\t]+(?:${STATUS_PHRASES})[ \\t]*\\r?$`,
    "im",
  ).exec(text);
  if (bare?.[1] !== undefined) record("bare_status_line", 0.6, Number(bare[1]));

  const envelope = detectJsonErrorEnvelope(text);
  if (envelope.found) record("json_error_envelope", 0.8, envelope.status);

  const html = detectHtmlErrorPage(text);
  if (html.found) record("html_error_page", 0.8, html.status);

  if (hasResponseHeaders(text)) record("response_headers", 0.3, undefined);

  // Proportion, deliberately capped below the threshold. This can tip a
  // borderline payload over, never carry one on its own.
  const words = text.split(/\s+/).filter((word) => word.length > 0).length;
  const markers = text.match(ERROR_MARKERS)?.length ?? 0;
  const density = words === 0 ? 0 : markers / words;
  if (density > 0) {
    signals.push(`marker_density=${density.toFixed(3)}`);
    score += Math.min(0.3, density * 2);
  }

  return { status, isErrorResponse: score >= ERROR_RESPONSE_THRESHOLD, score, signals };
}

/** Response header lines clustered at the top of the payload. */
function hasResponseHeaders(text: string): boolean {
  const lines = text.split(/\r?\n/, 8);
  const headers = lines.filter((line) =>
    /^(?:content-type|content-length|date|server|retry-after|x-request-id|www-authenticate):\s*\S/i.test(
      line,
    ),
  );
  return headers.length >= 1;
}

/** A JSON body whose top level is an error envelope, or carries a non-2xx status. */
function detectJsonErrorEnvelope(text: string): { found: boolean; status: number | undefined } {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) {
    return { found: false, status: undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { found: false, status: undefined };
  }

  const status = findStatus(parsed);
  if (status !== undefined && !isOkStatus(status)) {
    return { found: true, status };
  }

  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const error = record["error"];
    // An `error` key holding content, not `"error": null` on a healthy result.
    if (typeof error === "string" ? error.length > 0 : error !== null && error !== undefined) {
      return { found: true, status };
    }
  }

  return { found: false, status: undefined };
}

/** An HTML page whose title or heading is the status itself. */
function detectHtmlErrorPage(text: string): { found: boolean; status: number | undefined } {
  if (!/<(?:!doctype\s+html|html|head|body)\b/i.test(text)) {
    return { found: false, status: undefined };
  }

  const titled = /<(?:title|h1)[^>]*>\s*([45]\d{2})\s+([^<]+?)\s*<\/(?:title|h1)>/i.exec(text);
  if (titled?.[1] !== undefined) {
    return { found: true, status: Number(titled[1]) };
  }

  return { found: false, status: undefined };
}

/**
 * Whether a payload reports success while carrying a fallback, placeholder or
 * otherwise degraded result.
 *
 * This is the shape that defeats every check above: `ok: true`, a 200 status,
 * a well-formed body, and content that quietly says the real work did not
 * happen. It is detected from field *values* in structured payloads, or from
 * repeated markers in short machine-shaped text -- never from a single word in
 * a long document, which is how prose about fallbacks reads.
 */
const DEGRADED_MARKERS =
  /\b(?:fallback|placeholder|substituted|degraded|unreachable|last known|stale|partial results?|best effort|retry exhausted|circuit open|could not reach|no rows returned|default value)\b/i;

function detectDegradedResult(text: string): boolean {
  const trimmed = text.trim();

  if (/^[{[]/.test(trimmed)) {
    try {
      return jsonStringValues(JSON.parse(trimmed)).some((value) => DEGRADED_MARKERS.test(value));
    } catch {
      // Fall through: unparseable JSON is truncation's problem, not this one.
    }
  }

  const words = trimmed.split(/\s+/).filter((word) => word.length > 0).length;
  if (words > 60) {
    return false;
  }
  const matches = trimmed.match(new RegExp(DEGRADED_MARKERS.source, "gi"))?.length ?? 0;
  return matches >= 2;
}

/** Every string value and key in a parsed JSON document, flattened. */
function jsonStringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];

  const out: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    out.push(key);
    out.push(...jsonStringValues(nested));
  }
  return out;
}

function detectJsonErrorStatus(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) {
    return undefined;
  }

  try {
    return findStatus(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function findStatus(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode", "code", "httpStatus"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isInteger(candidate) && isHttpStatus(candidate)) {
      return candidate;
    }
  }

  for (const key of ["error", "response"]) {
    const nested = findStatus(record[key]);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function detectTruncatedJson(text: string): boolean {
  if (!/^[{[]/.test(text)) {
    return false;
  }

  try {
    JSON.parse(text);
    return false;
  } catch {
    return text.endsWith("...") || text.endsWith("…") || hasUnclosedJsonStructure(text);
  }
}

function hasUnclosedJsonStructure(text: string): boolean {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if ((char === "}" || char === "]") && stack.pop() !== char) {
      return false;
    }
  }

  return inString || stack.length > 0;
}

function detectStackTrace(text: string): boolean {
  return [
    /Traceback \(most recent call last\):/i,
    /^\s*File ".+?", line \d+, in .+$/im,
    /^\s*at .+ \(.+:\d+:\d+\)$/m,
    /^\s*at [\w.$<>]+\(?.+:\d+\)?$/m,
    /Exception in thread ".+"/,
    /^\w*(Error|Exception): .+/m,
  ].some((pattern) => pattern.test(text));
}

function detectShellDiagnostic(text: string): boolean {
  return [
    /^(?:zsh|bash|sh|fish|pwsh):\s+.+/im,
    /\b(?:command not found|No such file or directory|Permission denied)\b/i,
    /^(?:fatal|error):\s+.+/im,
    /^npm ERR!\s+.+/im,
    /^yarn (?:error|ERR!)\s+.+/im,
    /^pnpm ERR!\s+.+/im,
  ].some((pattern) => pattern.test(text));
}

function tierMeetsMinimum(tier: CredibilityTier, minTier: CredibilityTier): boolean {
  return TIER_RANK[tier] <= TIER_RANK[minTier];
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status <= 299;
}

function isHttpStatus(status: number): boolean {
  return status >= 100 && status <= 599;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
