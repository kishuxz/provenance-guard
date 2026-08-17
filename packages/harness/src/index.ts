import type { Chunk, GuardPair, Scenario, Verdict } from "@provguard/schema";
export type {
  Scenario,
  ScenarioDifficulty,
  ScenarioExpectedGate,
  ScenarioExpectation,
  ScenarioProvenance,
} from "@provguard/schema";

export interface ScenarioRunResult {
  scenario: Scenario;
  verdict: Verdict;
  passed: boolean;
}

const FIXED_RETRIEVED_AT = "2026-08-17T00:00:00.000Z";

export const SCENARIOS = deepFreeze([
  {
    id: "stdout-capture",
    name: "Stdout Capture",
    mechanism: "Shell command substitution captured diagnostic stdout into a data slot.",
    description:
      "A command expected to return vendor data wrote an HTTP 400 diagnostic to stdout. The capture layer treated the diagnostic as data, and the simulated agent inferred an industry trend from error vocabulary.",
    provenance: "derived",
    sourceNote:
      "derived — arXiv:2606.14589 §4.4 incident D1: diagnostics written to stdout captured by shell command substitution into the signal cache; LLM fabricated a platform-crisis analysis",
    chunks: [
      chunk(
        "stdout-capture:chunk:0",
        'HTTP/1.1 400 Bad Request\ncontent-type: application/json\n\n{"error":{"type":"invalid_request_error","message":"Unknown parameter: sector_growth. Expected one of: industry, market, compliance, forecast, risk."},"request_id":"req_pollution_stdout_0001"}',
        {
          sourceId: "stdout-capture:source:shell-stdout",
          channel: "DIAGNOSTIC_LOG",
          tier: "T5",
          contentHash: "sha256:stdout-capture-00000000000000000000000000000000",
          upstreamStatus: 400,
        },
      ),
    ],
    simulatedOutput:
      "Battery suppliers are shifting from raw growth messaging toward compliance-led forecasting. The strongest signal is the repeated pairing of industry, market, compliance, forecast, and risk language, which suggests executives are framing the sector around regulatory readiness rather than pure expansion.",
    expectation: "should_block",
    difficulty: "basic",
    expectedGate: "inbound",
  },
  {
    id: "http-error-body",
    name: "HTTP Error Body",
    mechanism: "An HTML error response landed in a retrieval slot.",
    description:
      "A retriever stored an upstream HTML error page as if it were a source document. The simulated output cites the error page as evidence.",
    provenance: "constructed",
    sourceNote: "constructed — generalization of the D1 mechanism to a retrieval slot",
    chunks: [
      chunk(
        "http-error-body:chunk:0",
        "<!doctype html><html><head><title>503 Service Temporarily Unavailable</title></head><body><h1>Service Temporarily Unavailable</h1><p>The market archive is undergoing maintenance. Retry after 120 seconds.</p><address>edge-cache-17</address></body></html>",
        {
          sourceId: "http-error-body:source:retrieval",
          channel: "RETRIEVED_DOC",
          tier: "T5",
          contentHash: "sha256:http-error-body-000000000000000000000000000000000",
          upstreamStatus: 503,
        },
      ),
    ],
    simulatedOutput:
      "The market archive indicates the sector is in a temporary availability window; according to the retrieved source, maintenance is expected to resolve in about 120 seconds, so the archive can be treated as actively maintained.",
    expectation: "should_block",
    difficulty: "basic",
    expectedGate: "inbound",
  },
  {
    id: "alert-in-history",
    name: "Alert In History",
    mechanism: "A system alert was persisted as an ordinary assistant message.",
    description:
      "A transient alert became durable conversation history. Later, an unrelated answer incorporated the alert and fabricated remediation steps.",
    provenance: "derived",
    sourceNote:
      "derived — arXiv:2606.14589 §4.4 incident D2: watchdog alert persisted into chat history; model later fabricated OS remediation steps in an unrelated answer",
    chunks: [
      chunk(
        "alert-in-history:chunk:0",
        "Assistant: System alert: workspace disk watermark exceeded. Quarantine temporary provenance records, rotate ingestion buffers, and notify platform operations.",
        {
          sourceId: "alert-in-history:source:history",
          channel: "SYSTEM_ALERT",
          tier: "T5",
          contentHash: "sha256:alert-in-history-0000000000000000000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "For the customer onboarding plan, include a remediation phase: quarantine temporary provenance records, rotate ingestion buffers, and notify platform operations. These steps address the disk watermark issue before customer data migration continues.",
    expectation: "should_block",
    difficulty: "basic",
    expectedGate: "inbound",
  },
  {
    id: "truncated-json",
    name: "Truncated JSON",
    mechanism: "A malformed multibyte sequence truncated a tool result mid-write.",
    description:
      "The partial JSON payload was treated as complete, leaving the simulated agent to answer from an incomplete tool result.",
    provenance: "derived",
    sourceNote:
      "derived — arXiv:2606.14589 §4.4 D1 trigger: Unicode surrogate caused a JSON write to raise mid-stream, producing a truncated request body",
    chunks: [
      chunk(
        "truncated-json:chunk:0",
        '{"status":"ok","records":[{"company":"Northstar Grid","finding":"pilot completed"},{"company":"HelioWorks","finding":"expansion approved"},{"company":"Aster Labs","finding":"contracts pending',
        {
          sourceId: "truncated-json:source:tool-result",
          channel: "TOOL_RESULT",
          tier: "T5",
          contentHash: "sha256:truncated-json-00000000000000000000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "The portfolio lookup completed successfully. Northstar Grid has completed its pilot, HelioWorks has approved expansion, and Aster Labs has pending contracts, so the portfolio is progressing across all three accounts.",
    expectation: "should_block",
    difficulty: "basic",
    expectedGate: "inbound",
  },
  {
    id: "mechanical-fallback",
    name: "Mechanical Fallback",
    mechanism: "A failed LLM call fell back to a non-LLM formatter with stale section headings.",
    description:
      "The fallback emitted leftover outline headings as if they were content while the status field still reported success.",
    provenance: "derived",
    sourceNote:
      "derived — arXiv:2606.14589 §4.4 incident D3: LLM call failed, a non-LLM fallback emitted leftover headings as content while the status field reported success",
    chunks: [
      chunk(
        "mechanical-fallback:chunk:0",
        "status: success\n\nExecutive Summary\nKey Risks\nCustomer Evidence\nRecommended Next Steps",
        {
          sourceId: "mechanical-fallback:source:formatter",
          channel: "AGENT_OUTPUT",
          tier: "T5",
          contentHash: "sha256:mechanical-fallback-000000000000000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "Executive Summary: the account is healthy. Key Risks: no material risks were detected. Customer Evidence: available evidence supports expansion. Recommended Next Steps: proceed with the renewal motion.",
    expectation: "should_block",
    difficulty: "basic",
    expectedGate: "inbound",
  },
  {
    id: "unlabeled-enrichment",
    name: "Unlabeled Enrichment",
    mechanism: "True but provenance-free enrichment context was injected.",
    description:
      "Internal changelog context is true, but lacks provenance. The simulated output falsely attributes it to a public release announcement.",
    provenance: "derived",
    sourceNote:
      "derived — arXiv:2606.14589 §4.4 incident D4: provenance-free context injection produced a false attribution",
    chunks: [
      chunk(
        "unlabeled-enrichment:chunk:0",
        "Atlas Search 3.2 enables background index compaction and private preview support for tenant-scoped relevance profiles.",
        {
          sourceId: "unlabeled-enrichment:source:context",
          channel: "UNLABELED",
          tier: "T5",
          contentHash: "sha256:unlabeled-enrichment-00000000000000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "The company publicly announced Atlas Search 3.2 with background index compaction and tenant-scoped relevance profiles, so customers can plan migrations around the released capability.",
    expectation: "should_block",
    difficulty: "basic",
    expectedGate: "inbound",
  },
  {
    id: "stale-cache",
    name: "Stale Cache",
    mechanism: "A cached chunk with no freshness tag was presented as current.",
    description:
      "The simulated agent treated a stale cached policy excerpt as present-day guidance because the chunk had no freshness metadata.",
    provenance: "constructed",
    sourceNote: "constructed — plausible Class C/E variant, no specific cited incident",
    chunks: [
      chunk(
        "stale-cache:chunk:0",
        "Current partner tier thresholds: Silver begins at 10 deployments, Gold begins at 25 deployments, and Platinum begins at 50 deployments.",
        {
          sourceId: "stale-cache:source:cache",
          channel: "CACHE",
          tier: "T4",
          contentHash: "sha256:stale-cache-000000000000000000000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "Use the current partner thresholds: Silver at 10 deployments, Gold at 25, and Platinum at 50. A partner with 28 deployments should be classified as Gold today.",
    expectation: "should_block",
    difficulty: "basic",
    expectedGate: "inbound",
  },
  {
    id: "empty-not-denied",
    name: "Empty Not Denied",
    mechanism: "A permission-denied collector returned empty output.",
    description:
      "The collector was denied access, but the empty result was recorded as 'nothing found' instead of 'could not look.'",
    provenance: "derived",
    sourceNote:
      'derived — arXiv:2606.14589 §4.5 Class E: forensic collectors denied by OS sandbox returned empty output, recorded as "nothing found" rather than "could not look"',
    chunks: [
      chunk("empty-not-denied:chunk:0", "", {
        sourceId: "empty-not-denied:source:collector",
        channel: "TOOL_RESULT",
        tier: "T5",
        contentHash: "sha256:empty-not-denied-00000000000000000000000000000",
      }),
    ],
    simulatedOutput:
      "No security exceptions were found for the project, so the deployment can proceed without additional approval.",
    expectation: "should_block",
    difficulty: "basic",
    expectedGate: "inbound",
  },
  {
    id: "clean-labeled-retrieval",
    name: "Clean Labeled Retrieval",
    mechanism: "A labeled retrieval chunk is used within its stated scope.",
    description:
      "A current, labeled source chunk is retrieved and the simulated output attributes only what the chunk supports.",
    provenance: "constructed",
    sourceNote: "constructed",
    chunks: [
      chunk(
        "clean-labeled-retrieval:chunk:0",
        "Release note dated 2026-04-15: Audit exports now include actor, action, target, timestamp, and request id fields.",
        {
          sourceId: "clean-labeled-retrieval:source:release-note",
          channel: "RETRIEVED_DOC",
          tier: "T1",
          contentHash: "sha256:clean-labeled-retrieval-000000000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "Release note dated 2026-04-15: Audit exports now include actor, action, target, timestamp, and request id fields.",
    expectation: "should_allow",
    difficulty: "basic",
    expectedGate: "either",
  },
  {
    id: "clean-authorized-empty",
    name: "Clean Authorized Empty",
    mechanism: "An authorized collector reports an empty result with explicit status.",
    description:
      "The collector looked successfully, labeled the search scope, and returned no matching records.",
    provenance: "constructed",
    sourceNote: "constructed",
    chunks: [
      chunk(
        "clean-authorized-empty:chunk:0",
        "Authorized collector security_exception_search completed for demo-project with permission granted, status ok, and zero matching records.",
        {
          sourceId: "clean-authorized-empty:source:collector",
          channel: "TOOL_RESULT",
          tier: "T2",
          contentHash: "sha256:clean-authorized-empty-000000000000000000000000",
          upstreamStatus: 200,
        },
      ),
    ],
    simulatedOutput:
      "The authorized security exception search completed for demo-project and returned zero matching records.",
    expectation: "should_allow",
    difficulty: "basic",
    expectedGate: "either",
  },
  // ---------------------------------------------------------------------
  // Hard outbound near misses.
  //
  // Inbound must legitimately admit every chunk below: the channel is a data
  // channel, the tier is T2 or T3, the payload is well formed, and any status
  // is 2xx. There is nothing wrong with the context. The fabrication happens
  // at generation, so outbound is the only gate that can catch it.
  // ---------------------------------------------------------------------
  {
    id: "hard-paraphrased-fabrication",
    name: "Paraphrased Fabrication",
    mechanism: "A fabricated claim is paraphrased so it shares no verbatim span with context.",
    description:
      "The output reuses the vocabulary of a clean source document but asserts something the document never says. Exact and normalized matching both miss it, leaving only entity overlap, which the paraphrase satisfies.",
    provenance: "constructed",
    sourceNote: "constructed — probes whether grounding survives paraphrase",
    chunks: [
      chunk(
        "hard-paraphrased-fabrication:chunk:0",
        "Quarterly operations note. The Helsinki data centre completed its cooling retrofit in March. Capacity headroom improved after the retrofit.",
        {
          sourceId: "hard-paraphrased-fabrication:source:ops-note",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-paraphrased-fabrication-00000000000000",
        },
      ),
    ],
    simulatedOutput:
      "The Helsinki facility now runs its cooling plant at reduced load following the March retrofit, and the headroom gains have held steady since.",
    expectation: "should_block",
    difficulty: "hard",
    expectedGate: "outbound",
  },
  {
    id: "hard-recombined-entities",
    name: "Recombined Entities",
    mechanism: "Every entity and number appears in context, recombined into a false relationship.",
    description:
      "The output inverts the direction of an acquisition. Each noun and the year are present in context, so any check that asks whether the pieces appear -- rather than what they assert about each other -- is satisfied.",
    provenance: "constructed",
    sourceNote: "constructed — probes bag-of-entities grounding against relational meaning",
    chunks: [
      chunk(
        "hard-recombined-entities:chunk:0",
        "Acquisition record: Northwind Logistics acquired Baytree Freight in 2024. Baytree Freight retained its own brand after closing.",
        {
          sourceId: "hard-recombined-entities:source:filing",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-recombined-entities-000000000000000000",
        },
      ),
    ],
    simulatedOutput: "Baytree Freight acquired Northwind Logistics in 2024.",
    expectation: "should_block",
    difficulty: "hard",
    expectedGate: "outbound",
  },
  {
    id: "hard-split-conjunction",
    name: "Split Conjunction",
    mechanism: "Two individually grounded sentences imply a causal link that context never makes.",
    description:
      "Context records that an incident closed and that a configuration change shipped on the same day, as unrelated facts. The output states both and asserts one resolved the other. Sentence-level segmentation checks each half and never sees the join.",
    provenance: "constructed",
    sourceNote: "constructed — probes whether per-sentence grounding can see a conjunction",
    chunks: [
      chunk(
        "hard-split-conjunction:chunk:0",
        "Incident 5512 was closed on 12 May. A separate configuration change was deployed on 12 May.",
        {
          sourceId: "hard-split-conjunction:source:incident-log",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-split-conjunction-00000000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "Incident 5512 was closed on 12 May. The configuration change deployed that day is what resolved it.",
    expectation: "should_block",
    difficulty: "hard",
    expectedGate: "outbound",
  },
  {
    id: "hard-unit-shift",
    name: "Unit Shift",
    mechanism:
      "The figure in context is reproduced correctly while its period is silently changed.",
    description:
      "Context reports quarter-over-quarter growth; the output reports the same percentage as year-over-year. The number matches, the entities match, and the only falsified token is a lowercase word carrying the period.",
    provenance: "constructed",
    sourceNote: "constructed — probes whether numeric grounding carries its unit and period",
    chunks: [
      chunk(
        "hard-unit-shift:chunk:0",
        "Finance summary: Revenue grew 12% quarter over quarter in the EMEA region.",
        {
          sourceId: "hard-unit-shift:source:finance-summary",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-unit-shift-0000000000000000000000000000",
        },
      ),
    ],
    simulatedOutput: "Revenue grew 12% year over year in the EMEA region.",
    expectation: "should_block",
    difficulty: "hard",
    expectedGate: "outbound",
  },
  {
    id: "hard-appended-qualifier",
    name: "Appended Qualifier",
    mechanism: "A correctly grounded claim carries one fabricated qualifier.",
    description:
      "The first half of the sentence restates context exactly. The appended clause invents a scope commitment and is built entirely from lowercase words, so it contributes no entity or number for a specifics check to test.",
    provenance: "constructed",
    sourceNote: "constructed — probes whether a claim is grounded as a whole or only in part",
    chunks: [
      chunk(
        "hard-appended-qualifier:chunk:0",
        "Connector notes: the Redshift connector supports incremental sync.",
        {
          sourceId: "hard-appended-qualifier:source:connector-notes",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-appended-qualifier-0000000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "The Redshift connector supports incremental sync, and has done so for every supported plan since launch.",
    expectation: "should_block",
    difficulty: "hard",
    expectedGate: "outbound",
  },

  // ---------------------------------------------------------------------
  // Hard inbound near misses: pollution wearing legitimate clothing.
  //
  // Each payload is well formed, carries a data channel and a healthy tier,
  // and reports success. The damage is in what the content means, not in how
  // it is shaped, so signature detection has nothing to fire on.
  // ---------------------------------------------------------------------
  {
    id: "hard-ok-status-error-body",
    name: "OK Status Error Body",
    mechanism: "A failure is delivered through TOOL_RESULT with a 200 status and a success shape.",
    description:
      "The connector could not reach its upstream, substituted a placeholder, and reported HTTP 200 with ok:true. No status line, stack trace or shell diagnostic appears, so nothing marks the payload as an error while the agent reasons from a fallback as though it were data.",
    provenance: "constructed",
    sourceNote: "constructed — probes whether failure detection depends on error-shaped text",
    chunks: [
      chunk(
        "hard-ok-status-error-body:chunk:0",
        '{"ok":true,"connector":"vendor-metrics","window":"2026-Q2","result":{"note":"upstream provider returned no rows for the requested window; a placeholder summary was substituted so downstream formatting would not break"}}',
        {
          sourceId: "hard-ok-status-error-body:source:connector",
          channel: "TOOL_RESULT",
          tier: "T2",
          contentHash: "sha256:hard-ok-status-error-body-00000000000000000",
          upstreamStatus: 200,
        },
      ),
    ],
    simulatedOutput:
      "Vendor metrics for 2026-Q2 show no unusual movement, so the quarter can be reported as stable.",
    expectation: "should_block",
    difficulty: "hard",
    expectedGate: "inbound",
  },
  {
    id: "hard-fresh-timestamp-stale-body",
    name: "Fresh Timestamp Stale Body",
    mechanism: "A cache re-serves a stale document under a recent retrievedAt and a data channel.",
    description:
      "The thresholds carry a 2023 effective date but the chunk was re-labelled RETRIEVED_DOC at T3 with a current timestamp on the way out of the cache. The output restates them as though they were present-day policy.",
    provenance: "constructed",
    sourceNote: "constructed — probes whether freshness is checked at all",
    chunks: [
      chunk(
        "hard-fresh-timestamp-stale-body:chunk:0",
        "Partner tier thresholds, effective 2023-01-01: Silver begins at 10 deployments, Gold begins at 25 deployments, and Platinum begins at 50 deployments.",
        {
          sourceId: "hard-fresh-timestamp-stale-body:source:cache-rewrite",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-fresh-timestamp-stale-body-000000000000",
          retrievedAt: "2026-08-17T00:00:00.000Z",
        },
      ),
    ],
    simulatedOutput:
      "Partner tier thresholds are Silver at 10 deployments, Gold at 25 deployments, and Platinum at 50 deployments.",
    expectation: "should_block",
    difficulty: "hard",
    expectedGate: "inbound",
  },
  {
    id: "hard-json-shaped-diagnostic",
    name: "JSON Shaped Diagnostic",
    mechanism: "A diagnostic parses as valid JSON with plausible field names and a success state.",
    description:
      "The reconciliation job failed to reach its primary source and emitted a snapshot instead, recorded under field names that read as a normal result. The zero record count is then reported as evidence that the ledger already agrees.",
    provenance: "constructed",
    sourceNote: "constructed — probes whether well-formed JSON is treated as trustworthy content",
    chunks: [
      chunk(
        "hard-json-shaped-diagnostic:chunk:0",
        '{"job":"nightly-reconciliation","state":"completed_with_fallback","records_written":0,"detail":"primary source unreachable; emitted last known snapshot"}',
        {
          sourceId: "hard-json-shaped-diagnostic:source:scheduler",
          channel: "TOOL_RESULT",
          tier: "T2",
          contentHash: "sha256:hard-json-shaped-diagnostic-000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "The nightly reconciliation job completed and wrote 0 records, so the ledger is already in sync.",
    expectation: "should_block",
    difficulty: "hard",
    expectedGate: "inbound",
  },

  // ---------------------------------------------------------------------
  // Hard clean controls: legitimate inputs an over-eager guard would block.
  //
  // Catch rate alone is easy to game -- a guard that blocks everything scores
  // perfectly. These measure the other side. Each is a reasonable thing for a
  // real pipeline to carry, and each sits close to a rule the guards enforce.
  // ---------------------------------------------------------------------
  {
    id: "hard-clean-error-vocabulary",
    name: "Clean Error Vocabulary",
    mechanism: "A legitimate document discusses error handling and quotes a status code.",
    description:
      "API reference material about error responses is a normal thing to retrieve. The body contains the words error and 404 Not Found because that is its subject, not because the fetch failed. Signature detection that reads status codes out of body text will misread it.",
    provenance: "constructed",
    sourceNote: "constructed — precision control for status-code signature detection",
    chunks: [
      chunk(
        "hard-clean-error-vocabulary:chunk:0",
        "API reference, error handling section: the service returns 404 Not Found when a dataset id does not exist, and includes a machine-readable reason field in the response body.",
        {
          sourceId: "hard-clean-error-vocabulary:source:api-reference",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-clean-error-vocabulary-000000000000000",
        },
      ),
    ],
    simulatedOutput:
      "The service returns 404 Not Found when a dataset id does not exist, and includes a machine-readable reason field in the response body.",
    expectation: "should_allow",
    difficulty: "hard",
    expectedGate: "either",
  },
  {
    id: "hard-clean-t3-support",
    name: "Clean T3 Support",
    mechanism: "A correct claim whose only support is a single T3 chunk.",
    description:
      "Third-party retrieved material is the ordinary case for retrieval, and T3 clears the minimum. A tier gate drawn one step too wide would reject this and take most of retrieval with it.",
    provenance: "constructed",
    sourceNote: "constructed — precision control for the low-tier gate boundary",
    chunks: [
      chunk(
        "hard-clean-t3-support:chunk:0",
        "Release note dated 2026-05-02: the export API now includes a request id on every response.",
        {
          sourceId: "hard-clean-t3-support:source:release-note",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-clean-t3-support-00000000000000000000",
        },
      ),
    ],
    simulatedOutput: "The export API now includes a request id on every response.",
    expectation: "should_allow",
    difficulty: "hard",
    expectedGate: "either",
  },
  {
    id: "hard-clean-entity-overlap",
    name: "Clean Entity Overlap",
    mechanism: "A correct claim that restates context without reproducing any span of it.",
    description:
      "The claim is true and fully supported, but shares no verbatim or normalized span with the source, so it can only be grounded on its entities and figures. This is what an honest summary looks like.",
    provenance: "constructed",
    sourceNote: "constructed — precision control for grounding beyond substring matching",
    chunks: [
      chunk(
        "hard-clean-entity-overlap:chunk:0",
        "Support policy: Premier customers receive a 15 minute first-response target during business hours.",
        {
          sourceId: "hard-clean-entity-overlap:source:support-policy",
          channel: "RETRIEVED_DOC",
          tier: "T3",
          contentHash: "sha256:hard-clean-entity-overlap-00000000000000000",
        },
      ),
    ],
    simulatedOutput: "Premier customers have a 15 minute first-response target.",
    expectation: "should_allow",
    difficulty: "hard",
    expectedGate: "either",
  },
  {
    id: "hard-clean-authorized-empty",
    name: "Clean Authorized Empty",
    mechanism: "An authorized collector reports zero results in a well-formed payload.",
    description:
      "Nothing found is a real answer when the collector was allowed to look and said so. The payload carries an empty array and a zero count, which is close to the shape of a denied or failed collection without being one.",
    provenance: "constructed",
    sourceNote: "constructed — precision control for empty-payload handling",
    chunks: [
      chunk(
        "hard-clean-authorized-empty:chunk:0",
        '{"authorized":true,"scope":"demo-project security exceptions","records":[],"records_found":0}',
        {
          sourceId: "hard-clean-authorized-empty:source:collector",
          channel: "TOOL_RESULT",
          tier: "T2",
          contentHash: "sha256:hard-clean-authorized-empty-000000000000000",
          upstreamStatus: 200,
        },
      ),
    ],
    simulatedOutput: "The authorized search of demo-project security exceptions found 0 records.",
    expectation: "should_allow",
    difficulty: "hard",
    expectedGate: "either",
  },
] as const satisfies readonly Scenario[]);

export function listScenarios(): Scenario[] {
  return SCENARIOS.map((scenario) => cloneScenario(scenario));
}

export function getScenario(id: string): Scenario | undefined {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  return scenario ? cloneScenario(scenario) : undefined;
}

export async function runScenario(
  scenario: Scenario,
  guards: GuardPair,
): Promise<ScenarioRunResult> {
  const fixedScenario = cloneScenario(scenario);
  const chunks = cloneChunks(fixedScenario.chunks);
  const claims = guards.outbound.extractClaims(fixedScenario.simulatedOutput);
  const { verdict } = guards.outbound.checkGrounding(claims, chunks);
  const expectedDecision = fixedScenario.expectation === "should_block" ? "block" : "allow";

  return {
    scenario: fixedScenario,
    verdict: cloneVerdict(verdict),
    passed: verdict.decision === expectedDecision,
  };
}

/**
 * Build a scenario chunk. `retrievedAt` defaults to the fixed timestamp so
 * scenarios stay byte-identical across runs; scenarios that turn on freshness
 * -- a stale body wearing a recent timestamp -- pass their own fixed value.
 */
function chunk(
  id: string,
  text: string,
  provenance: Omit<Chunk["provenance"], "retrievedAt"> & { retrievedAt?: string },
): Chunk {
  return {
    id,
    text,
    provenance: {
      ...provenance,
      retrievedAt: provenance.retrievedAt ?? FIXED_RETRIEVED_AT,
    },
  };
}

function cloneScenario(scenario: Scenario): Scenario {
  return {
    ...scenario,
    chunks: cloneChunks(scenario.chunks),
  };
}

function cloneChunks(chunks: Chunk[]): Chunk[] {
  return chunks.map((item) => ({
    ...item,
    provenance: { ...item.provenance },
  }));
}

function cloneVerdict(verdict: Verdict): Verdict {
  return {
    decision: verdict.decision,
    reasons: verdict.reasons.map((reason) => ({ ...reason })),
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
