/**
 * Shared text utilities. Everything here is pure and deterministic -- the same
 * input always produces the same output. No clock, no randomness, no I/O.
 */

/** Typographic characters that would otherwise defeat a naive comparison. */
const UNICODE_FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, "-"],
  [/…/g, "..."],
  [/[   ​﻿]/g, " "],
];

/** Fold typographic punctuation to ASCII without touching case or spacing. */
export function foldUnicode(input: string): string {
  let out = input;
  for (const [pattern, replacement] of UNICODE_FOLD) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The normal form used by the fuzzy stage: lowercase, ASCII punctuation, all
 * non-alphanumerics collapsed to single spaces. Applied identically to both
 * sides of every comparison, so `3.14%` and `3.14 %` both become `3 14`.
 */
export function normalize(input: string): string {
  return foldUnicode(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Normalized tokens, in order, including stopwords. */
export function tokenize(input: string): string[] {
  const normalized = normalize(input);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/**
 * Words carrying too little meaning to count as evidence of shared subject
 * matter. Deliberately generous: a false "this is a stopword" only ever makes
 * the guard stricter, since it shrinks the pool of tokens a claim can match on.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any",
  "are", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "did", "do", "does", "doing", "down", "during", "each", "few", "for",
  "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
  "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
  "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once",
  "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own", "same", "she",
  "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up", "very", "was", "we", "were", "what", "when", "where", "which",
  "while", "who", "whom", "why", "will", "with", "would", "you", "your", "yours", "yourself",
]);

/**
 * Content tokens: the words that actually say what a claim is about. Used to
 * tell "context is silent on this" apart from "context is about something else
 * entirely" -- only the latter is decisive evidence of a fabrication.
 */
export function contentTokens(input: string): string[] {
  return tokenize(input).filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * Whether `needle` occurs in `haystack` on token boundaries. Both are expected
 * to be normalized already; padding with spaces keeps `api` from matching
 * inside `capital`.
 */
export function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Sentence-terminating punctuation, plus the closers that can trail it. */
const TRAILING_PUNCTUATION = /[.!?,;:\s"'’”)\]]+$/;

/** Strip trailing punctuation so `"...blue."` can still match a chunk's `"...blue"`. */
export function stripTrailingPunctuation(input: string): string {
  return input.replace(TRAILING_PUNCTUATION, "");
}

/**
 * Numeric literals in canonical form: thousands separators, currency symbols
 * and percent signs removed, so `$1,024`, `1024` and `1,024%` all reduce to
 * `1024`. Dropping the unit is deliberate -- unit mismatches are a judgement
 * call, and this stage only answers "did this number appear at all".
 */
export function extractNumbers(input: string): string[] {
  const folded = foldUnicode(input);
  const out = new Set<string>();
  // Version-like runs (1.2.3) first, so they are not shredded into 1.2 and 3.
  for (const match of folded.matchAll(/\b\d+(?:\.\d+){2,}\b/g)) {
    out.add(match[0]);
  }
  for (const match of folded.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) {
    const canonical = match[0].replace(/,/g, "").replace(/\.$/, "");
    if (canonical.length > 0) out.add(canonical);
  }
  return [...out];
}

/**
 * Words that begin a sentence in capitalized form without being names. Without
 * this list every sentence would appear to open with a named entity.
 */
const CAPITALIZED_NON_ENTITIES: ReadonlySet<string> = new Set([
  "a", "additionally", "after", "all", "also", "although", "an", "and", "another", "any", "as",
  "at", "because", "before", "both", "but", "by", "consequently", "during", "each", "either",
  "every", "finally", "first", "for", "from", "further", "furthermore", "he", "her", "here",
  "his", "how", "however", "i", "if", "in", "instead", "into", "it", "its", "meanwhile",
  "moreover", "most", "much", "neither", "never", "nevertheless", "no", "nor", "not", "of",
  "on", "once", "one", "only", "or", "other", "our", "overall", "per", "primarily", "she",
  "since", "so", "some", "specifically", "still", "such", "that", "the", "their", "then",
  "there", "therefore", "these", "they", "this", "those", "though", "thus", "to", "typically",
  "under", "unlike", "until", "via", "we", "what", "when", "where", "whether", "which",
  "while", "who", "why", "with", "within", "without", "yet", "you", "your",
]);

/** A token is identifier-shaped if it looks like code rather than prose. */
function isIdentifierLike(token: string): boolean {
  if (/^[A-Z]{2,}$/.test(token)) return true; // acronym: HTTP, SQL, API
  if (/_/.test(token) && /[A-Za-z]/.test(token)) return true; // snake_case
  if (/^[a-z]+[A-Z]/.test(token)) return true; // camelCase
  if (/^[A-Za-z][\w-]*\.[A-Za-z][\w.]*$/.test(token)) return true; // dotted.path
  if (/^https?:\/\//i.test(token)) return true; // URL
  if (/^[\w-]+\.(?:com|org|net|io|dev|gov|edu)\b/i.test(token)) return true; // domain
  return false;
}

/**
 * Named entities and other hard specifics in a claim: quoted spans, code
 * spans, identifiers, acronyms, and capitalized words that are not ordinary
 * sentence-opening prose.
 *
 * This is a lexical heuristic, not a statistical NER model -- deliberately, so
 * the result is reproducible and explainable. It over-collects rather than
 * under-collects: an extra specific makes grounding harder to achieve, never
 * easier.
 */
export function extractEntities(input: string): string[] {
  const folded = foldUnicode(input);
  const out = new Set<string>();

  const addIfMeaningful = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (!/[a-z]/i.test(trimmed)) return; // pure numbers belong to extractNumbers
    if (normalize(trimmed).length === 0) return;
    out.add(trimmed);
  };

  // Quoted and backticked spans are the author asserting "these exact words".
  for (const match of folded.matchAll(/`([^`]+)`/g)) addIfMeaningful(match[1] ?? "");
  for (const match of folded.matchAll(/"([^"]{2,})"/g)) addIfMeaningful(match[1] ?? "");

  // Word-ish tokens, keeping enough punctuation to recognize code and URLs.
  for (const match of folded.matchAll(/[A-Za-z][\w.:/-]*/g)) {
    const token = match[0].replace(/[.,;:/-]+$/, "");
    if (token.length === 0) continue;

    if (isIdentifierLike(token)) {
      addIfMeaningful(token);
      continue;
    }
    // Capitalized prose words are names unless they are the ordinary words a
    // sentence happens to start with. Position is not used: a fabrication can
    // put its invented subject in the first word of every sentence, and the
    // stopword list already removes the words that would be false positives.
    if (/^[A-Z]/.test(token) && !CAPITALIZED_NON_ENTITIES.has(token.toLowerCase())) {
      addIfMeaningful(token);
    }
  }

  return [...out];
}
