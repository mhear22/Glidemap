// Minimal structured (JSON-lines) logger.
//
// Production systems need machine-parseable logs with consistent fields, level
// filtering, and per-request correlation. This logger emits one JSON object per
// line, supports child loggers that carry bound context (e.g. a request id), and
// filters by a configured minimum level. It deliberately has no dependencies and
// writes through an injectable sink so it is trivial to test.

import type { LogLevel } from "./config.js";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that always includes the given fields. */
  child(fields: LogFields): Logger;
}

type EmittableLevel = Exclude<LogLevel, "silent">;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

export interface LoggerOptions {
  level?: LogLevel;
  /** Where serialized log lines are written. Defaults to the matching console method. */
  sink?: (level: EmittableLevel, line: string) => void;
  /** Static fields merged into every record (e.g. service name). */
  base?: LogFields;
  /** Clock injection point for deterministic tests. */
  now?: () => string;
}

function defaultSink(level: EmittableLevel, line: string): void {
  // Route warnings/errors to stderr so log shippers and humans can split streams.
  if (level === "error" || level === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function normalizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = key === "err" || key === "error" ? serializeError(value) : value;
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const sink = options.sink ?? defaultSink;
  const base = options.base ?? {};
  const now = options.now ?? (() => new Date().toISOString());
  const threshold = LEVEL_WEIGHT[level];

  function emit(target: EmittableLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[target] < threshold) {
      return;
    }

    const record: LogFields = {
      level: target,
      time: now(),
      msg: message,
      ...base,
      ...(fields ? normalizeFields(fields) : {})
    };

    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Circular or otherwise unserializable payload — fall back to a safe record.
      line = JSON.stringify({ level: target, time: now(), msg: message, fieldsError: "unserializable" });
    }
    sink(target, line);
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child(childFields: LogFields): Logger {
      return createLogger({
        level,
        sink,
        base: { ...base, ...childFields },
        now
      });
    }
  };
}
