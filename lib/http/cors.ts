// Configurable Cross-Origin Resource Sharing.
//
// Off by default (empty allow-list -> no CORS headers, same-origin only). When
// origins are configured, a matching request Origin is reflected back with the
// appropriate Allow-* headers, and OPTIONS preflight requests are answered. A
// literal "*" in the allow-list permits any origin.

import type http from "node:http";

const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";
const MAX_AGE_SECONDS = "3600";

export function isPreflight(request: http.IncomingMessage): boolean {
  return request.method === "OPTIONS" && Boolean(request.headers["origin"]);
}

/**
 * Resolve the Access-Control-Allow-Origin value for a request, or null if
 * disallowed. A wildcard allow-list returns "*" for any origin — including the
 * literal "null" origin sent by sandboxed/opaque contexts; that is the standard
 * meaning of "*". Use an explicit origin list if that breadth is unwanted.
 */
export function resolveAllowedOrigin(requestOrigin: string | undefined, allowedOrigins: string[]): string | null {
  if (allowedOrigins.length === 0 || !requestOrigin) {
    return null;
  }
  if (allowedOrigins.includes("*")) {
    return "*";
  }
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
}

/** CORS headers to merge into a response, or an empty object when CORS does not apply. */
export function corsHeaders(requestOrigin: string | undefined, allowedOrigins: string[]): Record<string, string> {
  const allowOrigin = resolveAllowedOrigin(requestOrigin, allowedOrigins);
  if (!allowOrigin) {
    return {};
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": MAX_AGE_SECONDS
  };
  // Caches must vary on Origin whenever the allowed origin is request-specific.
  if (allowOrigin !== "*") {
    headers["Vary"] = "Origin";
  }
  return headers;
}
