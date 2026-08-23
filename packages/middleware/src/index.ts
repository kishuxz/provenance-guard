import { DEFAULT_POLICY, assembleContext, checkSlot, classifyChunk } from "@provguard/inbound";
import { auditOutputWithJudge, type JudgeHook } from "@provguard/outbound";
import {
  buildGraph,
  contentDigest,
  toCanonicalJSON,
  validateGraph,
  type GraphInput,
  type RunAudit,
} from "@provguard/graph";
import type {
  Chunk,
  ContextSlot,
  Provenance,
  Reason,
  ReasonCode,
  SlotPolicy,
  Verdict,
} from "@provguard/schema";

export type GuardMode = "monitor" | "enforce";

export interface GuardOptions {
  /**
   * `enforce` acts on decisions. `monitor` records them and changes nothing —
   * including what enters context. See `admitContext`.
   */
  readonly mode: GuardMode;
  readonly tenantId?: string;
  readonly policy?: SlotPolicy;
  readonly slot?: string;
  readonly policyName?: string;
  readonly policyVersion?: string;
  /**
   * Optional second opinion for claims the deterministic ladder could not
   * settle. Never called for a claim a deterministic check decided, and its
   * answer can only make an outcome stricter.
   */
  readonly judge?: JudgeHook;
  /** Pins the ledger observation time, for reproducible output. */
  readonly observedAt?: string;
}

export interface CandidateChunk {
  readonly id?: string;
  readonly text: string;
  readonly provenance?: Partial<Provenance>;
}

export interface ChunkDecision {
  readonly chunk: Chunk;
  readonly verdict: Verdict;
  /** Whether the guard would keep this out of context under an enforcing policy. */
  readonly wouldRefuse: boolean;
  /** Whether it actually stayed out. False in monitor mode even when refused. */
  readonly refused: boolean;
}

export interface AdmitResult {
  /**
   * The chunks to place in context.
   *
   * In enforce mode, refused chunks are absent. In monitor mode **every chunk
   * is present**, including refused ones: monitor mode prevents nothing, and
   * withholding a chunk would change what the model sees, which is precisely
   * the behavioural change monitor mode exists to avoid. You cannot compare
   * would-block outcomes against your real traffic if the traffic is no longer
   * real.
   */
  readonly context: readonly Chunk[];
  readonly decisions: readonly ChunkDecision[];
  readonly mode: GuardMode;
}

export interface DeliveryResult {
  /** What the policy decided, identical in both modes for identical input. */
  readonly decision: Verdict["decision"];
  /** Whether the output actually reached the caller. Differs by mode. */
  readonly delivered: boolean;
  /** True when the decision was recorded but not acted on. */
  readonly monitored: boolean;
  readonly reasons: readonly Reason[];
  readonly reasonCodes: readonly ReasonCode[];
  readonly mode: GuardMode;
}

export interface GuardRunResult extends DeliveryResult {
  readonly admit: AdmitResult;
  /** The lineage graph for this run. */
  readonly graph: GraphInput;
}

export interface Guard {
  readonly mode: GuardMode;
  admitContext(candidates: readonly CandidateChunk[]): AdmitResult;
  run(candidates: readonly CandidateChunk[], output: string): Promise<GuardRunResult>;
}

const DEFAULT_TENANT = "local";
const DEFAULT_SLOT = "signals";
const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Builds a guard that runs both gates and records the lineage.
 *
 * Framework-neutral by construction: plain functions over plain data, with no
 * HTTP or web-framework types anywhere. A package that imports a framework in
 * order to be neutral has already picked one.
 */
export function createGuard(options: GuardOptions): Guard {
  const policy = options.policy ?? DEFAULT_POLICY;
  const slotName = options.slot ?? DEFAULT_SLOT;
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const monitored = options.mode === "monitor";

  const slot = resolveSlot(policy, slotName);

  const admitContext = (candidates: readonly CandidateChunk[]): AdmitResult => {
    const decisions = candidates.map((candidate) => {
      const classified = classifyChunk(candidate.text, candidate.provenance);
      const chunk = candidate.id === undefined ? classified : { ...classified, id: candidate.id };
      const verdict = checkSlot(chunk, slot);
      const wouldRefuse = verdict.decision !== "allow";

      return {
        chunk,
        verdict,
        wouldRefuse,
        // The single behavioural difference between the modes.
        refused: wouldRefuse && !monitored,
      };
    });

    return {
      context: decisions.filter((decision) => !decision.refused).map((decision) => decision.chunk),
      decisions,
      mode: options.mode,
    };
  };

  return {
    mode: options.mode,

    admitContext,

    async run(candidates, output) {
      const admit = admitContext(candidates);

      // Grounding is checked against the chunks that were genuinely admitted
      // under an enforcing policy, in both modes. Grounding a claim on a chunk
      // the policy refuses would report a claim as supported by evidence the
      // policy rejected, which is the thing the outbound gate exists to catch.
      const evidence = admit.decisions
        .filter((decision) => !decision.wouldRefuse)
        .map((decision) => decision.chunk);

      const audit = await auditOutputWithJudge(output, evidence, {
        ...(options.judge === undefined ? {} : { judge: options.judge }),
      });

      const decision = audit.verdict.decision;
      const blocked = decision !== "allow";

      const observedAt = options.observedAt ?? EPOCH;
      const runAudit: RunAudit = {
        tenantId,
        runKey: contentDigest(
          JSON.stringify([output, slotName, admit.decisions.map((entry) => entry.chunk.id)]),
        ),
        startedAt: observedAt,
        observedAt,
        policy: {
          name: options.policyName ?? "default",
          version: options.policyVersion ?? "1",
          contentHash: contentDigest(JSON.stringify(policy)),
          mode: options.mode,
        },
        chunks: admit.decisions.map((entry) => ({
          chunk: entry.chunk,
          admitted: !entry.wouldRefuse,
          slot: slotName,
          verdict: entry.verdict,
        })),
        output: { text: output, delivered: monitored || !blocked },
        claims: audit.assessments.map((assessment) => ({
          claim: assessment.claim,
          grounding: assessment.grounding,
          material: true,
          reasonCodes: assessment.reason === undefined ? [] : [assessment.reason.code],
        })),
      };

      return {
        decision,
        // Monitor mode delivers regardless. It prevents nothing, which is what
        // makes it safe to switch on and useless as protection.
        delivered: monitored || !blocked,
        monitored,
        reasons: audit.verdict.reasons,
        reasonCodes: audit.verdict.reasons.map((reason) => reason.code),
        mode: options.mode,
        admit,
        graph: buildGraph(runAudit),
      };
    },
  };
}

/** Convenience re-exports so a caller needs one import to use and inspect a run. */
export { assembleContext, toCanonicalJSON, validateGraph };
export type { GraphInput, JudgeHook };

function resolveSlot(policy: SlotPolicy, name: string): ContextSlot {
  const slot = policy.slots.find((candidate) => candidate.name === name);
  if (slot === undefined) {
    throw new Error(
      `slot ${JSON.stringify(name)} is not declared by the policy; declared slots: ${policy.slots
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }

  return slot;
}
