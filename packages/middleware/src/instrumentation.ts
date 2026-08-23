/**
 * The slice of a tracer this package uses.
 *
 * Structurally typed to match what OpenTelemetry already exposes, rather than
 * depending on `@opentelemetry/api`. A caller using OTel passes
 * `trace.getTracer("provguard")` and it works; a caller using something else
 * passes their own object; a caller using nothing passes nothing and pays
 * nothing.
 *
 * `AGENTS.md` requires core packages to work with no network and no
 * infrastructure. A vendor-neutral interface satisfies the observability
 * requirement better than a vendor dependency would — and the shape is small
 * enough that duck-typing it is honest rather than clever.
 */
export interface GuardSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException?(error: unknown): void;
  end(): void;
}

export interface GuardTracer {
  startSpan(name: string): GuardSpan;
}

export interface InstrumentationOptions {
  readonly tracer?: GuardTracer;
}

/**
 * Wraps a tracer so that observability can never become a new way to fail.
 *
 * A guard sits in the request path. If a misconfigured exporter throws, the
 * correct outcome is a missing span, not a blocked delivery — the whole
 * argument for putting a guard inline is that it fails in known ways, and
 * "telemetry broke your traffic" is not one of them.
 */
export function safeSpan(tracer: GuardTracer | undefined, name: string): GuardSpan {
  if (tracer === undefined) {
    return NO_OP_SPAN;
  }

  try {
    const span = tracer.startSpan(name);
    return {
      setAttribute(key, value) {
        try {
          span.setAttribute(key, value);
        } catch {
          /* a broken tracer must not break the request path */
        }
      },
      recordException(error) {
        try {
          span.recordException?.(error);
        } catch {
          /* as above */
        }
      },
      end() {
        try {
          span.end();
        } catch {
          /* as above */
        }
      },
    };
  } catch {
    return NO_OP_SPAN;
  }
}

const NO_OP_SPAN: GuardSpan = {
  setAttribute() {
    /* no tracer configured */
  },
  recordException() {
    /* no tracer configured */
  },
  end() {
    /* no tracer configured */
  },
};
