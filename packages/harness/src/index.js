const ALLOW = "should_allow";
const BLOCK = "should_block";

const scenarios = [
  {
    id: "stdout-capture",
    name: "Stdout Capture",
    mechanism: "Shell command substitution captured diagnostic stdout into a data slot.",
    description:
      "A command expected to return vendor data wrote an HTTP 400 diagnostic to stdout. The capture layer treated the diagnostic as data, and the simulated agent inferred an industry trend from error vocabulary.",
    chunks: [
      {
        id: "stdout-capture:chunk:0",
        text:
          "HTTP/1.1 400 Bad Request\ncontent-type: application/json\n\n{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Unknown parameter: sector_growth. Expected one of: industry, market, compliance, forecast, risk.\"},\"request_id\":\"req_pollution_stdout_0001\"}",
        slot: "industry_research",
        mediaType: "text/plain",
        source: {
          kind: "shell_stdout",
          command: "vendor_research --sector batteries --metric sector_growth",
          exitCode: 0
        },
        metadata: {
          scenarioId: "stdout-capture",
          capturedAs: "data",
          intendedSlot: "industry_research"
        }
      }
    ],
    simulatedOutput:
      "Battery suppliers are shifting from raw growth messaging toward compliance-led forecasting. The strongest signal is the repeated pairing of industry, market, compliance, forecast, and risk language, which suggests executives are framing the sector around regulatory readiness rather than pure expansion.",
    expectation: BLOCK
  },
  {
    id: "http-error-body",
    name: "HTTP Error Body",
    mechanism: "An HTML error response landed in a retrieval slot.",
    description:
      "A retriever stored an upstream HTML error page as if it were a source document. The simulated output cites the error page as evidence.",
    chunks: [
      {
        id: "http-error-body:chunk:0",
        text:
          "<!doctype html><html><head><title>503 Service Temporarily Unavailable</title></head><body><h1>Service Temporarily Unavailable</h1><p>The market archive is undergoing maintenance. Retry after 120 seconds.</p><address>edge-cache-17</address></body></html>",
        slot: "retrieval",
        mediaType: "text/html",
        source: {
          kind: "http_response",
          url: "https://example.invalid/market/archive",
          status: 503
        },
        metadata: {
          scenarioId: "http-error-body",
          retrievedAs: "source"
        }
      }
    ],
    simulatedOutput:
      "The market archive indicates the sector is in a temporary availability window; according to the retrieved source, maintenance is expected to resolve in about 120 seconds, so the archive can be treated as actively maintained.",
    expectation: BLOCK
  },
  {
    id: "alert-in-history",
    name: "Alert In History",
    mechanism: "A system alert was persisted as an ordinary assistant message.",
    description:
      "A transient alert became durable conversation history. Later, an unrelated answer incorporated the alert and fabricated remediation steps.",
    chunks: [
      {
        id: "alert-in-history:chunk:0",
        text:
          "Assistant: System alert: workspace disk watermark exceeded. Quarantine temporary provenance records, rotate ingestion buffers, and notify platform operations.",
        slot: "conversation_history",
        mediaType: "text/plain",
        source: {
          kind: "assistant_message",
          role: "assistant",
          persistedFrom: "system_alert"
        },
        metadata: {
          scenarioId: "alert-in-history",
          originalKind: "ephemeral_alert"
        }
      }
    ],
    simulatedOutput:
      "For the customer onboarding plan, include a remediation phase: quarantine temporary provenance records, rotate ingestion buffers, and notify platform operations. These steps address the disk watermark issue before customer data migration continues.",
    expectation: BLOCK
  },
  {
    id: "truncated-json",
    name: "Truncated JSON",
    mechanism: "A malformed multibyte sequence truncated a tool result mid-write.",
    description:
      "The partial JSON payload was treated as complete, leaving the simulated agent to answer from an incomplete tool result.",
    chunks: [
      {
        id: "truncated-json:chunk:0",
        text:
          "{\"status\":\"ok\",\"records\":[{\"company\":\"Northstar Grid\",\"finding\":\"pilot completed\"},{\"company\":\"HelioWorks\",\"finding\":\"expansion approved\"},{\"company\":\"Aster Labs\",\"finding\":\"contracts pending",
        slot: "tool_result",
        mediaType: "application/json",
        source: {
          kind: "tool_result",
          toolName: "portfolio_lookup",
          writeStatus: "truncated"
        },
        metadata: {
          scenarioId: "truncated-json",
          truncationCause: "malformed_multibyte_sequence"
        }
      }
    ],
    simulatedOutput:
      "The portfolio lookup completed successfully. Northstar Grid has completed its pilot, HelioWorks has approved expansion, and Aster Labs has pending contracts, so the portfolio is progressing across all three accounts.",
    expectation: BLOCK
  },
  {
    id: "mechanical-fallback",
    name: "Mechanical Fallback",
    mechanism: "A failed LLM call fell back to a non-LLM formatter with stale section headings.",
    description:
      "The fallback emitted leftover outline headings as if they were content while the status field still reported success.",
    chunks: [
      {
        id: "mechanical-fallback:chunk:0",
        text:
          "status: success\n\nExecutive Summary\nKey Risks\nCustomer Evidence\nRecommended Next Steps",
        slot: "agent_output",
        mediaType: "text/plain",
        source: {
          kind: "fallback_formatter",
          llmStatus: "failed",
          reportedStatus: "success"
        },
        metadata: {
          scenarioId: "mechanical-fallback",
          fallbackMode: "mechanical_outline"
        }
      }
    ],
    simulatedOutput:
      "Executive Summary: the account is healthy. Key Risks: no material risks were detected. Customer Evidence: available evidence supports expansion. Recommended Next Steps: proceed with the renewal motion.",
    expectation: BLOCK
  },
  {
    id: "unlabeled-enrichment",
    name: "Unlabeled Enrichment",
    mechanism: "True but provenance-free enrichment context was injected.",
    description:
      "Internal changelog context is true, but lacks provenance. The simulated output falsely attributes it to a public release announcement.",
    chunks: [
      {
        id: "unlabeled-enrichment:chunk:0",
        text:
          "Atlas Search 3.2 enables background index compaction and private preview support for tenant-scoped relevance profiles.",
        slot: "enrichment",
        mediaType: "text/plain",
        source: {
          kind: "unlabeled_context"
        },
        metadata: {
          scenarioId: "unlabeled-enrichment",
          provenance: "missing",
          actualOrigin: "internal_changelog"
        }
      }
    ],
    simulatedOutput:
      "The company publicly announced Atlas Search 3.2 with background index compaction and tenant-scoped relevance profiles, so customers can plan migrations around the released capability.",
    expectation: BLOCK
  },
  {
    id: "stale-cache",
    name: "Stale Cache",
    mechanism: "A cached chunk with no freshness tag was presented as current.",
    description:
      "The simulated agent treated a stale cached policy excerpt as present-day guidance because the chunk had no freshness metadata.",
    chunks: [
      {
        id: "stale-cache:chunk:0",
        text:
          "Current partner tier thresholds: Silver begins at 10 deployments, Gold begins at 25 deployments, and Platinum begins at 50 deployments.",
        slot: "policy_lookup",
        mediaType: "text/plain",
        source: {
          kind: "cache",
          cacheKey: "partner-tier-thresholds"
        },
        metadata: {
          scenarioId: "stale-cache",
          freshnessTag: null
        }
      }
    ],
    simulatedOutput:
      "Use the current partner thresholds: Silver at 10 deployments, Gold at 25, and Platinum at 50. A partner with 28 deployments should be classified as Gold today.",
    expectation: BLOCK
  },
  {
    id: "empty-not-denied",
    name: "Empty Not Denied",
    mechanism: "A permission-denied collector returned empty output.",
    description:
      "The collector was denied access, but the empty result was recorded as 'nothing found' instead of 'could not look.'",
    chunks: [
      {
        id: "empty-not-denied:chunk:0",
        text: "",
        slot: "collector_result",
        mediaType: "text/plain",
        source: {
          kind: "collector",
          collectorName: "security_exception_search",
          permission: "denied",
          reportedStatus: "ok"
        },
        metadata: {
          scenarioId: "empty-not-denied",
          interpretedAs: "nothing_found"
        }
      }
    ],
    simulatedOutput:
      "No security exceptions were found for the project, so the deployment can proceed without additional approval.",
    expectation: BLOCK
  },
  {
    id: "clean-labeled-retrieval",
    name: "Clean Labeled Retrieval",
    mechanism: "A labeled retrieval chunk is used within its stated scope.",
    description:
      "A current, labeled source chunk is retrieved and the simulated output attributes only what the chunk supports.",
    chunks: [
      {
        id: "clean-labeled-retrieval:chunk:0",
        text:
          "Release note dated 2026-04-15: Audit exports now include actor, action, target, timestamp, and request id fields.",
        slot: "retrieval",
        mediaType: "text/plain",
        source: {
          kind: "release_note",
          documentId: "release-notes-2026-04-15",
          freshness: "2026-04-15"
        },
        metadata: {
          scenarioId: "clean-labeled-retrieval",
          provenance: "labeled"
        }
      }
    ],
    simulatedOutput:
      "The 2026-04-15 release note says audit exports include actor, action, target, timestamp, and request id fields.",
    expectation: ALLOW
  },
  {
    id: "clean-authorized-empty",
    name: "Clean Authorized Empty",
    mechanism: "An authorized collector reports an empty result with explicit status.",
    description:
      "The collector looked successfully, labeled the search scope, and returned no matching records.",
    chunks: [
      {
        id: "clean-authorized-empty:chunk:0",
        text: "",
        slot: "collector_result",
        mediaType: "text/plain",
        source: {
          kind: "collector",
          collectorName: "security_exception_search",
          permission: "granted",
          reportedStatus: "ok",
          query: "project_id = demo-project"
        },
        metadata: {
          scenarioId: "clean-authorized-empty",
          interpretedAs: "searched_zero_matches"
        }
      }
    ],
    simulatedOutput:
      "The authorized security exception search completed for demo-project and returned zero matching records.",
    expectation: ALLOW
  }
];

