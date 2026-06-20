import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../lib/config.js";

test("loadConfig applies sane defaults for an empty environment", () => {
  const config = loadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.serveUi, true);
  assert.equal(config.mainPort, 5173);
  assert.equal(config.adminPort, 5174);
  assert.equal(config.apiPort, 4822);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.maxRequestBodyBytes, 1_048_576);
  assert.equal(config.rateLimit.max, 240);
  assert.equal(config.searchRateLimit.max, 30);
  assert.equal(config.isProduction, false);
});

test("loadConfig defaults log level to info in production", () => {
  const config = loadConfig({ NODE_ENV: "production" });
  assert.equal(config.isProduction, true);
  assert.equal(config.logLevel, "info");
});

test("loadConfig maps PORT onto the main and api ports", () => {
  const ui = loadConfig({ PORT: "8080" });
  assert.equal(ui.mainPort, 8080);
  // In UI mode PORT drives the main port; the api port keeps its own default.
  assert.equal(ui.serveUi, true);
  assert.equal(ui.apiPort, 8080);

  const api = loadConfig({ PORT: "8080", MAPANIM_SERVE_UI: "0" });
  assert.equal(api.serveUi, false);
  assert.equal(api.apiPort, 8080);
});

test("loadConfig parses the new enterprise fields", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.trustProxy, false);
  assert.equal(defaults.apiSecret, null);
  assert.deepEqual(defaults.corsOrigins, []);
  assert.equal(defaults.contentSecurityPolicy, true);

  const configured = loadConfig({
    MAPANIM_TRUST_PROXY: "1",
    MAPANIM_API_SECRET: "a-sufficiently-long-secret",
    MAPANIM_CORS_ORIGINS: "https://a.example, https://b.example",
    MAPANIM_CSP: "0"
  });
  assert.equal(configured.trustProxy, true);
  assert.equal(configured.apiSecret, "a-sufficiently-long-secret");
  assert.deepEqual(configured.corsOrigins, ["https://a.example", "https://b.example"]);
  assert.equal(configured.contentSecurityPolicy, false);
});

test("loadConfig rejects a too-short API secret", () => {
  assert.throws(() => loadConfig({ MAPANIM_API_SECRET: "short" }), ConfigError);
});

test("loadConfig rejects a non-integer port", () => {
  assert.throws(() => loadConfig({ MAPANIM_MAIN_PORT: "abc" }), ConfigError);
});

test("loadConfig rejects an out-of-range port", () => {
  assert.throws(() => loadConfig({ MAPANIM_MAIN_PORT: "70000" }), ConfigError);
});

test("loadConfig rejects identical main and admin ports in UI mode", () => {
  assert.throws(() => loadConfig({ MAPANIM_MAIN_PORT: "5000", MAPANIM_ADMIN_PORT: "5000" }), ConfigError);
});

test("loadConfig allows equal ports when UI is disabled", () => {
  const config = loadConfig({ MAPANIM_SERVE_UI: "false", MAPANIM_MAIN_PORT: "5000", MAPANIM_ADMIN_PORT: "5000" });
  assert.equal(config.serveUi, false);
});

test("loadConfig parses booleans flexibly and rejects garbage", () => {
  assert.equal(loadConfig({ MAPANIM_SERVE_UI: "no" }).serveUi, false);
  assert.equal(loadConfig({ MAPANIM_SERVE_UI: "ON" }).serveUi, true);
  assert.throws(() => loadConfig({ MAPANIM_SERVE_UI: "maybe" }), ConfigError);
});

test("loadConfig validates rate limit bounds", () => {
  assert.throws(() => loadConfig({ MAPANIM_RATE_MAX: "0" }), ConfigError);
  assert.equal(loadConfig({ MAPANIM_RATE_MAX: "10" }).rateLimit.max, 10);
});

test("loadConfig rejects an unknown log level", () => {
  assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), ConfigError);
});

test("loadConfig defaults the upstream URLs and search cache", () => {
  const config = loadConfig({});
  assert.equal(config.nominatimUrl, "https://nominatim.openstreetmap.org");
  assert.equal(config.osrmUrl, "https://router.project-osrm.org");
  assert.equal(config.searchCache.maxEntries, 500);
  assert.equal(config.searchCache.ttlMs, 3_600_000);
});

test("loadConfig parses overridden upstream URLs and search cache bounds", () => {
  const config = loadConfig({
    NOMINATIM_URL: "https://geo.internal/ ",
    OSRM_URL: " https://osrm.internal",
    MAPANIM_SEARCH_CACHE_MAX: "50",
    MAPANIM_SEARCH_CACHE_TTL_MS: "120000"
  });
  assert.equal(config.nominatimUrl, "https://geo.internal/");
  assert.equal(config.osrmUrl, "https://osrm.internal");
  assert.equal(config.searchCache.maxEntries, 50);
  assert.equal(config.searchCache.ttlMs, 120_000);
});

test("loadConfig allows disabling the search cache with zeros", () => {
  const config = loadConfig({ MAPANIM_SEARCH_CACHE_MAX: "0", MAPANIM_SEARCH_CACHE_TTL_MS: "0" });
  assert.equal(config.searchCache.maxEntries, 0);
  assert.equal(config.searchCache.ttlMs, 0);
});

test("loadConfig rejects out-of-range search cache values", () => {
  assert.throws(() => loadConfig({ MAPANIM_SEARCH_CACHE_MAX: "-1" }), ConfigError);
  assert.throws(() => loadConfig({ MAPANIM_SEARCH_CACHE_TTL_MS: "999999999" }), ConfigError);
});

test("loadConfig returns a frozen object", () => {
  const config = loadConfig({});
  assert.throws(() => {
    (config as { host: string }).host = "0.0.0.0";
  });
});
