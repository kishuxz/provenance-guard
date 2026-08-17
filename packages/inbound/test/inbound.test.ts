import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, assembleContext, checkSlot, classifyChunk } from "../src/index.js";

import type { ContextSlot, ReasonCode } from "@provguard/schema";

const signalsSlot = requiredSlot("signals");

describe("classifyChunk", () => {
  it("classifies empty payloads as UNLABELED T5", () => {
    const chunk = classifyChunk(" \n\t ");
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("UNLABELED");
    expect(chunk.provenance.tier).toBe("T5");
    expect(verdict.decision).toBe("block");
    expectReason(verdict, "PAYLOAD_EMPTY");
  });

  it("classifies non-2xx upstream statuses as SYSTEM_ALERT T5", () => {
    const chunk = classifyChunk("upstream unavailable", {
      channel: "RETRIEVED_DOC",
      tier: "T1",
      upstreamStatus: 503,
    });
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("SYSTEM_ALERT");
    expect(chunk.provenance.tier).toBe("T5");
    expect(verdict.decision).toBe("block");
    expectReason(verdict, "UPSTREAM_STATUS_NOT_OK");
    expectReason(verdict, "CHANNEL_NOT_PERMITTED");
  });

  it("detects HTTP error status lines", () => {
    const chunk = classifyChunk(
      "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\nBad Gateway",
    );

    expect(chunk.provenance.channel).toBe("SYSTEM_ALERT");
    expect(chunk.provenance.tier).toBe("T5");
    expect(chunk.provenance.upstreamStatus).toBe(502);
  });

  it("detects structured HTTP error bodies", () => {
    const chunk = classifyChunk(
      JSON.stringify({
        error: {
          statusCode: 429,
          message: "Too Many Requests",
        },
      }),
    );

    expect(chunk.provenance.channel).toBe("SYSTEM_ALERT");
    expect(chunk.provenance.tier).toBe("T5");
    expect(chunk.provenance.upstreamStatus).toBe(429);
  });

  it("detects HTML error pages", () => {
    const chunk = classifyChunk(`
      <!doctype html>
      <html>
        <head><title>404 Not Found</title></head>
        <body><h1>404 Not Found</h1><p>The requested URL was not found.</p></body>
      </html>
    `);

    expect(chunk.provenance.channel).toBe("SYSTEM_ALERT");
    expect(chunk.provenance.tier).toBe("T5");
    expect(chunk.provenance.upstreamStatus).toBe(404);
  });

  it("detects truncated JSON", () => {
    const chunk = classifyChunk('{"signals":[{"id":"a","value":42}');
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("UNLABELED");
    expect(chunk.provenance.tier).toBe("T5");
    expect(verdict.decision).toBe("block");
    expectReason(verdict, "PAYLOAD_TRUNCATED");
  });

  it("detects stack traces as DIAGNOSTIC_LOG", () => {
    const chunk = classifyChunk(`TypeError: Cannot read properties of undefined
    at parseSignal (/srv/app/signals.js:44:13)
    at main (/srv/app/index.js:8:1)`);
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("DIAGNOSTIC_LOG");
    expect(chunk.provenance.tier).toBe("T5");
    expect(verdict.decision).toBe("block");
    expectReason(verdict, "CHANNEL_NOT_PERMITTED");
  });

  it("detects shell diagnostics as DIAGNOSTIC_LOG", () => {
    const chunk = classifyChunk("zsh: command not found: provguard\n");
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("DIAGNOSTIC_LOG");
    expect(chunk.provenance.tier).toBe("T5");
    expect(verdict.decision).toBe("block");
    expectReason(verdict, "CHANNEL_NOT_PERMITTED");
  });

  it("classifies unrecognized content as UNLABELED T5", () => {
    const chunk = classifyChunk("quarterly signal momentum is elevated");
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("UNLABELED");
    expect(chunk.provenance.tier).toBe("T5");
    expect(verdict.decision).toBe("block");
    expectReason(verdict, "CHANNEL_NOT_PERMITTED");
    expectReason(verdict, "TIER_BELOW_MINIMUM");
  });

  it("infers T3 for a retrieved document with explicit ok upstream status", () => {
    const chunk = classifyChunk("The published report lists revenue as $42 million.", {
      channel: "RETRIEVED_DOC",
      upstreamStatus: 200,
    });

    expect(chunk.provenance.channel).toBe("RETRIEVED_DOC");
    expect(chunk.provenance.tier).toBe("T3");
    expect(checkSlot(chunk, signalsSlot).decision).toBe("allow");
  });
});