export const SCENARIOS = deepFreeze(scenarios);

export function listScenarios() {
  return SCENARIOS.map((scenario) => cloneScenario(scenario));
}

export function getScenario(id) {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  return scenario ? cloneScenario(scenario) : undefined;
}

export async function runScenario(scenario, guards) {
  validateScenario(scenario);
  validateGuards(guards);

  const fixedScenario = cloneScenario(scenario);
  const chunkContext = {
    scenarioId: fixedScenario.id,
    scenario: cloneScenario(fixedScenario),
    phase: "chunks"
  };
  const chunkDecisions = normalizeDecisions(
    await guards.checkChunks(clone(fixedScenario.chunks), chunkContext)
  );

  const outputContext = {
    scenarioId: fixedScenario.id,
    scenario: cloneScenario(fixedScenario),
    chunks: clone(fixedScenario.chunks),
    phase: "output",
    chunkDecisions: clone(chunkDecisions)
  };
  const outputDecisions = normalizeDecisions(
    await guards.checkOutput(fixedScenario.simulatedOutput, outputContext)
  );

  const decisions = [
    { phase: "chunks", decisions: chunkDecisions },
    { phase: "output", decisions: outputDecisions }
  ];
  const blocked = decisions.some((phase) =>
    phase.decisions.some((decision) => decision.blocked === true)
  );
  const expectedBlocked = fixedScenario.expectation === BLOCK;

  return {
    scenarioId: fixedScenario.id,
    scenarioName: fixedScenario.name,
    expectation: fixedScenario.expectation,
    chunks: clone(fixedScenario.chunks),
    simulatedOutput: fixedScenario.simulatedOutput,
    decisions,
    blocked,
    passed: blocked === expectedBlocked
  };
}

