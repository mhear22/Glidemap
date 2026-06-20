import test from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { clientIp } from "../lib/http/client-ip.js";

function mockRequest(headers: Record<string, string | string[]>, remoteAddress?: string): http.IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as http.IncomingMessage;
}

test("clientIp uses the socket address when proxy is not trusted", () => {
  const req = mockRequest({ "x-forwarded-for": "9.9.9.9" }, "10.0.0.1");
  assert.equal(clientIp(req, { trustProxy: false }), "10.0.0.1");
});

test("clientIp honors the left-most X-Forwarded-For entry when proxy is trusted", () => {
  const req = mockRequest({ "x-forwarded-for": "203.0.113.5, 70.41.3.18, 10.0.0.1" }, "10.0.0.1");
  assert.equal(clientIp(req, { trustProxy: true }), "203.0.113.5");
});

test("clientIp falls back to socket address when trusted but no header", () => {
  const req = mockRequest({}, "10.0.0.1");
  assert.equal(clientIp(req, { trustProxy: true }), "10.0.0.1");
});

test("clientIp handles array-valued forwarded headers", () => {
  const req = mockRequest({ "x-forwarded-for": ["203.0.113.5", "10.0.0.1"] }, "10.0.0.1");
  assert.equal(clientIp(req, { trustProxy: true }), "203.0.113.5");
});

test("clientIp returns 'unknown' when no address is available", () => {
  const req = mockRequest({});
  assert.equal(clientIp(req, { trustProxy: false }), "unknown");
});
