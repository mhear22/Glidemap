import test from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../lib/logger.js";

interface Captured {
  level: string;
  line: string;
}

function makeLogger(level: "debug" | "info" | "warn" | "error" | "silent" = "debug") {
  const records: Captured[] = [];
  const logger = createLogger({
    level,
    sink: (lvl, line) => records.push({ level: lvl, line }),
    now: () => "2026-06-20T00:00:00.000Z",
    base: { service: "test" }
  });
  return { logger, records };
}

test("logger emits structured JSON with base fields and timestamp", () => {
  const { logger, records } = makeLogger();
  logger.info("hello", { foo: 1 });
  assert.equal(records.length, 1);
  const parsed = JSON.parse(records[0]!.line);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.service, "test");
  assert.equal(parsed.foo, 1);
  assert.equal(parsed.time, "2026-06-20T00:00:00.000Z");
});

test("logger filters below the configured level", () => {
  const { logger, records } = makeLogger("warn");
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  assert.deepEqual(records.map((r) => r.level), ["warn", "error"]);
});

test("silent level suppresses everything", () => {
  const { logger, records } = makeLogger("silent");
  logger.error("nope");
  assert.equal(records.length, 0);
});

test("child loggers merge bound context", () => {
  const { logger, records } = makeLogger();
  logger.child({ requestId: "abc" }).info("scoped");
  const parsed = JSON.parse(records[0]!.line);
  assert.equal(parsed.requestId, "abc");
  assert.equal(parsed.service, "test");
});

test("logger serializes Error objects in err/error fields", () => {
  const { logger, records } = makeLogger();
  logger.error("boom", { err: new Error("kaboom") });
  const parsed = JSON.parse(records[0]!.line);
  assert.equal(parsed.err.message, "kaboom");
  assert.equal(parsed.err.name, "Error");
  assert.ok(typeof parsed.err.stack === "string");
});

test("logger survives unserializable payloads", () => {
  const { logger, records } = makeLogger();
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  logger.info("loop", { circular });
  const parsed = JSON.parse(records[0]!.line);
  assert.equal(parsed.fieldsError, "unserializable");
});

test("logger serializes the 'error' field alias too", () => {
  const { logger, records } = makeLogger();
  logger.error("boom", { error: new Error("aliased") });
  const parsed = JSON.parse(records[0]!.line);
  assert.equal(parsed.error.message, "aliased");
  assert.equal(parsed.error.name, "Error");
});

test("default sink routes warn/error to stderr and info/debug to stdout", () => {
  const calls: { stream: "out" | "err"; line: string }[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    calls.push({ stream: "out", line: String(chunk) });
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    calls.push({ stream: "err", line: String(chunk) });
    return true;
  }) as typeof process.stderr.write;
  try {
    const logger = createLogger({ level: "debug", now: () => "t" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  const streams = calls.map((c) => c.stream);
  assert.deepEqual(streams, ["out", "out", "err", "err"]);
});
