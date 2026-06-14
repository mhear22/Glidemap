import fs from "node:fs/promises";
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
import { parseTrack } from "../lib/parse-track.js";
import { createTileCache } from "../lib/tile-cache.js";
import { createMetricsCollector } from "../lib/metrics.js";
import { contentTypeFor, isRecord, toError } from "../lib/utils.js";
import { branding } from "../branding.js";

interface FrontendHost {
  kind: "main" | "admin";
  label: string;
  distDir: string;
}

/** An error carrying an HTTP status code so handlers can return 4xx instead of 500. */
class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
}

const MAX_BODY_BYTES = Math.max(1, Number(process.env["MAX_BODY_MB"] ?? 8)) * 1024 * 1024;
const MAX_QUEUE_DEPTH = Math.max(1, Number(process.env["MAX_QUEUE_DEPTH"] ?? 20));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "web");
const webappDistDir = path.join(rootDir, "webapp", "dist");
const adminappDistDir = path.join(rootDir, "adminapp", "dist");
const providerRegistry = createProviderRegistry();
const presetStore = createPresetStore({ rootDir });
const tileCache = createTileCache({ cacheDir: path.join(rootDir, ".tile-cache") });
const metricsCollector = createMetricsCollector({ rootDir });
const sseClients = new Set<http.ServerResponse>();
const servers: http.Server[] = [];
let renderOrigin: string | null = null;

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

async function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(buf);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

async function readRequestRecord(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readRequestBody(request);
  if (!isRecord(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }

  return body;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assertRange(label: string, value: number | undefined, min: number, max: number): void {
  if (value !== undefined && (value < min || value > max)) {
    throw new HttpError(400, `${label} must be between ${min} and ${max}`);
  }
}

function parseRouteConfig(value: unknown): RouteConfig {
  if (!isRecord(value)) {
    throw new HttpError(400, "Request body must include a route object");
  }

  // Bound the expensive knobs so a hostile/garbled body can't request an
  // absurd render (e.g. 100000x100000 @ 10000fps) or crash downstream.
  assertRange("width", finiteNumber(value["width"]), 16, 7680);
  assertRange("height", finiteNumber(value["height"]), 16, 7680);
  assertRange("fps", finiteNumber(value["fps"]), 1, 120);
  assertRange("durationSeconds", finiteNumber(value["durationSeconds"]), 0.5, 600);

  for (const key of ["start", "end"] as const) {
    const loc = value[key];
    if (isRecord(loc) && loc["coords"] != null) {
      const coords = loc["coords"];
      if (
        !Array.isArray(coords) || coords.length !== 2 ||
        !Number.isFinite(Number(coords[0])) || !Number.isFinite(Number(coords[1]))
      ) {
        throw new HttpError(400, `${key}.coords must be [lng, lat]`);
      }
    }
  }

  return value as RouteConfig;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
    client.write(payload);
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
    }),
  persistPath: path.join(rootDir, ".queue-state.json")
});

queue.subscribe(() => {
  broadcastJobs(queue);
});

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

async function handleApi(request: http.IncomingMessage, response: http.ServerResponse, pathname: string): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/search") {
    const requested = new URL(request.url ?? "/", requestOrigin(request));
    const query = requested.searchParams.get("q")?.trim();
    const providerName = requested.searchParams.get("provider") ?? providerRegistry.defaultProvider;

    if (!query) {
      sendJson(response, 200, { results: [] });
      return true;
    }

    const provider = providerRegistry.getProvider(providerName);
    const results = await provider.search(query, { limit: 5 });
    metricsCollector.recordSearch();
    sendJson(response, 200, { results });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/preview") {
    const body = await readRequestRecord(request);
    const route = await prepareRoute(parseRouteConfig(body["route"] ?? body), { providerRegistry });
    sendJson(response, 200, { route });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/import-track") {
    const body = await readRequestRecord(request);
    const text = parseOptionalString(body["text"]);
    if (!text) {
      throw new HttpError(400, "Provide GPX or KML text in the 'text' field");
    }
    let track: ReturnType<typeof parseTrack>;
    try {
      track = parseTrack(text);
    } catch (error) {
      throw new HttpError(400, toError(error).message);
    }
    sendJson(response, 200, { path: track });
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
    const body = await readRequestRecord(request);
    const route = parseRouteConfig(body["route"]);
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
    const active = queue.list().filter((j) => j.status === "queued" || j.status === "running").length;
    if (active >= MAX_QUEUE_DEPTH) {
      throw new HttpError(429, "Render queue is full — wait for jobs to finish and try again.");
    }
    const body = await readRequestRecord(request);
    const job = queue.enqueue({
      route: parseRouteConfig(body["route"] ?? body)
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
    request.on("close", () => {
      sseClients.delete(response);
    });
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

function sendError(response: http.ServerResponse, error: Error): void {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error: error.message }));
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  frontend: FrontendHost | null
): Promise<void> {
  try {
    const clientIp = request.socket.remoteAddress ?? "unknown";
    metricsCollector.recordVisitor(clientIp);

    response.on("finish", () => {
      const cacheStatus = response.getHeader("X-MapAnim-Cache");
      if (cacheStatus === "hit") {
        metricsCollector.recordCacheHit();
      } else if (cacheStatus === "miss") {
        metricsCollector.recordCacheMiss();
      }
    });

    const requested = new URL(request.url ?? "/", requestOrigin(request));
    const pathname = requested.pathname;

    if (pathname.startsWith("/api/")) {
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
    const resolvedError = error instanceof HttpError ? error : toError(error);
    if (!response.headersSent) {
      sendError(response, resolvedError);
      return;
    }

    response.end();
  }
}

function createListener(frontend: FrontendHost | null): http.Server {
  return http.createServer((request, response) => {
    void handleRequest(request, response, frontend);
  });
}

function resolveListenPort(value: string | undefined, fallback: number): number {
  const resolved = Number(value ?? fallback);
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`Invalid port "${value}"`);
  }

  return resolved;
}

