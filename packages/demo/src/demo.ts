import process from "node:process";
import { pathToFileURL } from "node:url";

import { DEFAULT_POLICY, assembleContext, checkSlot, classifyChunk } from "@provguard/inbound";
import { auditOutput } from "@provguard/outbound";
import type { ClaimAssessment } from "@provguard/outbound";
import type { Chunk, ContextSlot, Verdict } from "@provguard/schema";
import {
  CAPTURE_COMMAND,
  FABRICATED_ANALYSIS,
  HTTP_ERROR_RESPONSE,
  MALFORMED_BYTES,
  MALFORMED_FIELD,
  PIPELINE_STATUS,
  SCENARIO_ID,
  TRUNCATED_REQUEST_BODY,
  scenario,
} from "./chain.js";

const WIDTH = 78;

/** The slot the capture layer wrote into. */
const SIGNALS_SLOT: ContextSlot = mustFindSlot("signals");

export interface InboundDecision {
  label: string;
  chunk: Chunk;
  verdict: Verdict;
}

export interface WalkthroughResult {
  /** What the analyst was shown when nothing was checked. */
  deliveredAnalysis: string;
  /** The pipeline's own self-report at the end of pass one. */
  pipelineStatus: string;
  /** Chunks the capture layer produced, as the inbound guard classifies them. */
  captured: Chunk[];
  /** The inbound guard's decision on each captured chunk. */
  inbound: InboundDecision[];
  /** What survived into the signals slot once the policy was applied. */
  signalsSlot: Chunk[];
  /** The outbound guard's verdict on the fabricated paragraph. */
  outboundVerdict: Verdict;
  /** Per-claim outcomes behind that verdict. */
  claims: ClaimAssessment[];
}

/**
 * Run both passes of the walkthrough.
 *
 * Everything here is real: the chunks are classified by the inbound guard,
 * the slot decisions come from `checkSlot`, and the claim verdicts come from
 * `auditOutput`. Nothing is narrated that the guards did not actually decide.
 */
export function runWalkthrough(): WalkthroughResult {
  const captured: Chunk[] = [
    classifyChunk(TRUNCATED_REQUEST_BODY, { sourceId: "vendor-cli:request-body" }),
    classifyChunk(HTTP_ERROR_RESPONSE, { sourceId: "vendor-cli:stdout" }),
  ];

  const inbound: InboundDecision[] = [
    {
      label: "truncated request body",
      chunk: captured[0]!,
      verdict: checkSlot(captured[0]!, SIGNALS_SLOT),
    },
    {
      label: "captured HTTP 400 error page",
      chunk: captured[1]!,
      verdict: checkSlot(captured[1]!, SIGNALS_SLOT),
    },
  ];

  const { assembled } = assembleContext(captured, DEFAULT_POLICY);
  const audit = auditOutput(FABRICATED_ANALYSIS, captured);

  return {
    deliveredAnalysis: FABRICATED_ANALYSIS,
    pipelineStatus: PIPELINE_STATUS,
    captured,
    inbound,
    signalsSlot: assembled[SIGNALS_SLOT.name] ?? [],
    outboundVerdict: audit.verdict,
    claims: audit.assessments,
  };
}

