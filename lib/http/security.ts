// Security response headers.
//
// A baseline set of hardening headers applied to every response, plus a
// Content-Security-Policy tuned for the MapLibre frontend (which spins up web
// workers from blob: URLs and pulls raster tiles over https). The CSP is built
// once and reused; the baseline headers are static.

export interface SecurityHeaderOptions {
  /** Emit a Content-Security-Policy. Disable if fronted by a proxy that sets one. */
  contentSecurityPolicy?: boolean;
  /** Send Strict-Transport-Security (only meaningful behind HTTPS). */
  hsts?: boolean;
}

const BASELINE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-DNS-Prefetch-Control": "off",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()"
});

// MapLibre GL creates workers from blob: URLs and decodes tiles/images that may
// arrive over https or as data/blob URIs, so those sources must be allowed.
const CSP_DIRECTIVES: Readonly<Record<string, string>> = Object.freeze({
  "default-src": "'self'",
  "base-uri": "'self'",
  "script-src": "'self' blob:",
  "worker-src": "'self' blob:",
  "child-src": "'self' blob:",
  // MapLibre injects inline styles for the canvas/controls.
  "style-src": "'self' 'unsafe-inline'",
  "img-src": "'self' data: blob: https:",
  "media-src": "'self' blob:",
  "connect-src": "'self' https:",
  "font-src": "'self' data:",
  "object-src": "'none'",
  "frame-ancestors": "'none'",
  "form-action": "'self'"
});

function buildCsp(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, value]) => `${directive} ${value}`)
    .join("; ");
}

const CSP_VALUE = buildCsp();

/** Return the security headers to merge into a response. */
export function securityHeaders(options: SecurityHeaderOptions = {}): Record<string, string> {
  const { contentSecurityPolicy = true, hsts = false } = options;
  const headers: Record<string, string> = { ...BASELINE_HEADERS };

  if (contentSecurityPolicy) {
    headers["Content-Security-Policy"] = CSP_VALUE;
  }
  if (hsts) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  }

  return headers;
}
