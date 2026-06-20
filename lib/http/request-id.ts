// Request correlation id.
//
// A gateway, load balancer, or upstream service often stamps a correlation id on
// the request so a single user action can be traced across every hop. We honour an
// inbound `X-Request-Id` when it's present and well-formed, and otherwise mint our
// own. The inbound value is sanitised and length-capped so a hostile client can't
// inject control characters or unbounded data into our logs (a log-forging vector).

import crypto from "node:crypto";

const MAX_INBOUND_LENGTH = 128;
// Conservative token charset covering UUIDs, ULIDs, and W3C trace ids.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Resolve the correlation id for a request. Returns a sanitised inbound id when
 * the header carries a single, well-formed value; otherwise mints a fresh one.
 * `header` accepts the raw `http.IncomingMessage` header shape (string, array, or
 * undefined) so callers can pass `request.headers["x-request-id"]` directly.
 */
export function resolveRequestId(header: string | string[] | undefined): string {
  // A duplicated header arrives as an array; trust nothing ambiguous.
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") {
    return generateRequestId();
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INBOUND_LENGTH || !SAFE_REQUEST_ID.test(trimmed)) {
    return generateRequestId();
  }

  return trimmed;
}