/** Format the walkthrough as the lines the script prints. */
export function renderDemo(result: WalkthroughResult = runWalkthrough()): string[] {
  const out: string[] = [];
  const say = (line = ""): void => void out.push(line);
  const prose = (text: string, indent = ""): void => {
    for (const line of wrap(text, WIDTH - indent.length)) say(indent + line);
  };
  const evidence = (text: string): void => {
    for (const line of text.split("\n")) say(`      | ${line}`.trimEnd());
  };
  const banner = (title: string, char: string): void => {
    say(char.repeat(WIDTH));
    say(`  ${title}`);
    say(char.repeat(WIDTH));
  };

  const meta = scenario();

  banner("PROVENANCE GUARD - stdout-capture walkthrough", "=");
  say();
  prose(`Harness scenario: ${SCENARIO_ID} (${meta.name})`);
  prose(`Source: ${meta.sourceNote}`);
  say();
  prose(
    "An analyst asks an AI agent for a read on battery-supplier disclosures. " +
      "The same request runs twice below: once with the guards switched off, " +
      "and once with them on. Nothing here calls a real model or a real " +
      "network -- every step is a fixed recording of the incident, so the " +
      "output is identical on every run.",
  );
  say();

  // ---------------------------------------------------------------- pass one
  banner("PASS 1 - GUARDS DISABLED", "-");
  say();

  say("Step 1 of 5 - A malformed byte enters the request");
  prose(
    "A supplier name arrives with a broken character in it. It is invisible, " +
      "it is not empty, and nothing rejects it.",
    "   ",
  );
  say();
  evidence(`supplier name : ${MALFORMED_FIELD.replace("\uD800", "?")}`);
  evidence(`bad character : ${MALFORMED_BYTES}`);
  say();

  say("Step 2 of 5 - The request is written, and the write fails halfway");
  prose(
    "Turning that name into JSON raises an error mid-write. The writer stops, " +
      "but what it already wrote has gone. The body still opens like a healthy " +
      'payload, so a check that only asks "did we get something?" says yes.',
    "   ",
  );
  say();
  evidence(TRUNCATED_REQUEST_BODY);
  say();

  say("Step 3 of 5 - The vendor API rejects it and explains why");
  prose(
    "The API answers with an error page. Read it closely: it lists the " +
      "parameter names it expected -- industry, market, compliance, forecast, " +
      "risk. That vocabulary is about to be mistaken for market data.",
    "   ",
  );
  say();
  evidence(HTTP_ERROR_RESPONSE);
  say();

  say("Step 4 of 5 - The error text is filed as vendor data");
  prose(
    "The capture line below redirects error output into the same variable as " +
      "real output, then files it into the signals cache. At this point the " +
      "error page is indistinguishable from a vendor report.",
    "   ",
  );
  say();
  evidence(CAPTURE_COMMAND);
  say();
  for (const chunk of result.captured) {
    evidence(
      `filed -> channel=${chunk.provenance.channel} tier=${chunk.provenance.tier}` +
        (chunk.provenance.upstreamStatus === undefined
          ? ""
          : ` upstream=${String(chunk.provenance.upstreamStatus)}`),
    );
  }
  say();

  say("Step 5 of 5 - The agent answers, and the analyst reads this");
  prose("Delivered in full, exactly as it would have reached the analyst:", "   ");
  say();
  for (const line of wrap(result.deliveredAnalysis, WIDTH - 6)) say(`      ${line}`);
  say();
  prose(
    "Not one sentence is hedged, and not one is true. The scan covered no " +
      "disclosures at all. The only reason the number 400 appears is that it " +
      "was the HTTP status code on the error page.",
    "   ",
  );
  say();
  say(`   PIPELINE SELF-REPORT: ${result.pipelineStatus}`);
  prose("No error was raised, and every check the pipeline knows how to run passed.", "   ");
  say();

  // ---------------------------------------------------------------- pass two
  banner("PASS 2 - GUARDS ENABLED", "-");
  say();
  prose(
    "Same broken byte, same failed write, same error page, same capture line. " +
      "The difference is that something now inspects what is being filed.",
  );
  say();

  say("The inbound guard checks each item before the agent can see it");
  prose(
    `Target slot: "${SIGNALS_SLOT.name}" (the cache the agent reads for market signals)`,
    "   ",
  );
  say();

  for (const decision of result.inbound) {
    say(`   ${decision.verdict.decision === "allow" ? "ADMITTED" : "REJECTED"}: ${decision.label}`);
    evidence(
      `classified as channel=${decision.chunk.provenance.channel} tier=${decision.chunk.provenance.tier}`,
    );
    for (const reason of decision.verdict.reasons) {
      evidence(`${reason.code}: ${reason.message}`);
    }
    say();
  }

  say("What the agent received instead");
  prose(
    result.signalsSlot.length === 0
      ? "Nothing. The signals slot is empty, so the agent has no vendor data to " +
          "reason from and has to say so rather than infer a trend from an error " +
          "message. Admitting it cannot answer is less satisfying than a " +
          "confident paragraph, and far more useful."
      : `${String(result.signalsSlot.length)} item(s) survived into the signals slot.`,
    "   ",
  );
  say();

  say("The outbound guard checks the answer against what was actually in context");
  prose(
    "Suppose the fabricated paragraph reached the outbound guard anyway. Each " +
      "sentence is checked against the chunks that were in context:",
    "   ",
  );
  say();

  for (const [index, assessment] of result.claims.entries()) {
    const code = assessment.reason?.code ?? "none";
    say(`   Claim ${String(index + 1)} - ${assessment.grounding.status.toUpperCase()} [${code}]`);
    for (const line of wrap(`"${assessment.claim.text}"`, WIDTH - 6)) say(`      ${line}`);
    for (const [position, line] of wrap(assessment.detail, WIDTH - 9).entries()) {
      say(`      ${position === 0 ? "-> " : "   "}${line}`);
    }
    say();
  }

  say(`   OUTBOUND VERDICT: ${result.outboundVerdict.decision.toUpperCase()}`);
  say();

  // ---------------------------------------------------------------- summary
  say("=".repeat(WIDTH));
  say("  Guards off: fabricated analysis delivered; pipeline reported success.");
  say(
    `  Guards on: error text never reached the agent; answer ${result.outboundVerdict.decision}ed on ` +
      `${String(result.claims.length)} claims.`,
  );
  say("=".repeat(WIDTH));

  return out;
}

/** Print the walkthrough. */
export function main(): void {
  for (const line of renderDemo()) console.log(line);
}

function mustFindSlot(name: string): ContextSlot {
  const slot = DEFAULT_POLICY.slots.find((candidate) => candidate.name === name);
  if (slot === undefined) {
    throw new Error(`DEFAULT_POLICY has no "${name}" slot; the walkthrough narrates that slot.`);
  }
  return slot;
}

/** Deterministic greedy word wrap, so the narration reads as paragraphs. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/).filter((token) => token.length > 0)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