describe("checkSlot", () => {
  it("allows only permitted channels at or above the minimum tier", () => {
    const allowed = classifyChunk("primary user instruction", {
      channel: "USER_MESSAGE",
      tier: "T1",
    });
    const blocked = classifyChunk("low-trust user instruction", {
      channel: "USER_MESSAGE",
      tier: "T4",
    });

    expect(checkSlot(allowed, signalsSlot).decision).toBe("allow");

    const verdict = checkSlot(blocked, signalsSlot);
    expect(verdict.decision).toBe("block");
    expectReason(verdict, "TIER_BELOW_MINIMUM");
  });

  it("keeps DIAGNOSTIC_LOG and SYSTEM_ALERT out of every default slot", () => {
    const diagnostic = classifyChunk("fatal: not a git repository");
    const alert = classifyChunk(
      "<html><head><title>500 Internal Server Error</title></head></html>",
    );

    for (const slot of DEFAULT_POLICY.slots) {
      expect(checkSlot(diagnostic, slot).decision).toBe("block");
      expect(checkSlot(alert, slot).decision).toBe("block");
    }
  });

  it("keeps CACHE and UNLABELED out of default T3-or-better slots", () => {
    const cached = classifyChunk("cached document", {
      channel: "CACHE",
      tier: "T3",
    });
    const unlabeled = classifyChunk("unlabeled document", {
      channel: "UNLABELED",
      tier: "T3",
    });

    for (const slot of DEFAULT_POLICY.slots) {
      expect(checkSlot(cached, slot).decision).toBe("block");
      expect(checkSlot(unlabeled, slot).decision).toBe("block");
    }
  });
});

describe("assembleContext", () => {
  it("drops blocked chunks and records verdicts", () => {
    const allowed = classifyChunk("The published report lists revenue as $42 million.", {
      channel: "RETRIEVED_DOC",
      upstreamStatus: 200,
    });
    const blocked = classifyChunk("HTTP/1.1 500 Internal Server Error");

    const result = assembleContext([allowed, blocked], {
      slots: [signalsSlot],
      defaultRule: {
        decision: "deny",
        appliesWhen: "no_slot_match",
      },
    });

    expect(result.assembled.signals).toEqual([allowed]);
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts.map((verdict) => verdict.decision)).toEqual(["allow", "block"]);
    expectReason(result.verdicts[1], "CHANNEL_NOT_PERMITTED");
  });
});

describe("required sabotage tests", () => {
  it("blocks a real HTTP 400 error page from signals with CHANNEL_NOT_PERMITTED", () => {
    const realHttp400Page = `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head>
<title>400 Bad Request</title>
</head><body>
<h1>Bad Request</h1>
<p>Your browser sent a request that this server could not understand.<br />
</p>
<hr>
<address>Apache/2.4.58 (Ubuntu) Server at example.test Port 80</address>
</body></html>`;
    const chunk = classifyChunk(realHttp400Page, {
      channel: "RETRIEVED_DOC",
      tier: "T1",
    });
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("SYSTEM_ALERT");
    expect(chunk.provenance.upstreamStatus).toBe(400);
    expect(verdict.decision).toBe("block");
    expectReason(verdict, "CHANNEL_NOT_PERMITTED");
  });

  it("blocks truncated JSON with PAYLOAD_TRUNCATED", () => {
    const chunk = classifyChunk('{"documents":[{"id":"doc-1","text":"partial"}');
    const verdict = checkSlot(chunk, signalsSlot);

    expect(verdict.decision).toBe("block");
    expectReason(verdict, "PAYLOAD_TRUNCATED");
  });

  it("allows a legitimate retrieved document", () => {
    const chunk = classifyChunk(
      "According to the filed 10-K, the company reported $42 million in revenue.",
      {
        channel: "RETRIEVED_DOC",
        upstreamStatus: 200,
      },
    );
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("RETRIEVED_DOC");
    expect(chunk.provenance.tier).toBe("T3");
    expect(verdict).toEqual({ decision: "allow", reasons: [] });
  });
});

