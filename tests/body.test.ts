import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type http from "node:http";
import { readRawBody, readJsonBody, readJsonRecord, BodyTooLargeError, InvalidJsonError } from "../lib/http/body.js";

function mockRequest(chunks: (string | Buffer)[]): http.IncomingMessage {
  const buffers = chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)));
  return Readable.from(buffers) as unknown as http.IncomingMessage;
}

test("readRawBody concatenates chunks under the limit", async () => {
  const body = await readRawBody(mockRequest(["hello ", "world"]), 1024);
  assert.equal(body, "hello world");
});

test("readRawBody rejects bodies over the byte limit", async () => {
  const big = "x".repeat(2048);
  await assert.rejects(() => readRawBody(mockRequest([big]), 1024), BodyTooLargeError);
});

test("readRawBody counts raw bytes for multibyte payloads", async () => {
  // Each '€' is 3 UTF-8 bytes; 10 of them = 30 bytes, over a 16-byte cap.
  await assert.rejects(() => readRawBody(mockRequest(["€".repeat(10)]), 16), BodyTooLargeError);
});

test("readJsonBody parses valid JSON", async () => {
  const parsed = await readJsonBody(mockRequest(['{"a":1}']), 1024);
  assert.deepEqual(parsed, { a: 1 });
});

test("readJsonBody returns empty object for empty body", async () => {
  const parsed = await readJsonBody(mockRequest([""]), 1024);
  assert.deepEqual(parsed, {});
});

test("readJsonBody rejects malformed JSON", async () => {
  await assert.rejects(() => readJsonBody(mockRequest(["{not json"]), 1024), InvalidJsonError);
});

test("readJsonRecord rejects non-object JSON", async () => {
  await assert.rejects(() => readJsonRecord(mockRequest(["[1,2,3]"]), 1024), InvalidJsonError);
});

test("BodyTooLargeError carries a 413 status", () => {
  const error = new BodyTooLargeError(1024);
  assert.equal(error.statusCode, 413);
});