function resolvePublicOrigin(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${publicHost}:${port}`;
}

function logListener(label: string, host: string, port: number): void {
  const publicOrigin = resolvePublicOrigin(host, port);
  if (host === "0.0.0.0") {
    console.log(`${branding.name} ${label} running at ${publicOrigin} (listening on ${host}:${port})`);
    return;
  }

  console.log(`${branding.name} ${label} running at ${publicOrigin}`);
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
  servers.push(server);
  const resolvedPort = await listen(server, host, port);

  if (setRenderBaseUrl) {
    renderOrigin = resolvePublicOrigin(host, resolvedPort);
  }

  logListener(frontend.label, host, resolvedPort);
}

async function startBackendOnlyListener(host: string, port: number): Promise<void> {
  const server = createListener(null);
  servers.push(server);
  const resolvedPort = await listen(server, host, port);
  renderOrigin = resolvePublicOrigin(host, resolvedPort);
  logListener("api", host, resolvedPort);
}

async function pruneOutputs(): Promise<void> {
  const dir = path.join(rootDir, "output");
  const maxAgeMs = Math.max(0, Number(process.env["OUTPUT_MAX_AGE_DAYS"] ?? 14)) * 86_400_000;
  const maxFiles = Math.max(1, Number(process.env["OUTPUT_MAX_FILES"] ?? 200));
  try {
    const names = await fs.readdir(dir);
    const stated = await Promise.all(names.map(async (name) => {
      try {
        const stat = await fs.stat(path.join(dir, name));
        return stat.isFile() ? { name, mtime: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    }));
    const files = stated
      .filter((entry): entry is { name: string; mtime: number } => entry !== null)
      .sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();
    const stale = files.filter((f, i) => i >= maxFiles || (maxAgeMs > 0 && now - f.mtime > maxAgeMs));
    for (const f of stale) {
      try {
        await fs.unlink(path.join(dir, f.name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* output dir may not exist yet */
  }
}

function registerLifecycle(): void {
  // Retention sweeps so output/ and the tile cache can't fill the disk.
  void pruneOutputs();
  void tileCache.pruneNow();
  const retentionTimer = setInterval(() => {
    void pruneOutputs();
    void tileCache.pruneNow();
  }, 30 * 60_000);
  retentionTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`${branding.name}: received ${signal}, draining…`);
    for (const server of servers) {
      server.close();
    }
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    // Abort in-flight/queued renders; the worker's finally{} tears down
    // Chromium + ffmpeg and stops a half-written file being left behind.
    for (const job of queue.list()) {
      if (job.status === "queued" || job.status === "running") {
        queue.cancel(job.id);
      }
    }
    metricsCollector.stop();
    clearInterval(retentionTimer);
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main(): Promise<void> {
  const host = process.env["HOST"] ?? "127.0.0.1";
  const serveUi = process.env["MAPANIM_SERVE_UI"] !== "0";

  if (!serveUi) {
    const apiPort = resolveListenPort(process.env["PORT"] ?? process.env["MAPANIM_API_PORT"], 4822);
    await startBackendOnlyListener(host, apiPort);
    registerLifecycle();
    return;
  }

  const mainPort = resolveListenPort(process.env["PORT"] ?? process.env["MAPANIM_MAIN_PORT"], 5173);
  const adminPort = resolveListenPort(process.env["MAPANIM_ADMIN_PORT"], 5174);
  if (adminPort === mainPort) {
    throw new Error("MAPANIM_ADMIN_PORT must differ from the main frontend port");
  }

  await startFrontendListener(frontendHosts.main, host, mainPort, true);
  await startFrontendListener(frontendHosts.admin, host, adminPort, false);

  registerLifecycle();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
