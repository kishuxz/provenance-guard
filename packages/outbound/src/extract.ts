import type { Claim } from "@provguard/schema";
import { tokenize } from "./text.js";

/**
 * Abbreviations whose trailing period is not a sentence boundary. Single
 * letters ("e.g.", "U.S.", "J. Smith") are handled separately by length.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "al",
  "approx",
  "apr",
  "aug",
  "avg",
  "cf",
  "co",
  "corp",
  "dec",
  "dept",
  "dr",
  "eg",
  "est",
  "etc",
  "feb",
  "fig",
  "gen",
  "ie",
  "inc",
  "jan",
  "jr",
  "jul",
  "jun",
  "ltd",
  "mar",
  "max",
  "min",
  "mr",
  "mrs",
  "ms",
  "mt",
  "no",
  "nov",
  "oct",
  "prof",
  "rev",
  "sec",
  "sep",
  "sept",
  "sr",
  "st",
  "vs",
]);

/**
 * Markers of a hedged statement. A hedge is the model declining to assert, so
 * there is nothing to hold it to -- grounding a "might be" would only produce
 * noise. `may` is matched case-sensitively so the month survives.
 */
const HEDGE_PATTERNS: readonly RegExp[] = [
  /\b(?:might|maybe|perhaps|possibly|probably|presumably|arguably|apparently|allegedly|reportedly|potentially|seemingly|supposedly)\b/i,
  /\b(?:seems?|appears?|suggests?|indicates?)\b/i,
  /\b(?:could|would|should|can)\s+(?:be|have|include|indicate|mean|imply|suggest)\b/i,
  /\b(?:i|we)\s+(?:think|believe|suspect|assume|guess|expect)\b/i,
  /\b(?:not\s+(?:sure|certain|clear)|unclear|uncertain|unconfirmed|hard\s+to\s+say)\b/i,
  /\b(?:as\s+far\s+as\s+(?:i|we)\s+know|to\s+my\s+knowledge|if\s+(?:i|we)\s+recall)\b/i,
  /\b(?:likely|unlikely)\b/i,
  /\b(?:roughly|approximately|estimated)\b|\b(?:around|about)\s+\d/i,
  /\bmay\b/,
];

/** Lines that are markup rather than assertion. */
const FORMATTING_ONLY: readonly RegExp[] = [
  /^#{1,6}\s*\S*$/, // an empty or single-token heading
  /^[-*_]{3,}$/, // horizontal rule
  /^\|?[\s:|-]+\|?$/, // table separator row
  /^[>\s]*$/, // bare blockquote markers
  /^[-*+]\s*$/, // bare list bullet
  /^\d+[.)]\s*$/, // bare ordered-list marker
];

