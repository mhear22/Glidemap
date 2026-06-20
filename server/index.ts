import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JobSummary, RenderJob, RenderProgress, RouteConfig, SerializedJob } from "../types/index.js";
import type { PresetSaveRequest } from "../types/index.js";
import { createPresetStore } from "../lib/presets/store.js";
import { createProviderRegistry } from "../lib/providers/index.js";
import { createRenderQueue } from "../lib/render/queue.js";
import { createRenderAssetHandler, safeResolve } from "../lib/render/asset-handler.js";
import { renderRouteToVideo } from "../lib/render/video.js";
import { prepareRoute } from "../lib/routes.js";
import { createTileCache } from "../lib/tile-cache.js";
import { createMetricsCollector } from "../lib/metrics.js";
import { contentTypeFor, toError } from "../lib/utils.js";
import { loadConfig } from "../lib/config.js";
import { createLogger, type Logger } from "../lib/logger.js";
import { readJsonRecord } from "../lib/http/body.js";
import { createRateLimiter, type RateLimiter, type RateLimitResult } from "../lib/http/rate-limit.js";
import { securityHeaders } from "../lib/http/security.js";
import { clientIp } from "../lib/http/client-ip.js";
import { createAuthGuard } from "../lib/http/auth.js";
import { corsHeaders, isPreflight } from "../lib/http/cors.js";
import { validateRouteConfig } from "../lib/validation/route.js";
import { resolveRequestId } from "../lib/http/request-id.js";
import { createPrometheusRegistry } from "../lib/metrics/prometheus.js";
import { branding } from "../branding.js";

interface FrontendHost {
  kind: "main" | "admin";
  label: string;
  distDir: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "web");
const webappDistDir = path.join(rootDir, "webapp", "dist");
const adminappDistDir = path.join(rootDir, "adminapp", "dist");

const config = loadConfig();
const logger = createLogger({
  level: config.logLevel,
  base: { service: branding.name.toLowerCase() }
});

