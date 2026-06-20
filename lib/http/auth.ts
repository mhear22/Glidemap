// Optional bearer-token API authentication.
//
// Authentication is opt-in: when no secret is configured the guard is inert and
// every request is allowed (suitable for local/dev use). When a secret is set,
// requests must carry `Authorization: Bearer <secret>`. The comparison is
// constant-time to avoid leaking the secret through timing, and length is checked
// first because timingSafeEqual requires equal-length buffers.

import crypto from "node:crypto";
import type http from "node:http";

export interface AuthGuard {
  /** True when a secret is configured and requests must authenticate. */
  readonly required: boolean;
  /** Whether this request presents valid credentials. Always true when not required. */
  authorize(request: http.IncomingMessage): boolean;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer[ ]+(.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

function timingSafeEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export function createAuthGuard({ secret }: { secret: string | null }): AuthGuard {
  const required = secret !== null && secret.length > 0;

  return {
    required,
    authorize(request: http.IncomingMessage): boolean {
      if (!required || secret === null) {
        return true;
      }
      const token = extractBearer(request.headers["authorization"]);
      if (token === null) {
        return false;
      }
      return timingSafeEquals(token, secret);
    }
  };
}