/** Leading markup that is not part of the sentence but shifts its offset. */
const LEADING_MARKUP = /^(?:\s*(?:>|[-*+]|\d+[.)]|#{1,6})\s+)+/;

/** Minimum tokens for a fragment to be worth grounding. */
const MIN_CLAIM_TOKENS = 3;

interface Span {
  text: string;
  start: number;
}

/** Character ranges occupied by fenced code blocks, which are never mined for claims. */
function fencedCodeRanges(output: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: number | null = null;
  for (const match of output.matchAll(/^[ \t]*(?:```|~~~)/gm)) {
    const index = match.index ?? 0;
    if (open === null) {
      open = index;
    } else {
      const lineEnd = output.indexOf("\n", index);
      ranges.push([open, lineEnd === -1 ? output.length : lineEnd + 1]);
      open = null;
    }
  }
  // An unterminated fence swallows the rest of the output, which is the safe
  // reading: half-open code is still code.
  if (open !== null) ranges.push([open, output.length]);
  return ranges;
}

function isInside(ranges: ReadonlyArray<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Trim a span, keeping its offset in sync with the characters removed. */
function trimSpan(span: Span): Span {
  const leading = span.text.length - span.text.trimStart().length;
  return { text: span.text.trim(), start: span.start + leading };
}

/** A claim must contain real words, not just a number or a bare URL. */
function isSubstantive(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.length < MIN_CLAIM_TOKENS) return false;
  return tokens.some((token) => /[a-z]{2,}/.test(token));
}

function isQuestion(text: string): boolean {
  return /\?["'’”)\]]*$/.test(text.trim());
}

function isHedged(text: string): boolean {
  return HEDGE_PATTERNS.some((pattern) => pattern.test(text));
}

function isFormattingOnly(text: string): boolean {
  return FORMATTING_ONLY.some((pattern) => pattern.test(text));
}

/** A run of `.`/`!`/`?` ends a sentence unless it is an abbreviation or a decimal point. */
function endsSentence(text: string, terminatorStart: number, afterTerminators: number): boolean {
  const next = text.slice(afterTerminators);
  // A terminator must be followed by whitespace or end-of-text. This also means
  // decimal points and dotted versions never split, since a digit follows them.
  if (next.length > 0 && !/^\s/.test(next)) return false;

  const preceding = text.slice(0, terminatorStart);
  const lastWord = /([A-Za-z]+)$/.exec(preceding)?.[1] ?? "";
  if (lastWord.length === 1) return false; // initials: "e.g.", "U.S.", "J. Smith"
  if (ABBREVIATIONS.has(lastWord.toLowerCase())) return false;

  // Mid-text, require the next sentence to start the way sentences do.
  if (next.trim().length > 0 && !/^\s*["'“([A-Z0-9]/.test(next)) return false;
  return true;
}

/** Split a span into sentence spans, preserving absolute offsets. */
function splitSentences(span: Span): Span[] {
  const { text, start } = span;
  const out: Span[] = [];
  let sentenceStart = 0;
  let i = 0;

  while (i < text.length) {
    if (!".!?".includes(text[i] as string)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && ".!?".includes(text[end] as string)) end += 1;

    if (!endsSentence(text, i, end)) {
      i = end;
      continue;
    }
    // Absorb closing quotes and brackets that belong to this sentence.
    while (end < text.length && /["'’”)\]]/.test(text[end] as string)) end += 1;

    out.push({ text: text.slice(sentenceStart, end), start: start + sentenceStart });
    while (end < text.length && /\s/.test(text[end] as string)) end += 1;
    sentenceStart = end;
    i = end;
  }

  if (sentenceStart < text.length) {
    out.push({ text: text.slice(sentenceStart), start: start + sentenceStart });
  }
  return out.map(trimSpan).filter((s) => s.text.length > 0);
}

/** Split a markdown table row into its cells, each with its own offset. */
function tableCells(span: Span): Span[] {
  const cells: Span[] = [];
  let offset = 0;
  for (const raw of span.text.split("|")) {
    cells.push(trimSpan({ text: raw, start: span.start + offset }));
    offset += raw.length + 1;
  }
  return cells.filter((cell) => cell.text.length > 0);
}

/**
 * Split an output into candidate factual claims with character offsets.
 *
 * Segmentation is sentence-level. Questions, hedged statements, fenced code
 * and pure formatting are skipped: none of them is the model asserting a fact,
 * so none of them can be ungrounded.
 *
 * For every returned claim, `output.slice(claim.spanStart, claim.spanEnd)`
 * equals `claim.text`.
 */
export function extractClaims(output: string): Claim[] {
  if (output.length === 0) return [];

  const codeRanges = fencedCodeRanges(output);
  const candidates: Span[] = [];
  let lineStart = 0;

  for (const line of output.split("\n")) {
    const span: Span = { text: line, start: lineStart };
    lineStart += line.length + 1;

    if (isInside(codeRanges, span.start)) continue;

    const trimmed = trimSpan(span);
    if (trimmed.text.length === 0 || isFormattingOnly(trimmed.text)) continue;

    // Strip list bullets, blockquote markers and heading hashes, keeping offsets.
    const markup = LEADING_MARKUP.exec(trimmed.text)?.[0] ?? "";
    const body: Span = {
      text: trimmed.text.slice(markup.length),
      start: trimmed.start + markup.length,
    };
    if (body.text.length === 0) continue;

    const segments = body.text.includes("|") ? tableCells(body) : [body];
    for (const segment of segments) candidates.push(...splitSentences(segment));
  }

  const claims: Claim[] = [];
  for (const candidate of candidates) {
    if (!isSubstantive(candidate.text)) continue;
    if (isQuestion(candidate.text)) continue;
    if (isHedged(candidate.text)) continue;
    claims.push({
      id: `claim-${claims.length}`,
      text: candidate.text,
      spanStart: candidate.start,
      spanEnd: candidate.start + candidate.text.length,
    });
  }
  return claims;
}
