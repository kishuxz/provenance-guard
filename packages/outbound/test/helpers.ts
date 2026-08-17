import type { ChannelType, Chunk, CredibilityTier } from "@provguard/schema";

/**
 * Build a chunk the way a real caller does: a full provenance record, not a
 * bare tier. Keeping the whole record in the tests means they exercise the
 * shared `Chunk` shape rather than the subset this package happens to read.
 */
export function chunk(options: {
  id: string;
  text: string;
  tier?: CredibilityTier;
  channel?: ChannelType;
  sourceId?: string;
  upstreamStatus?: number;
}): Chunk {
  const { id, text, tier = "T2", channel = "RETRIEVED_DOC", sourceId = `src-${id}` } = options;
  return {
    id,
    text,
    provenance: {
      sourceId,
      channel,
      tier,
      retrievedAt: "2026-08-17T12:00:00Z",
      contentHash: `sha256-${id}`,
      ...(options.upstreamStatus === undefined ? {} : { upstreamStatus: options.upstreamStatus }),
    },
  };
}

/** A real Apache-style HTML error page, as a tool result would carry it. */
export const HTTP_400_PAGE = chunk({
  id: "http-400",
  sourceId: "tool:fetch",
  channel: "DIAGNOSTIC_LOG",
  tier: "T5",
  upstreamStatus: 400,
  text: [
    "HTTP/1.1 400 Bad Request",
    "Date: Mon, 17 Aug 2026 12:00:00 GMT",
    "Content-Type: text/html; charset=iso-8859-1",
    "Connection: close",
    "",
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">",
    "<html><head>",
    "<title>400 Bad Request</title>",
    "</head><body>",
    "<h1>Bad Request</h1>",
    "<p>Your browser sent a request that this server could not understand.<br />",
    "</p>",
    "<hr>",
    "<address>Apache/2.4.41 (Ubuntu) Server at api.internal Port 443</address>",
    "</body></html>",
  ].join("\n"),
});

/** A connection failure, the other half of a context that carries no facts. */
export const SOCKET_ERROR = chunk({
  id: "sock-1",
  sourceId: "tool:db",
  channel: "DIAGNOSTIC_LOG",
  tier: "T4",
  text: [
    "Error: connect ETIMEDOUT 10.0.4.19:5432",
    "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1247:16)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n"),
});
