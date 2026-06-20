import test from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { createAuthGuard } from "../lib/http/auth.js";

function mockRequest(authorization?: string): http.IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as unknown as http.IncomingMessage;
}

test("auth guard is inert when no secret is configured", () => {
  const guard = createAuthGuard({ secret: null });
  assert.equal(guard.required, false);
  assert.equal(guard.authorize(mockRequest()), true);
  assert.equal(guard.authorize(mockRequest("Bearer anything")), true);
});

test("auth guard requires a matching bearer token when a secret is set", () => {
  const secret = "super-secret-token-1234";
  const guard = createAuthGuard({ secret });
  assert.equal(guard.required, true);
  assert.equal(guard.authorize(mockRequest(`Bearer ${secret}`)), true);
  assert.equal(guard.authorize(mockRequest("Bearer wrong-token")), false);
  assert.equal(guard.authorize(mockRequest()), false);
});

test("auth guard rejects malformed authorization headers", () => {
  const guard = createAuthGuard({ secret: "super-secret-token-1234" });
  assert.equal(guard.authorize(mockRequest("super-secret-token-1234")), false); // no Bearer prefix
  assert.equal(guard.authorize(mockRequest("Basic super-secret-token-1234")), false);
  assert.equal(guard.authorize(mockRequest("Bearer ")), false);
});

test("auth guard tolerates extra spaces after Bearer", () => {
  const guard = createAuthGuard({ secret: "super-secret-token-1234" });
  assert.equal(guard.authorize(mockRequest("Bearer    super-secret-token-1234")), true);
});

test("auth guard does not crash on length-mismatched tokens", () => {
  const guard = createAuthGuard({ secret: "super-secret-token-1234" });
  assert.equal(guard.authorize(mockRequest("Bearer short")), false);
});
