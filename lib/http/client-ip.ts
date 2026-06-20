// Client IP resolution.
//
// Rate limiting and metrics key off the client's identity. When the service runs
// behind a reverse proxy or load balancer, the TCP peer is the proxy, so every
// client collapses to one address — defeating per-client limits. With trustProxy
// enabled (only safe when a known proxy always sets the header) we honor the
// left-most X-Forwarded-For entry, which is the original client. When disabled we
// use the socket peer, which cannot be spoofed.

import type http from "node:http";

export interface ClientIpOptions {
  trustProxy: boolean;
}

function firstForwardedFor(headerValue: string | string[] | undefined): string | null {
  if (!headerValue) {
    return null;
  }
  const raw = Array.isArray(headerValue) ? headerValue.join(",") : headerValue;
  for (const part of raw.split(",")) {
    const candidate = part.trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

export function clientIp(request: http.IncomingMessage, options: ClientIpOptions): string {
  if (options.trustProxy) {
    const forwarded = firstForwardedFor(request.headers["x-forwarded-for"]);
    if (forwarded) {
      return forwarded;
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}
