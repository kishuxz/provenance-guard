import { describe, expect, it } from "vitest";

import { createGuard, safeSpan, type CandidateChunk, type GuardTracer } from "../src/index.js";

const AT = "2026-03-04T10:00:00.000Z";

// An output with real specifics. FABRICATED carries no entity or number, so
// extraction finds nothing to ground and the guard correctly allows it --
// which would make every assertion below vacuous.
const FABRICATED = "Northvolt and CATL have both re-sequenced their 2027 capacity plans.";

const POLLUTED: CandidateChunk[] = [
  {
    id: "d1:stdout",
    text: 'HTTP/1.1 400 Bad Request\n\n{"error":{"message":"Unknown parameter: sector_growth."}}',
    provenance: { sourceId: "shell-stdout", upstreamStatus: 400 },
  },
];

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  ended: boolean;
}

function recordingTracer(): { tracer: GuardTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  return {
    spans,
    tracer: {
      startSpan(name) {
        const span: RecordedSpan = { name, attributes: {}, ended: false };
        spans.push(span);
        return {
          setAttribute(key, value) {
            span.attributes[key] = value;
          },
          end() {
            span.ended = true;
          },
        };
      },
    },
  };
}

describe("instrumentation", () => {
  it("emits nothing when no tracer is supplied", async () => {
    // The default has to cost nothing: an unobserved guard is the common case.
    const result = await createGuard({ mode: "enforce", observedAt: AT }).run(POLLUTED, FABRICATED);

    expect(result.decision).toBe("block");
  });

  it("produces an identical result with and without a tracer", async () => {
    const without = await createGuard({ mode: "enforce", observedAt: AT }).run(
      POLLUTED,
      FABRICATED,
    );
    const { tracer } = recordingTracer();
    const with_ = await createGuard({ mode: "enforce", observedAt: AT, tracer }).run(
      POLLUTED,
      FABRICATED,
    );

    expect(with_.decision).toBe(without.decision);
    expect(with_.reasonCodes).toEqual(without.reasonCodes);
    expect(with_.graph).toEqual(without.graph);
  });

  it("emits a span for each gate and ends both", async () => {
    const { tracer, spans } = recordingTracer();
    await createGuard({ mode: "enforce", observedAt: AT, tracer }).run(POLLUTED, FABRICATED);

    expect(spans.map((span) => span.name)).toEqual(["provguard.inbound", "provguard.outbound"]);
    expect(spans.every((span) => span.ended)).toBe(true);
  });

  it("records the decision and mode as attributes", async () => {
    const { tracer, spans } = recordingTracer();
    await createGuard({ mode: "monitor", observedAt: AT, tracer }).run(POLLUTED, FABRICATED);

    const outbound = spans.find((span) => span.name === "provguard.outbound");
    expect(outbound?.attributes["provguard.decision"]).toBe("block");
    expect(outbound?.attributes["provguard.mode"]).toBe("monitor");
    // Monitor mode delivered despite the block; both facts are on the span.
    expect(outbound?.attributes["provguard.delivered"]).toBe(true);
  });

  it("records how many chunks would have been refused", async () => {
    const { tracer, spans } = recordingTracer();
    createGuard({ mode: "monitor", observedAt: AT, tracer }).admitContext(POLLUTED);

    const inbound = spans.find((span) => span.name === "provguard.inbound");
    expect(inbound?.attributes["provguard.chunks.candidates"]).toBe(1);
    expect(inbound?.attributes["provguard.chunks.would_refuse"]).toBe(1);
    // Monitor mode admitted it anyway.
    expect(inbound?.attributes["provguard.chunks.admitted"]).toBe(1);
  });
});

describe("a broken tracer cannot break the request path", () => {
  it("survives a tracer that throws on startSpan", async () => {
    // A guard sits inline. If a misconfigured exporter throws, the right
    // outcome is a missing span, not a blocked delivery: "telemetry broke your
    // traffic" must not be one of the ways this component fails.
    const tracer: GuardTracer = {
      startSpan() {
        throw new Error("exporter misconfigured");
      },
    };

    const result = await createGuard({ mode: "enforce", observedAt: AT, tracer }).run(
      POLLUTED,
      FABRICATED,
    );

    expect(result.decision).toBe("block");
  });

  it("survives a span that throws on setAttribute and end", async () => {
    const tracer: GuardTracer = {
      startSpan() {
        return {
          setAttribute() {
            throw new Error("attribute rejected");
          },
          end() {
            throw new Error("flush failed");
          },
        };
      },
    };

    const result = await createGuard({ mode: "enforce", observedAt: AT, tracer }).run(
      POLLUTED,
      FABRICATED,
    );

    expect(result.decision).toBe("block");
  });

  it("returns a usable no-op span when the tracer is absent", () => {
    const span = safeSpan(undefined, "test");

    expect(() => {
      span.setAttribute("k", "v");
      span.end();
    }).not.toThrow();
  });
});
