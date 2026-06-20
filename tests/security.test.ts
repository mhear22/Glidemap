import test from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "../lib/http/security.js";

test("securityHeaders includes baseline hardening headers", () => {
  const headers = securityHeaders();
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  // SAMEORIGIN so the same-origin /render/ preview iframe can load, while still
  // blocking cross-origin clickjacking.
  assert.equal(headers["X-Frame-Options"], "SAMEORIGIN");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.ok(headers["Permissions-Policy"]);
});

test("securityHeaders allows same-origin framing for the preview iframe", () => {
  const csp = securityHeaders()["Content-Security-Policy"];
  assert.match(csp!, /frame-ancestors 'self'/);
});

test("securityHeaders emits a MapLibre-compatible CSP by default", () => {
  const csp = securityHeaders()["Content-Security-Policy"];
  assert.ok(csp);
  // MapLibre needs blob workers and https/data images.
  assert.match(csp!, /worker-src[^;]*blob:/);
  assert.match(csp!, /img-src[^;]*https:/);
  assert.match(csp!, /object-src 'none'/);
});

test("securityHeaders can omit the CSP", () => {
  const headers = securityHeaders({ contentSecurityPolicy: false });
  assert.equal(headers["Content-Security-Policy"], undefined);
});

test("securityHeaders adds HSTS only when requested", () => {
  assert.equal(securityHeaders()["Strict-Transport-Security"], undefined);
  assert.ok(securityHeaders({ hsts: true })["Strict-Transport-Security"]);
});
