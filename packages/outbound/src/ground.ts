import type { Chunk, Claim, Grounding, Reason, ReasonCode } from "@provguard/schema";
import type { ClaimAssessment, DecisionMethod } from "./types.js";
import { isUntrustedTier } from "./types.js";
import {
  containsNormalizedPhrase,
  contentTokens,
  extractEntities,
  extractNumbers,
  normalize,
  stripTrailingPunctuation,
  tokenize,
} from "./text.js";

export interface GroundOptions {
  /**
   * Fraction of a claim's content words that must appear somewhere in context
   * before "context is silent on this" is preferred over "context is about
   * something else entirely". Below it, a claim with no hard specifics is
   * ungrounded rather than unverifiable. Default 0.34.
   */
  minLexicalOverlap?: number;
}

const DEFAULTS: Required<GroundOptions> = {
  minLexicalOverlap: 0.34,
};

/**
 * Confidence attached to each way of grounding a claim. Verbatim support is
 * worth more than a normalized match, which is worth more than agreeing on the
 * specifics. Anything that fails to ground scores zero, and an undecidable
 * claim sits in the middle because the evidence genuinely points nowhere.
 */
const SCORES = {
  exact: 1,
  normalized: 0.9,
  specifics: 0.75,
  undecided: 0.5,
  none: 0,
} as const;

/**
 * The shared `Grounding.method` union has three members, but the deterministic
 * ladder has more stages than that. Everything that is deterministic but not
 * verbatim reports as `fuzzy`; the exact stage that decided is preserved on
 * `ClaimAssessment.decidedBy`.
 */
function toSchemaMethod(decidedBy: DecisionMethod): Grounding["method"] {
  if (decidedBy === "exact") return "exact";
  if (decidedBy === "judge") return "judge";
  return "fuzzy";
}

/** A chunk with its comparison forms computed once. */
interface PreparedChunk {
  chunk: Chunk;
  normalized: string;
  numbers: Set<string>;
  tokens: Set<string>;
}

function prepare(chunks: readonly Chunk[]): PreparedChunk[] {
  return chunks.map((chunk) => ({
    chunk,
    normalized: normalize(chunk.text),
    numbers: new Set(extractNumbers(chunk.text)),
    tokens: new Set(tokenize(chunk.text)),
  }));
}

/** What a stage found, before the tier gate is applied. */
interface StageHit {
  decidedBy: DecisionMethod;
  score: number;
  supporting: PreparedChunk[];
  trusted: boolean;
  detail: string;
}

/** A stage's conclusion that the claim is bad, regardless of tier. */
interface StageRejection {
  decidedBy: DecisionMethod;
  supporting: PreparedChunk[];
  detail: string;
}

function makeHit(
  decidedBy: DecisionMethod,
  score: number,
  supporting: PreparedChunk[],
  detail: string,
): StageHit {
  return {
    decidedBy,
    score,
    supporting,
    trusted: supporting.some((p) => !isUntrustedTier(p.chunk.provenance.tier)),
    detail,
  };
}

/** Stage 1: the claim's own words, verbatim, inside a chunk. */
function stageExact(claim: Claim, prepared: PreparedChunk[]): StageHit | null {
  const raw = claim.text.trim();
  const withoutTerminator = stripTrailingPunctuation(raw);
  const needles = withoutTerminator === raw ? [raw] : [raw, withoutTerminator];

  const supporting = prepared.filter((p) =>
    needles.some((needle) => needle.length > 0 && p.chunk.text.includes(needle)),
  );
  if (supporting.length === 0) return null;
  return makeHit("exact", SCORES.exact, supporting, "claim appears verbatim in context");
}

/** Stage 2: the same words once case, whitespace and punctuation stop mattering. */
function stageNormalized(claim: Claim, prepared: PreparedChunk[]): StageHit | null {
  const needle = normalize(stripTrailingPunctuation(claim.text));
  if (needle.length === 0) return null;

  const supporting = prepared.filter((p) => p.normalized.includes(needle));
  if (supporting.length === 0) return null;
  return makeHit(
    "normalized",
    SCORES.normalized,
    supporting,
    "claim appears in context after normalizing case, whitespace and punctuation",
  );
}

/**
 * Stage 3: the hard specifics -- names, identifiers and numbers.
 *
 * A claim is only as sourced as its least sourced specific, so every one of
 * them has to appear in context. A claim whose specifics are partly invented
 * is the classic fluent-fabrication shape and is rejected outright rather than
 * deferred.
 */
