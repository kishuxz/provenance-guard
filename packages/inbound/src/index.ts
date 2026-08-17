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
  | "non_ok_status"
  | "recognized_ok_status"
  | "unrecognized";

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

  if (hints.channel !== undefined && hints.tier !== undefined) {
    return { channel: hints.channel, tier: hints.tier };
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

  if (detectHttpError(text) !== undefined) {
    return "http_error";
  }

  if (detectHtmlError(text) !== undefined) {
    return "html_error";
  }

  if (detectTruncatedJson(trimmed)) {
    return "truncated_json";
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

  return reasons;
}

function detectStatus(text: string, hintedStatus: number | undefined): number | undefined {
  if (hintedStatus !== undefined) {
    return hintedStatus;
  }

  return detectHttpError(text) ?? detectHtmlError(text) ?? detectJsonErrorStatus(text);
}

function detectHttpError(text: string): number | undefined {
  const statusLine = text.match(/^HTTP\/\d(?:\.\d)?\s+([45]\d{2})\b/im);
  if (statusLine?.[1] !== undefined) {
    return Number(statusLine[1]);
  }

  const namedStatus = text.match(
    /\b(400|401|403|404|408|409|410|413|414|415|422|429|500|501|502|503|504)\s+(Bad Request|Unauthorized|Forbidden|Not Found|Request Timeout|Conflict|Gone|Payload Too Large|URI Too Long|Unsupported Media Type|Unprocessable Entity|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
  );

  return namedStatus?.[1] === undefined ? undefined : Number(namedStatus[1]);
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

function detectHtmlError(text: string): number | undefined {
  if (!/<(?:!doctype\s+html|html|head|body)\b/i.test(text)) {
    return undefined;
  }

  const titleOrHeading = text.match(
    /<(?:title|h1)[^>]*>\s*([45]\d{2})\s+([^<]+?)\s*<\/(?:title|h1)>/i,
  );
  if (titleOrHeading?.[1] !== undefined) {
    return Number(titleOrHeading[1]);
  }

  const genericError = text.match(
    /\b(400|401|403|404|408|409|410|413|414|415|422|429|500|501|502|503|504)\b[^<]{0,80}\b(error|bad request|not found|forbidden|unavailable|gateway|timeout)\b/i,
  );

  return genericError?.[1] === undefined ? undefined : Number(genericError[1]);
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