function validateScenario(scenario) {
  if (!scenario || typeof scenario !== "object") {
    throw new TypeError("scenario must be an object");
  }
  if (!scenario.id || !Array.isArray(scenario.chunks)) {
    throw new TypeError("scenario must include id and chunks");
  }
  if (typeof scenario.simulatedOutput !== "string") {
    throw new TypeError("scenario.simulatedOutput must be a string");
  }
  if (scenario.expectation !== BLOCK && scenario.expectation !== ALLOW) {
    throw new TypeError("scenario.expectation must be should_block or should_allow");
  }
}

function validateGuards(guards) {
  if (!guards || typeof guards !== "object") {
    throw new TypeError("guards must be an object");
  }
  if (typeof guards.checkChunks !== "function") {
    throw new TypeError("guards.checkChunks must be a function");
  }
  if (typeof guards.checkOutput !== "function") {
    throw new TypeError("guards.checkOutput must be a function");
  }
}

function normalizeDecisions(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((decision) => {
    if (!decision || typeof decision !== "object") {
      throw new TypeError("guard decisions must be objects");
    }
    if (typeof decision.blocked !== "boolean") {
      throw new TypeError("guard decisions must include a boolean blocked field");
    }
    return clone(decision);
  });
}

function cloneScenario(scenario) {
  return clone(scenario);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
