import test from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { corsHeaders, resolveAllowedOrigin, isPreflight } from "../lib/http/cors.js";

test("no CORS headers when the allow-list is empty", () => {
  assert.deepEqual(corsHeaders("https://example.com", []), {});
});

test("reflects an allowed origin and sets Vary", () => {
  const headers = corsHeaders("https://app.example.com", ["https://app.example.com"]);
  assert.equal(headers["Access-Control-Allow-Origin"], "https://app.example.com");
  assert.equal(headers["Vary"], "Origin");
  assert.match(headers["Access-Control-Allow-Methods"]!, /POST/);
});

test("disallowed origin gets no CORS headers", () => {
  assert.deepEqual(corsHeaders("https://evil.example.com", ["https://app.example.com"]), {});
});

test("wildcard allow-list permits any origin without Vary", () => {
  const headers = corsHeaders("https://anything.example", ["*"]);
  assert.equal(headers["Access-Control-Allow-Origin"], "*");
  assert.equal(headers["Vary"], undefined);
});

test("resolveAllowedOrigin returns null without a request origin", () => {
  assert.equal(resolveAllowedOrigin(undefined, ["*"]), null);
});

test("isPreflight detects OPTIONS with an Origin", () => {
  const optionsWithOrigin = { method: "OPTIONS", headers: { origin: "https://x" } } as unknown as http.IncomingMessage;
  const optionsNoOrigin = { method: "OPTIONS", headers: {} } as unknown as http.IncomingMessage;
  const getReq = { method: "GET", headers: { origin: "https://x" } } as unknown as http.IncomingMessage;
  assert.equal(isPreflight(optionsWithOrigin), true);
  assert.equal(isPreflight(optionsNoOrigin), false);
  assert.equal(isPreflight(getReq), false);
});
