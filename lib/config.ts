// Centralized, validated runtime configuration.
//
// Every environment variable the server reads is parsed and validated exactly
// once, here, into a typed and frozen `AppConfig`. Code elsewhere depends on the
// typed config instead of reaching into `process.env`, so misconfiguration fails
// fast at startup with a clear message rather than surfacing as a confusing
// runtime error later.

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error", "silent"];

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface SearchCacheConfig {
  /** Maximum number of distinct search queries to retain. */
  maxEntries: number;
  /** How long a cached search result stays fresh, in milliseconds. */
  ttlMs: number;
}

export interface AppConfig {
  /** Network interface to bind. */
  host: string;
  /** When false, only the backend API/render listener starts (no UI hosting). */
  serveUi: boolean;
  /** Main webapp frontend port (also hosts the API in single-process mode). */
  mainPort: number;
  /** Admin frontend port. Must differ from mainPort. */
  adminPort: number;
  /** Backend-only API port (used when serveUi is false). */
  apiPort: number;
  /** Minimum severity that gets logged. */
  logLevel: LogLevel;
  /** Hard cap on request body size, in bytes. Protects against memory-exhaustion. */
  maxRequestBodyBytes: number;
  /** Per-request inactivity timeout, in milliseconds (0 disables). */
  requestTimeoutMs: number;
  /** Default rate limit applied to all /api/* endpoints. */
  rateLimit: RateLimitConfig;
  /** Tighter rate limit for the upstream-hitting search endpoint. */
  searchRateLimit: RateLimitConfig;
  /** Grace period for in-flight requests to drain on shutdown, in milliseconds. */
  shutdownTimeoutMs: number;
  /** Upstream geocoding base URL. */
  nominatimUrl: string;
  /** Upstream routing (OSRM) base URL. */
  osrmUrl: string;
  /** In-memory cache for geocoding search results (shields the upstream provider). */
  searchCache: SearchCacheConfig;
  /** Trust X-Forwarded-For for client identity (only enable behind a known proxy). */
  trustProxy: boolean;
  /** Shared secret required as a Bearer token on /api/* when set; null disables auth. */
  apiSecret: string | null;
  /** Allowed CORS origins. Empty = no CORS headers; ["*"] = allow any origin. */
  corsOrigins: string[];
  /** Emit a Content-Security-Policy header (disable if a fronting proxy sets one). */
  contentSecurityPolicy: boolean;
  /** Whether the process is running in production mode. */
  isProduction: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function parseInteger(env: Env, key: string, fallback: number, { min, max }: { min: number; max: number }): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${key} must be an integer, received "${raw}"`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, received ${value}`);
  }

  return value;
}

function parsePort(env: Env, key: string, fallback: number): number {
  return parseInteger(env, key, fallback, { min: 1, max: 65_535 });
}

function parseBoolean(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new ConfigError(`${key} must be a boolean ("0"/"1"/"true"/"false"), received "${raw}"`);
}

function parseLogLevel(env: Env, key: string, fallback: LogLevel): LogLevel {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as LogLevel;
  }

  throw new ConfigError(`${key} must be one of ${LOG_LEVELS.join(", ")}, received "${raw}"`);
}

/**
 * Build a validated, frozen application config from an environment map.
 * Pure and side-effect free so it can be unit-tested with synthetic envs.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const isProduction = (env["NODE_ENV"] ?? "").trim().toLowerCase() === "production";

  // PORT is the conventional platform-provided port; it maps to the main
  // frontend port in UI mode and the API port in backend-only mode.
  const portOverride = env["PORT"];

  const mainPort = portOverride
    ? parsePort(env, "PORT", 5173)
    : parsePort(env, "MAPANIM_MAIN_PORT", 5173);
  const adminPort = parsePort(env, "MAPANIM_ADMIN_PORT", 5174);
  const apiPort = portOverride
    ? parsePort(env, "PORT", 4822)
    : parsePort(env, "MAPANIM_API_PORT", 4822);

  const serveUi = parseBoolean(env, "MAPANIM_SERVE_UI", true);

  if (serveUi && adminPort === mainPort) {
    throw new ConfigError("MAPANIM_ADMIN_PORT must differ from the main frontend port");
  }

  const host = (env["HOST"]?.trim() || "127.0.0.1");
  const nominatimUrl = env["NOMINATIM_URL"]?.trim() || "https://nominatim.openstreetmap.org";
  const osrmUrl = env["OSRM_URL"]?.trim() || "https://router.project-osrm.org";

  const apiSecretRaw = env["MAPANIM_API_SECRET"]?.trim();
  const apiSecret = apiSecretRaw ? apiSecretRaw : null;
  if (apiSecretRaw !== undefined && apiSecretRaw !== "" && apiSecretRaw.length < 16) {
    throw new ConfigError("MAPANIM_API_SECRET must be at least 16 characters");
  }

  const corsOrigins = (env["MAPANIM_CORS_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const config: AppConfig = {
    host,
    serveUi,
    mainPort,
    adminPort,
    apiPort,
    logLevel: parseLogLevel(env, "LOG_LEVEL", isProduction ? "info" : "debug"),
    maxRequestBodyBytes: parseInteger(env, "MAPANIM_MAX_BODY_BYTES", 1_048_576, {
      min: 1_024,
      max: 64 * 1_048_576
    }),
    requestTimeoutMs: parseInteger(env, "MAPANIM_REQUEST_TIMEOUT_MS", 30_000, { min: 0, max: 600_000 }),
    rateLimit: {
      windowMs: parseInteger(env, "MAPANIM_RATE_WINDOW_MS", 60_000, { min: 1_000, max: 3_600_000 }),
      max: parseInteger(env, "MAPANIM_RATE_MAX", 240, { min: 1, max: 1_000_000 })
    },
    searchRateLimit: {
      windowMs: parseInteger(env, "MAPANIM_SEARCH_RATE_WINDOW_MS", 60_000, { min: 1_000, max: 3_600_000 }),
      max: parseInteger(env, "MAPANIM_SEARCH_RATE_MAX", 30, { min: 1, max: 1_000_000 })
    },
    shutdownTimeoutMs: parseInteger(env, "MAPANIM_SHUTDOWN_TIMEOUT_MS", 10_000, { min: 0, max: 120_000 }),
    nominatimUrl,
    osrmUrl,
    searchCache: {
      maxEntries: parseInteger(env, "MAPANIM_SEARCH_CACHE_MAX", 500, { min: 0, max: 1_000_000 }),
      ttlMs: parseInteger(env, "MAPANIM_SEARCH_CACHE_TTL_MS", 3_600_000, { min: 0, max: 86_400_000 })
    },
    trustProxy: parseBoolean(env, "MAPANIM_TRUST_PROXY", false),
    apiSecret,
    corsOrigins,
    contentSecurityPolicy: parseBoolean(env, "MAPANIM_CSP", true),
    isProduction
  };

  return Object.freeze(config);
}
