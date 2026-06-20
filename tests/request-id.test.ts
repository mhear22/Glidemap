import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequestId, generateRequestId } from "../lib/http/request-id.js";

test("generateRequestId produces a short non-empty token", () => {
  const id = generateRequestId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
  assert.match(id, /^[a-f0-9]+$/);
});

test("honours a well-formed inbound request id", () => {
  assert.equal(resolveRequestId("abc123"), "abc123");
  assert.equal(resolveRequestId("0af7651916cd43dd8448eb211c80319c"), "0af7651916cd43dd8448eb211c80319c");
  assert.equal(resolveRequestId("  trace-42_x.1  "), "trace-42_x.1", "trims surrounding whitespace");
});

test("mints a fresh id when no inbound header is present", () => {
  const generated = resolveRequestId(undefined);
  assert.match(generated, /^[a-f0-9]+$/);
  assert.notEqual(resolveRequestId(""), "");
});

test("rejects malformed inbound ids and falls back to a generated one", () => {
  for (const bad of ["has space", "semi;colon", "new\nline", "<script>", "a".repeat(129)]) {
    const id = resolveRequestId(bad);
    assert.notEqual(id, bad, `should not echo unsafe value ${JSON.stringify(bad)}`);
    assert.match(id, /^[a-f0-9]+$/, "falls back to a generated id");
  }
});

test("takes the first value when the header is duplicated", () => {
  assert.equal(resolveRequestId(["first-id", "second-id"]), "first-id");
  // A duplicated header whose first value is malformed still falls back safely.
  assert.match(resolveRequestId(["bad value", "ok"]), /^[a-f0-9]+$/);
});