describe("declared labels are claims, not facts", () => {
  // The laundering move: wrap a failure in a healthy label. Before this was
  // fixed the chunk was admitted at T2, which also meant the outbound low-tier
  // gate never fired -- one declaration defeating both gates.
  const launderedFailure = JSON.stringify({
    ok: true,
    connector: "vendor-metrics",
    result: {
      note: "upstream provider returned no rows; a placeholder summary was substituted so downstream formatting would not break",
    },
  });

  it("blocks error content declared TOOL_RESULT at T2 with a 200 status", () => {
    const chunk = classifyChunk(launderedFailure, {
      channel: "TOOL_RESULT",
      tier: "T2",
      upstreamStatus: 200,
    });
    const verdict = checkSlot(chunk, signalsSlot);

    expect(verdict.decision).toBe("block");
    expectReason(verdict, "PROVENANCE_LABEL_MISMATCH");
  });

  it("downgrades the laundered chunk so the outbound low-tier gate can fire", () => {
    const chunk = classifyChunk(launderedFailure, {
      channel: "TOOL_RESULT",
      tier: "T2",
      upstreamStatus: 200,
    });

    expect(chunk.provenance.channel).toBe("DIAGNOSTIC_LOG");
    expect(chunk.provenance.tier).toBe("T5");
  });

  it("reports a degraded result under its own code", () => {
    const chunk = classifyChunk(
      JSON.stringify({
        job: "nightly-reconciliation",
        state: "completed_with_fallback",
        detail: "primary source unreachable; emitted last known snapshot",
      }),
      { channel: "TOOL_RESULT", tier: "T2" },
    );
    const verdict = checkSlot(chunk, signalsSlot);

    expect(verdict.decision).toBe("block");
    expectReason(verdict, "RESULT_DEGRADED");
  });

  it("flags the mismatch on a chunk a caller assembled by hand", () => {
    // checkSlot is reachable without going through classifyChunk, so the label
    // has to be re-checked there rather than trusted from classification.
    const verdict = checkSlot(
      {
        id: "hand-built",
        text: "HTTP/1.1 500 Internal Server Error\r\ncontent-type: text/plain\r\n\r\nupstream failed",
        provenance: {
          sourceId: "caller",
          channel: "TOOL_RESULT",
          tier: "T2",
          retrievedAt: "2026-08-17T00:00:00.000Z",
          contentHash: "sha256:hand-built",
        },
      },
      signalsSlot,
    );

    expect(verdict.decision).toBe("block");
    expectReason(verdict, "PROVENANCE_LABEL_MISMATCH");
  });

  it("caps a declared tier at what its channel can justify", () => {
    const cached = classifyChunk("Partner thresholds: Silver at 10 deployments.", {
      channel: "CACHE",
      tier: "T1",
    });
    const retrieved = classifyChunk("The published report lists revenue as $42 million.", {
      channel: "RETRIEVED_DOC",
      tier: "T1",
    });

    expect(cached.provenance.tier).toBe("T4");
    expect(retrieved.provenance.tier).toBe("T3");
  });

  it("never raises a declared tier", () => {
    const chunk = classifyChunk("The published report lists revenue as $42 million.", {
      channel: "RETRIEVED_DOC",
      tier: "T5",
    });

    expect(chunk.provenance.tier).toBe("T5");
  });
});