function stageSpecifics(
  claim: Claim,
  prepared: PreparedChunk[],
  options: Required<GroundOptions>,
): { hit?: StageHit; rejection?: StageRejection } {
  const entities = extractEntities(claim.text);
  const numbers = extractNumbers(claim.text);

  const specifics = [
    ...entities.map((value) => ({
      value,
      chunks: prepared.filter((p) => containsNormalizedPhrase(p.normalized, normalize(value))),
    })),
    ...numbers.map((value) => ({
      value,
      chunks: prepared.filter((p) => p.numbers.has(value)),
    })),
  ];

  if (specifics.length > 0) {
    const unsupported = specifics.filter((s) => s.chunks.length === 0);
    const supporting = dedupe(specifics.flatMap((s) => s.chunks));
    const decidedBy: DecisionMethod = entities.length > 0 ? "entity" : "numeric";

    if (unsupported.length === 0) {
      return {
        hit: makeHit(
          decidedBy,
          SCORES.specifics,
          supporting,
          `every specific in the claim appears in context: ${specifics.map((s) => s.value).join(", ")}`,
        ),
      };
    }

    const missing = unsupported.map((s) => s.value).join(", ");
    return {
      rejection: {
        decidedBy,
        supporting: unsupported.length < specifics.length ? supporting : [],
        detail:
          unsupported.length < specifics.length
            ? `claim mixes sourced and unsourced specifics; absent from context: ${missing}`
            : `no specific in the claim appears in context: ${missing}`,
      },
    };
  }

  // No hard specifics to check. Fall back to subject-matter overlap, which can
  // only ever reject: shared vocabulary is not evidence that a claim is true,
  // but a total absence of it is evidence that context never discussed this.
  const claimTokens = contentTokens(claim.text);
  if (claimTokens.length === 0) return {};

  const corpus = new Set<string>();
  for (const p of prepared) for (const token of p.tokens) corpus.add(token);
  const matched = claimTokens.filter((token) => corpus.has(token));

  if (matched.length / claimTokens.length < options.minLexicalOverlap) {
    return {
      rejection: {
        decidedBy: "lexical",
        supporting: [],
        detail: `only ${matched.length} of ${claimTokens.length} content words appear anywhere in context`,
      },
    };
  }
  return {};
}

function dedupe(items: PreparedChunk[]): PreparedChunk[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    if (seen.has(p.chunk.id)) return false;
    seen.add(p.chunk.id);
    return true;
  });
}

function ids(chunks: PreparedChunk[]): string[] {
  return chunks.map((p) => p.chunk.id);
}

function reasonFor(code: ReasonCode, claim: Claim, message: string): Reason {
  return { code, message, claimId: claim.id };
}

/**
 * Assess a single claim against context, returning both the shared
 * `Grounding` and the reasoning behind it.
 *
 * Deterministic checks run in a fixed order -- exact substring, then
 * normalized fuzzy, then named-entity and numeric-literal overlap -- and the
 * first to reach a conclusion decides. Only when all of them are inconclusive
 * is a claim marked `unverifiable` and deferred. The deciding stage is always
 * recorded on `decidedBy`.
 *
 * The tier gate: a match whose supporting chunks are *all* T4/T5 does not
 * ground anything. That is the fluent-but-unsourced failure mode -- an output
 * confidently restating an error string or an unlabeled blob will match it
 * exactly, and the exact match is precisely what makes it convincing. Such a
 * claim comes back `ungrounded` with reason `CLAIM_SUPPORT_LOW_TIER`, keeping
 * the method that found it. Later stages still run first, in case a *trusted*
 * chunk supports the same claim by a weaker method; only if none does is the
 * untrusted match reported.
 */
export function assessClaim(
  claim: Claim,
  chunks: Chunk[],
  options: GroundOptions = {},
): ClaimAssessment {
  const resolved = { ...DEFAULTS, ...options };
  const prepared = prepare(chunks);

  const grounded = (hit: StageHit): ClaimAssessment => ({
    claim,
    grounding: {
      claimId: claim.id,
      status: "grounded",
      supportingChunkIds: ids(hit.supporting),
      method: toSchemaMethod(hit.decidedBy),
      score: hit.score,
    },
    decidedBy: hit.decidedBy,
    detail: hit.detail,
  });

  /** The first stage that matched, but only against untrusted chunks. */
  let tainted: StageHit | null = null;

  const stages: Array<StageHit | null> = [];
  stages.push(stageExact(claim, prepared));
  stages.push(stageNormalized(claim, prepared));

  const specifics = stageSpecifics(claim, prepared, resolved);
  stages.push(specifics.hit ?? null);

  for (const hit of stages) {
    if (hit === null) continue;
    if (hit.trusted) return grounded(hit);
    tainted ??= hit;
  }

  // A match against untrusted-only chunks outranks a later stage's rejection:
  // it is the more specific account of what went wrong.
  if (tainted !== null) {
    return {
      claim,
      grounding: {
        claimId: claim.id,
        status: "ungrounded",
        supportingChunkIds: ids(tainted.supporting),
        method: toSchemaMethod(tainted.decidedBy),
        score: SCORES.none,
      },
      decidedBy: tainted.decidedBy,
      reason: reasonFor(
        "CLAIM_SUPPORT_LOW_TIER",
        claim,
        `${tainted.detail}, but every supporting chunk is tier T4 or T5`,
      ),
      detail: `${tainted.detail}, but every supporting chunk is tier T4 or T5`,
    };
  }

  if (specifics.rejection) {
    const { decidedBy, supporting, detail } = specifics.rejection;
    return {
      claim,
      grounding: {
        claimId: claim.id,
        status: "ungrounded",
        supportingChunkIds: ids(supporting),
        method: toSchemaMethod(decidedBy),
        score: SCORES.none,
      },
      decidedBy,
      reason: reasonFor("CLAIM_UNGROUNDED", claim, detail),
      detail,
    };
  }

  const detail = "no deterministic check could confirm or refute this claim";
  return {
    claim,
    grounding: {
      claimId: claim.id,
      status: "unverifiable",
      supportingChunkIds: [],
      method: toSchemaMethod("none"),
      score: SCORES.undecided,
    },
    decidedBy: "none",
    reason: reasonFor("CLAIM_UNVERIFIABLE", claim, detail),
    detail,
  };
}

/**
 * Decide whether a single claim traces back to context.
 *
 * Returns the shared `Grounding` only. Use {@link assessClaim} when you also
 * need the reason code and the stage that decided.
 */
export function groundClaim(claim: Claim, chunks: Chunk[], options: GroundOptions = {}): Grounding {
  return assessClaim(claim, chunks, options).grounding;
}
