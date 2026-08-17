import { getScenario } from "@provguard/harness";
import type { Scenario } from "@provguard/harness";

/** The harness entry this walkthrough dramatizes. */
export const SCENARIO_ID = "stdout-capture";

/**
 * The harness scenario, fetched so the narration cites the same provenance
 * note the benchmark does. If the catalogue ever drops this id the demo
 * should fail loudly rather than narrate a scenario that no longer exists.
 */
export function scenario(): Scenario {
  const found = getScenario(SCENARIO_ID);
  if (found === undefined) {
    throw new Error(
      `Harness scenario "${SCENARIO_ID}" is missing. The walkthrough narrates that scenario and cannot run without it.`,
    );
  }
  return found;
}

/**
 * Step 1. The vendor name arrived carrying a lone high surrogate. It is a
 * legal JavaScript string and an illegal piece of UTF-8, which is why it
 * survives every check until something tries to serialize it.
 */
export const MALFORMED_FIELD = "Kestrel Cells\uD800";

/** The byte sequence, shown rather than described, since it prints as nothing. */
export const MALFORMED_BYTES = "U+D800 (unpaired high surrogate)";

/**
 * Step 2. The request body as it reached the wire: the writer raised
 * mid-stream, so the JSON simply stops. Note it still starts like a healthy
 * payload, which is what makes it survive a shallow "did we get something"
 * check.
 */
export const TRUNCATED_REQUEST_BODY =
  '{"query":"supplier disclosures","sector_growth":true,"suppliers":[{"name":"Meridian Anode","status":"filed"},{"name":"Kestrel Cells","status":"fil';

/**
 * Step 3. What the vendor API answered. This is the text that ends up being
 * treated as market data.
 */
export const HTTP_ERROR_RESPONSE = [
  "HTTP/1.1 400 Bad Request",
  "content-type: application/json",
  "",
  '{"error":{"type":"invalid_request_error","message":"Unknown parameter: sector_growth. Expected one of: industry, market, compliance, forecast, risk."},"request_id":"req_pollution_stdout_0001"}',
].join("\n");

/** Step 4. The shell line whose command substitution swallowed stdout. */
export const CAPTURE_COMMAND = 'SIGNALS="$(vendor-cli fetch --sector battery 2>&1)"';

/**
 * Step 5. What the agent produced and what the analyst would have read.
 *
 * Every sentence is confident, none is hedged, and all three are wrong. The
 * middle one is the interesting one: its only "evidence" is the number 400,
 * which came from the HTTP status line of the error page.
 */
export const FABRICATED_ANALYSIS = [
  "Battery suppliers are shifting from raw growth messaging toward compliance-led forecasting.",
  "Our scan covered 400 supplier disclosures published this quarter.",
  "Northvolt and CATL have both re-sequenced their 2027 capacity plans.",
].join(" ");

/** The pipeline's own self-report at the end of pass one. */
export const PIPELINE_STATUS = "status=ok  errors=0  warnings=0  checks_passed=4/4";