describe("error responses versus documents about errors", () => {
  it("admits an API reference that quotes a status code in prose", () => {
    const chunk = classifyChunk(
      "API reference, error handling section: the service returns 404 Not Found when a dataset id does not exist, and includes a machine-readable reason field in the response body.",
      { channel: "RETRIEVED_DOC", tier: "T3" },
    );
    const verdict = checkSlot(chunk, signalsSlot);

    expect(chunk.provenance.channel).toBe("RETRIEVED_DOC");
    expect(chunk.provenance.upstreamStatus).toBeUndefined();
    expect(verdict).toEqual({ decision: "allow", reasons: [] });
  });

  it("admits a long document about failure however often it says error", () => {
    // Density alone must never be enough. A runbook is mostly error words.
    const runbook = [
      "Incident runbook for the ingestion service.",
      "When the connector reports an error, check whether the error is transient.",
      "A transient error resolves on retry; a persistent error requires escalation.",
      "Common failure modes include a timeout on the upstream socket, an invalid",
      "credential, and a refused connection. Record every failure in the incident log.",
    ].join(" ");
    const chunk = classifyChunk(runbook, { channel: "RETRIEVED_DOC", tier: "T3" });

    expect(chunk.provenance.channel).toBe("RETRIEVED_DOC");
    expect(checkSlot(chunk, signalsSlot).decision).toBe("allow");
  });

  it("still catches a status line in the first position", () => {
    const chunk = classifyChunk("HTTP/1.1 503 Service Unavailable\r\n\r\nupstream is down");

    expect(chunk.provenance.channel).toBe("SYSTEM_ALERT");
    expect(chunk.provenance.upstreamStatus).toBe(503);
  });

  it("still catches a bare status line occupying its own line", () => {
    const chunk = classifyChunk("502 Bad Gateway\nThe proxy could not reach the origin.");

    expect(chunk.provenance.channel).toBe("SYSTEM_ALERT");
    expect(chunk.provenance.upstreamStatus).toBe(502);
  });

  it("does not treat a quoted status line inside a document as a response", () => {
    // The same bytes as a real status line, but not in the first position.
    const chunk = classifyChunk(
      "Troubleshooting guide. A failing proxy answers with a status line such as HTTP/1.1 502 Bad Gateway, which clients should surface to the operator rather than retry indefinitely.",
      { channel: "RETRIEVED_DOC", tier: "T3" },
    );

    expect(chunk.provenance.channel).toBe("RETRIEVED_DOC");
    expect(checkSlot(chunk, signalsSlot).decision).toBe("allow");
  });

  it("still catches a JSON error envelope", () => {
    const chunk = classifyChunk(
      JSON.stringify({ error: { statusCode: 429, message: "Too Many Requests" } }),
    );

    expect(chunk.provenance.channel).toBe("SYSTEM_ALERT");
    expect(chunk.provenance.upstreamStatus).toBe(429);
  });

  it("does not treat a healthy body carrying a null error field as an error", () => {
    const chunk = classifyChunk(JSON.stringify({ error: null, records: 3, status: "ok" }), {
      channel: "TOOL_RESULT",
      tier: "T2",
      upstreamStatus: 200,
    });

    expect(chunk.provenance.channel).toBe("TOOL_RESULT");
    expect(checkSlot(chunk, signalsSlot).decision).toBe("allow");
  });
});

function requiredSlot(name: string): ContextSlot {
  const slot = DEFAULT_POLICY.slots.find((candidate) => candidate.name === name);
  if (slot === undefined) {
    throw new Error(`Missing default policy slot ${name}.`);
  }

  return slot;
}

function expectReason(verdict: { reasons: { code: ReasonCode }[] } | undefined, code: ReasonCode) {
  expect(verdict?.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
}
