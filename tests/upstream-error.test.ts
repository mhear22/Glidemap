import test from "node:test";
import assert from "node:assert/strict";
import { UpstreamError, classifyUpstreamError } from "../lib/providers/osm.js";

test("UpstreamError exposes its message and carries an http status", () => {
  const err = new UpstreamError("upstream down", 502);
  assert.equal(err.name, "UpstreamError");
  assert.equal(err.statusCode, 502);
  assert.equal(err.expose, true);
  assert.equal(err.retryAfterSeconds, undefined);
  assert.ok(err instanceof Error);
});

test("a 429 upstream status becomes a retryable 503", () => {
  const err = classifyUpstreamError(429, new Error("Request failed with status 429"));
  assert.equal(err.statusCode, 503);
  assert.equal(err.retryAfterSeconds, 5);
  assert.match(err.message, /rate-limit/i);
  assert.equal(err.expose, true);
});

test("other upstream failures become a 502 without a retry hint", () => {
  for (const status of [500, 503, null]) {
    const err = classifyUpstreamError(status, new Error("boom"));
    assert.equal(err.statusCode, 502);
    assert.equal(err.retryAfterSeconds, undefined);
    assert.match(err.message, /temporarily unavailable/i);
  }
});

test("the original failure is preserved as the cause for logging", () => {
  const cause = new Error("ECONNRESET");
  const err = classifyUpstreamError(null, cause);
  assert.equal(err.cause, cause);
});