function readVersion(): string {
  try {
    return readFileSync(path.join(rootDir, "VERSION"), "utf8").trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const version = readVersion();

const providerRegistry = createProviderRegistry({
  nominatimUrl: config.nominatimUrl,
  osrmUrl: config.osrmUrl,
  searchCache: config.searchCache
});
const presetStore = createPresetStore({ rootDir });
const tileCache = createTileCache({ cacheDir: path.join(rootDir, ".tile-cache") });
const metricsCollector = createMetricsCollector({ rootDir });
const apiLimiter = createRateLimiter(config.rateLimit);
const searchLimiter = createRateLimiter(config.searchRateLimit);
const authGuard = createAuthGuard({ secret: config.apiSecret });
const securityResponseHeaders = securityHeaders({
  hsts: config.isProduction,
  contentSecurityPolicy: config.contentSecurityPolicy
});

const SEARCH_QUERY_MAX_LENGTH = 256;

// Prometheus instrumentation for the golden signals plus queue depth.
const prometheus = createPrometheusRegistry();
const httpRequestsTotal = prometheus.counter("glidemap_http_requests_total", "Total HTTP requests by method and status.");
const httpErrorsTotal = prometheus.counter("glidemap_http_errors_total", "Total HTTP responses with a 5xx status.");
const httpRequestDuration = prometheus.histogram(
  "glidemap_http_request_duration_seconds",
  "HTTP request duration in seconds.",
  [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10]
);

const sseClients = new Set<http.ServerResponse>();
const servers: http.Server[] = [];
let renderOrigin: string | null = null;
let shuttingDown = false;
const startedAt = Date.now();

const frontendHosts: Record<FrontendHost["kind"], FrontendHost> = {
  main: {
    kind: "main",
    label: "webapp",
    distDir: webappDistDir
  },
  admin: {
    kind: "admin",
    label: "admin",
    distDir: adminappDistDir
  }
};

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function applyRateLimitHeaders(response: http.ServerResponse, result: RateLimitResult): void {
  response.setHeader("X-RateLimit-Limit", String(result.limit));
  response.setHeader("X-RateLimit-Remaining", String(result.remaining));
  response.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response: http.ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(text);
}

function jobSummary(route: Partial<RouteConfig> = {}): JobSummary {
  return {
    id: route.id ?? null,
    name: route.name ?? route.id ?? null,
    startLabel: route.start?.label ?? route.from?.label ?? route.start?.query ?? "",
    endLabel: route.end?.label ?? route.to?.label ?? route.end?.query ?? "",
    mode: route.mode ?? "walking",
    mapType: route.mapType ?? "satellite",
    output: route.output ?? null
  };
}

function outputUrlFromAbsolute(filePath: string | undefined | null): string | null {
  if (!filePath) {
    return null;
  }

  const relative = path.relative(rootDir, filePath);
  if (relative.startsWith("..")) {
    return null;
  }

  return `/${relative.split(path.sep).join("/")}`;
}

function serializeJob(job: RenderJob): SerializedJob {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    error: job.error ?? null,
    progress: job.progress ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    summary: jobSummary(job.payload?.route),
    result: job.result
      ? {
          outputPath: job.result.outputPath,
          outputUrl: outputUrlFromAbsolute(job.result.outputPath),
          routeId: job.result.route?.id ?? null
        }
      : null
  };
}

function broadcastJobs(queue: ReturnType<typeof createRenderQueue>): void {
  const payload = `data: ${JSON.stringify({ jobs: queue.list().map(serializeJob) })}\n\n`;
  for (const client of sseClients) {
    // A client can close (or be ended during shutdown) between queue events;
    // writing to it would throw ERR_STREAM_DESTROYED, so prune and skip it.
    if (client.writableEnded || client.destroyed) {
      sseClients.delete(client);
      continue;
    }
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function getRenderBaseUrl(): string {
  if (!renderOrigin) {
    throw new Error("Render server is not ready yet");
  }

  return `${renderOrigin}/render/`;
}

const queue = createRenderQueue({
  worker: async (payload: { route: RouteConfig }, emitProgress: (progress: Partial<RenderProgress>) => void, signal: AbortSignal) =>
    renderRouteToVideo(payload.route, {
      rootDir,
      renderBaseUrl: getRenderBaseUrl(),
      providerRegistry,
      onProgress: emitProgress,
      signal
    })
});

queue.subscribe(() => {
  broadcastJobs(queue);
});

prometheus.gauge("glidemap_render_queue_depth", "Number of render jobs queued or running.", () =>
  queue.list().filter((job) => job.status === "queued" || job.status === "running").length
);

// Geocoding search cache: entry count plus cumulative hit/miss totals so the
// upstream-call savings (and the cache's effectiveness) are observable.
prometheus.gauge("glidemap_search_cache_entries", "Geocoding search results currently cached.", () =>
  providerRegistry.searchCacheStats?.()?.size ?? 0
);
prometheus.gauge("glidemap_search_cache_hits", "Cumulative geocoding searches served from cache.", () =>
  providerRegistry.searchCacheStats?.()?.hits ?? 0
);
prometheus.gauge("glidemap_search_cache_misses", "Cumulative geocoding searches that hit the upstream provider.", () =>
  providerRegistry.searchCacheStats?.()?.misses ?? 0
);

const handleRenderAssetRequest = createRenderAssetHandler({
  rootDir,
  webDir,
  mountPath: "/render",
  allowOutput: true,
  tileCache
});

function requestOrigin(request: http.IncomingMessage): string {
  const host = request.headers.host;
  if (host) {
    return `http://${host}`;
  }

  return renderOrigin ?? "http://127.0.0.1";
}

/** Operational endpoints (liveness, readiness, Prometheus scrape) — answered
 * before visitor metrics, rate limiting, and auth so orchestrators and scrapers
 * neither pollute analytics nor get throttled/blocked. */
function handleHealthEndpoints(request: http.IncomingMessage, response: http.ServerResponse, pathname: string): boolean {
  if (request.method !== "GET") {
    return false;
  }

  if (pathname === "/metrics") {
    response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    response.end(prometheus.render());
    return true;
  }

  if (pathname === "/api/health" || pathname === "/healthz") {
    sendJson(response, 200, {
      status: "ok",
      name: branding.name,
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
    });
    return true;
  }

  if (pathname === "/api/ready" || pathname === "/readyz") {
    const ready = renderOrigin !== null && !shuttingDown;
    sendJson(response, ready ? 200 : 503, {
      status: ready ? "ready" : shuttingDown ? "shutting_down" : "starting",
      renderReady: renderOrigin !== null
    });
    return true;
  }

  return false;
}

async function handleApi(request: http.IncomingMessage, response: http.ServerResponse, pathname: string): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/search") {
    const requested = new URL(request.url ?? "/", requestOrigin(request));
    const query = requested.searchParams.get("q")?.trim();
    const providerName = requested.searchParams.get("provider") ?? providerRegistry.defaultProvider;

    if (!query) {
      sendJson(response, 200, { results: [] });
      return true;
    }

    if (query.length > SEARCH_QUERY_MAX_LENGTH) {
      sendJson(response, 400, { error: `Query must be at most ${SEARCH_QUERY_MAX_LENGTH} characters` });
      return true;
    }

    if (!providerRegistry.listProviders().includes(providerName)) {
      sendJson(response, 400, { error: `Unknown provider "${providerName}"` });
      return true;
    }

    const provider = providerRegistry.getProvider(providerName);
    const results = await provider.search(query, { limit: 5 });
    metricsCollector.recordSearch();
    sendJson(response, 200, { results });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/preview") {
    const body = await readJsonRecord(request, config.maxRequestBodyBytes);
    const route = await prepareRoute(validateRouteConfig(body["route"] ?? body), { providerRegistry });
    sendJson(response, 200, { route });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/presets") {
    const presets = await presetStore.list();
    sendJson(response, 200, { presets });
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/api/presets/")) {
    const id = decodeURIComponent(pathname.replace("/api/presets/", ""));
    const preset = await presetStore.get(id);
    sendJson(response, 200, preset);
    return true;
  }

  if (request.method === "POST" && pathname === "/api/presets") {
    const body = await readJsonRecord(request, config.maxRequestBodyBytes);
    const route = validateRouteConfig(body["route"]);
    const name = parseOptionalString(body["name"]);
    const payload: PresetSaveRequest = name === undefined ? { route } : { name, route };
    const saved = await presetStore.save(payload);
    sendJson(response, 200, saved);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/render-jobs") {
    sendJson(response, 200, { jobs: queue.list().map(serializeJob) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/render-jobs") {
    const body = await readJsonRecord(request, config.maxRequestBodyBytes);
    const job = queue.enqueue({
      route: validateRouteConfig(body["route"] ?? body)
    });
    sendJson(response, 202, { job: serializeJob(job) });
    return true;
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/render-jobs/")) {
    const jobId = decodeURIComponent(pathname.replace("/api/render-jobs/", ""));
    const cancelled = queue.cancel(jobId);
    if (!cancelled) {
      sendJson(response, 404, { error: "Job not found or not cancellable" });
      return true;
    }
    sendJson(response, 200, { cancelled: true });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/metrics") {
    const metrics = await metricsCollector.getMetrics("24h");
    sendJson(response, 200, metrics);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/render-events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.write(`data: ${JSON.stringify({ jobs: queue.list().map(serializeJob) })}\n\n`);
    sseClients.add(response);
    // Clean up on either side ending: the client disconnecting (request close)
    // or the response finishing/erroring (e.g. released during shutdown).
    const cleanup = (): void => {
      sseClients.delete(response);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
    return true;
  }

  return false;
}

async function serveFile(response: http.ServerResponse, filePath: string): Promise<void> {
  const data = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypeFor(filePath)
  });
  response.end(data);
}

async function serveFrontendAsset(response: http.ServerResponse, frontend: FrontendHost, pathname: string): Promise<boolean> {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const assetPath = safeResolve(frontend.distDir, requestedPath);

  try {
    await serveFile(response, assetPath);
    return true;
  } catch (error) {
    const resolvedError = error as NodeJS.ErrnoException;
    if (resolvedError.code !== "ENOENT" && resolvedError.code !== "ENOTDIR") {
      throw error;
    }
  }

  const indexPath = path.join(frontend.distDir, "index.html");
  try {
    await serveFile(response, indexPath);
    return true;
  } catch (error) {
    const resolvedError = error as NodeJS.ErrnoException;
    if (resolvedError.code === "ENOENT") {
      sendText(
        response,
        503,
        `${frontend.label} build not found. Run "npm run build:${frontend.kind === "main" ? "webapp" : "admin"}" before starting the packaged server.`
      );
      return true;
    }

    throw error;
  }
}

function statusForError(error: Error): number {
  const candidate = (error as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number" && candidate >= 400 && candidate <= 599) {
    return candidate;
  }
  return 500;
}

function sendError(response: http.ServerResponse, error: Error, log: Logger): void {
  const status = statusForError(error);
  // Don't leak internal failure details to clients in production; log them fully.
  const clientMessage = status >= 500 && config.isProduction ? "Internal server error" : error.message;

  if (status >= 500) {
    log.error("request failed", { err: error, status });
  } else {
    log.warn("request rejected", { msg: error.message, status });
  }

  const headers: http.OutgoingHttpHeaders = { "Content-Type": "application/json; charset=utf-8" };
  // A 413 means we stopped reading the request body mid-stream; the socket may
  // still hold unread bytes, so close it rather than risk a corrupt keep-alive.
  if (status === 413) {
    headers["Connection"] = "close";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify({ error: clientMessage }));
}

function clientIpOf(request: http.IncomingMessage): string {
  return clientIp(request, { trustProxy: config.trustProxy });
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  frontend: FrontendHost | null
): Promise<void> {
  // Honour an upstream correlation id when present so a request can be traced
  // across hops; otherwise mint a fresh one.
  const requestId = resolveRequestId(request.headers["x-request-id"]);
  const requestLogger = logger.child({ requestId });
  const startTime = Date.now();

  // Security headers and a correlation id apply to every response. They're set
  // before any writeHead so handler-specified headers merge on top cleanly.
  for (const [header, value] of Object.entries(securityResponseHeaders)) {
    response.setHeader(header, value);
  }
  response.setHeader("X-Request-Id", requestId);

  // CORS: reflect an allowed origin (no-op when not configured) on every response.
  const corsResponseHeaders = corsHeaders(request.headers.origin, config.corsOrigins);
  for (const [header, value] of Object.entries(corsResponseHeaders)) {
    response.setHeader(header, value);
  }

  let pathname = "/";
  try {
    const requested = new URL(request.url ?? "/", requestOrigin(request));
    pathname = requested.pathname;

    response.on("finish", () => {
      const durationMs = Date.now() - startTime;
      const cacheStatus = response.getHeader("X-MapAnim-Cache");
      if (cacheStatus === "hit") {
        metricsCollector.recordCacheHit();
      } else if (cacheStatus === "miss") {
        metricsCollector.recordCacheMiss();
      }
      httpRequestsTotal.inc({ method: request.method ?? "UNKNOWN", status: String(response.statusCode) });
      httpRequestDuration.observe(durationMs / 1000);
      if (response.statusCode >= 500) {
        httpErrorsTotal.inc();
      }
      requestLogger.info("request", {
        method: request.method,
        path: pathname,
        status: response.statusCode,
        durationMs,
        ip: clientIpOf(request)
      });
    });

    // Answer CORS preflight before anything else.
    if (isPreflight(request)) {
      response.writeHead(corsResponseHeaders["Access-Control-Allow-Origin"] ? 204 : 403);
      response.end();
      return;
    }

    // Operational probes short-circuit everything else (so orchestrators still
    // get an honest readiness signal while we drain).
    if (handleHealthEndpoints(request, response, pathname)) {
      return;
    }

    // Once draining, reject new work immediately rather than starting requests
    // that may be cut off when the listeners close.
    if (shuttingDown) {
      sendJson(response, 503, { error: "Server is shutting down" });
      return;
    }

    metricsCollector.recordVisitor(clientIpOf(request));

    if (pathname.startsWith("/api/")) {
      const limiter: RateLimiter = pathname === "/api/search" ? searchLimiter : apiLimiter;
      const limit = limiter.check(clientIpOf(request));
      applyRateLimitHeaders(response, limit);
      if (!limit.allowed) {
        response.setHeader("Retry-After", String(limit.retryAfterSeconds));
        sendJson(response, 429, { error: "Too many requests" });
        return;
      }

      // Optional bearer-token auth (no-op unless MAPANIM_API_SECRET is set).
      if (authGuard.required && !authGuard.authorize(request)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { error: "Unauthorized" });
        requestLogger.warn("unauthorized request", { path: pathname, ip: clientIpOf(request) });
        return;
      }

      const handled = await handleApi(request, response, pathname);
      if (!handled) {
        sendJson(response, 404, { error: "Not found" });
      }
      return;
    }

    if (await handleRenderAssetRequest(request, response, pathname)) {
      return;
    }

    if (!frontend) {
      sendText(response, 404, "Frontend assets are not served by this process.");
      return;
    }

    await serveFrontendAsset(response, frontend, pathname);
  } catch (error) {
    const resolvedError = toError(error);
    if (!response.headersSent) {
      sendError(response, resolvedError, requestLogger);
      return;
    }

    requestLogger.error("request failed after headers sent", { err: resolvedError, path: pathname });
    response.end();
  }
}

function createListener(frontend: FrontendHost | null): http.Server {
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, frontend);
  });
  if (config.requestTimeoutMs > 0) {
    server.requestTimeout = config.requestTimeoutMs;
    // headersTimeout must not exceed requestTimeout.
    server.headersTimeout = Math.min(server.headersTimeout || config.requestTimeoutMs, config.requestTimeoutMs);
  }
  servers.push(server);
  return server;
}

function resolvePublicOrigin(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${publicHost}:${port}`;
}

function logListener(label: string, host: string, port: number): void {
  const publicOrigin = resolvePublicOrigin(host, port);
  logger.info(`${label} listening`, { url: publicOrigin, host, port, version });
}

async function listen(server: http.Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  return typeof address === "object" && address ? address.port : port;
}

async function startFrontendListener(frontend: FrontendHost, host: string, port: number, setRenderBaseUrl: boolean): Promise<void> {
  const server = createListener(frontend);
  const resolvedPort = await listen(server, host, port);

  if (setRenderBaseUrl) {
    renderOrigin = resolvePublicOrigin(host, resolvedPort);
  }

  logListener(frontend.label, host, resolvedPort);
}

async function startBackendOnlyListener(host: string, port: number): Promise<void> {
  const server = createListener(null);
  const resolvedPort = await listen(server, host, port);
  renderOrigin = resolvePublicOrigin(host, resolvedPort);
  logListener("api", host, resolvedPort);
}

let shutdownPromise: Promise<void> | null = null;

function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  shuttingDown = true;
  logger.info("shutdown initiated", { signal });

  shutdownPromise = (async () => {
    const forceTimer = setTimeout(() => {
      logger.error("shutdown timed out; forcing exit", { timeoutMs: config.shutdownTimeoutMs });
      process.exit(exitCode);
    }, config.shutdownTimeoutMs);
    forceTimer.unref();

    // Cancel queued renders and abort any in-flight render, logging what was
    // interrupted so the loss is visible rather than silent.
    const drained = queue.drain();
    if (drained.running.length > 0 || drained.queued.length > 0) {
      logger.warn("render queue drained", { running: drained.running, queued: drained.queued });
    }

    // Release long-lived SSE streams so server.close can complete.
    for (const client of sseClients) {
      client.end();
    }
    sseClients.clear();

    metricsCollector.stop();
    apiLimiter.stop();
    searchLimiter.stop();

    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeIdleConnections?.();
            server.close(() => resolve());
          })
      )
    );

    clearTimeout(forceTimer);
    logger.info("shutdown complete");
    process.exit(exitCode);
  })();

  return shutdownPromise;
}

function registerProcessHandlers(): void {
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", { err: error });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", { err: reason });
  });
}

async function main(): Promise<void> {
  registerProcessHandlers();

  if (!config.serveUi) {
    await startBackendOnlyListener(config.host, config.apiPort);
    return;
  }

  await startFrontendListener(frontendHosts.main, config.host, config.mainPort, true);
  await startFrontendListener(frontendHosts.admin, config.host, config.adminPort, false);
}

main().catch((error: unknown) => {
  logger.error("startup failed", { err: toError(error) });
  process.exitCode = 1;
});
