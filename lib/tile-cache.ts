import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { ensureDir } from "./utils.js";

interface TileProviderConfig {
  templateUrl: string;
  ext: string;
}

const TILE_PROVIDERS: Record<string, TileProviderConfig> = {
  satellite: {
    templateUrl: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ext: "png"
  },
  standard: {
    templateUrl: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    ext: "png"
  }
};

interface TileCache {
  handleTileRequest: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    provider: string,
    z: number,
    x: number,
    y: number
  ) => Promise<void>;
  getTile: (provider: string, z: number, x: number, y: number) => Promise<Buffer>;
  cacheDir: string;
  // Manually trigger a best-effort prune (e.g. on server startup). Never throws.
  pruneNow: () => Promise<void>;
}

interface TileResult {
  buffer: Buffer;
  cacheStatus: "hit" | "miss";
}

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1000];

// --- Bounded cache retention -------------------------------------------------
//
// The on-disk tile cache is otherwise unbounded and can fill the disk. We
// enforce a max total size (LRU eviction by mtime) and an optional max age.
// Pruning is always best-effort: it must never throw into the tile read/write
// hot path, so every entry point swallows its own errors.

const DEFAULT_MAX_MB = 1024;
const DEFAULT_MAX_AGE_DAYS = 30;

// How often the per-cache background timer runs a sweep.
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

// Probability that a successful tile write triggers an opportunistic sweep.
// Keeps the cache bounded between timer ticks under heavy write load without
// running a full directory walk on every miss.
const PRUNE_AFTER_WRITE_PROBABILITY = 0.02;

export interface PruneOptions {
  maxBytes?: number;
  maxAgeMs?: number;
}

export interface PruneResult {
  scanned: number;
  removed: number;
  bytesBefore: number;
  bytesRemoved: number;
}

function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

// Reads TILE_CACHE_MAX_MB / TILE_CACHE_MAX_AGE_DAYS with safe fallbacks. A
// value of 0 (or invalid) for the age means "no age limit".
function resolvePruneOptions(): Required<PruneOptions> {
  const maxMb = parsePositiveNumberEnv("TILE_CACHE_MAX_MB", DEFAULT_MAX_MB);

  const rawAge = process.env["TILE_CACHE_MAX_AGE_DAYS"];
  let maxAgeDays = DEFAULT_MAX_AGE_DAYS;
  if (rawAge !== undefined && rawAge.trim() !== "") {
    const parsed = Number(rawAge);
    // Explicit 0 disables age-based eviction; invalid values fall back.
    maxAgeDays = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_AGE_DAYS;
  }

  return {
    maxBytes: Math.floor(maxMb * 1024 * 1024),
    maxAgeMs: maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : 0
  };
}

interface CachedFileEntry {
  filePath: string;
  size: number;
  // Recency used for LRU ordering. atime when available, else mtime.
  recencyMs: number;
  ageRefMs: number;
}

// Recursively collects regular files under `root`, skipping in-flight temp
// files so we never delete a tile that an atomic write is about to rename in.
async function collectCacheFiles(root: string): Promise<CachedFileEntry[]> {
  const entries: CachedFileEntry[] = [];

  async function walk(currentDir: string): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      const fullPath = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!dirent.isFile() || dirent.name.endsWith(".tmp")) {
        continue;
      }

      try {
        const stat = await fs.stat(fullPath);
        const recencyMs = Math.max(stat.atimeMs, stat.mtimeMs);
        entries.push({
          filePath: fullPath,
          size: stat.size,
          recencyMs,
          ageRefMs: stat.mtimeMs
        });
      } catch {
        // File vanished mid-walk (e.g. concurrent prune/rename); skip it.
      }
    }
  }

  await walk(root);
  return entries;
}

async function removeFile(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    await fs.unlink(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

// Enforces max total size and optional max age over the on-disk cache rooted at
// `dir`. Oldest-by-recency files are evicted first until under the size limit.
// Best-effort: resolves rather than throwing on any I/O failure.
export async function pruneTileCache(dir: string, options: PruneOptions = {}): Promise<PruneResult> {
  const resolved = resolvePruneOptions();
  const maxBytes = options.maxBytes ?? resolved.maxBytes;
  const maxAgeMs = options.maxAgeMs ?? resolved.maxAgeMs;

  const result: PruneResult = { scanned: 0, removed: 0, bytesBefore: 0, bytesRemoved: 0 };

  let files: CachedFileEntry[];
  try {
    files = await collectCacheFiles(dir);
  } catch {
    return result;
  }

  result.scanned = files.length;
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
  }
  result.bytesBefore = totalBytes;

  const now = Date.now();

  // Age-based eviction first: drop anything older than the limit regardless of
  // total size, then re-evaluate size below.
  const survivors: CachedFileEntry[] = [];
  if (maxAgeMs > 0) {
    for (const file of files) {
      if (now - file.ageRefMs > maxAgeMs) {
        const freed = await removeFile(file.filePath);
        result.removed += 1;
        result.bytesRemoved += freed;
        totalBytes -= file.size;
      } else {
        survivors.push(file);
      }
    }
  } else {
    survivors.push(...files);
  }

  // Size-based LRU eviction: oldest recency first until under the limit.
  if (totalBytes > maxBytes) {
    survivors.sort((a, b) => a.recencyMs - b.recencyMs);
    for (const file of survivors) {
      if (totalBytes <= maxBytes) {
        break;
      }
      const freed = await removeFile(file.filePath);
      result.removed += 1;
      result.bytesRemoved += freed;
      totalBytes -= file.size;
    }
  }

  return result;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Upstream tile servers intermittently hang or return transient errors; a
// timeout is also what keeps a stuck fetch from wedging the inflight map.
async function fetchTileWithRetry(url: string): Promise<Buffer> {
  let lastError: Error = new Error("Tile fetch failed");

  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1] ?? 1000));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": "MapAnim-TileCache/1.0" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    lastError = new Error(`Tile fetch failed: ${response.status}`);
    if (!isRetryableStatus(response.status)) {
      throw lastError;
    }
  }

  throw lastError;
}

export function createTileCache({ cacheDir }: { cacheDir?: string } = {}): TileCache {
  const dir = cacheDir ?? path.resolve(process.cwd(), ".tile-cache");
  const inflight = new Map<string, Promise<TileResult>>();

  // Serialize prunes so the timer and post-write sweeps never run concurrently
  // (concurrent walks would just race over the same files). Always best-effort.
  let pruning = false;
  async function runPrune(): Promise<void> {
    if (pruning) {
      return;
    }
    pruning = true;
    try {
      await pruneTileCache(dir);
    } catch {
      // Retention is best-effort; never surface failures to callers.
    } finally {
      pruning = false;
    }
  }

  // Periodic background sweep. unref() so an idle cache timer can't keep the
  // process (e.g. a one-shot CLI run) alive.
  const pruneTimer = setInterval(() => {
    void runPrune();
  }, PRUNE_INTERVAL_MS);
  if (typeof pruneTimer.unref === "function") {
    pruneTimer.unref();
  }

  function getTileProviderConfig(provider: string): TileProviderConfig {
    const config = TILE_PROVIDERS[provider];
    if (!config) {
      throw new Error(`Unknown tile provider "${provider}"`);
    }

    return config;
  }

  function cachePath(provider: string, z: number, x: number, y: number): string {
    const config = getTileProviderConfig(provider);
    return path.join(dir, provider, String(z), String(x), `${y}.${config.ext}`);
  }

  function remoteUrl(provider: string, z: number, x: number, y: number): string {
    return getTileProviderConfig(provider).templateUrl
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  }

  async function getTileResult(provider: string, z: number, x: number, y: number): Promise<TileResult> {
    const filePath = cachePath(provider, z, x, y);

    try {
      return {
        buffer: await fs.readFile(filePath),
        cacheStatus: "hit"
      };
    } catch {
      // cache miss — continue to fetch
    }

    const key = `${provider}/${z}/${x}/${y}`;
    if (inflight.has(key)) {
      return inflight.get(key)!;
    }

    const promise = (async (): Promise<TileResult> => {
      const url = remoteUrl(provider, z, x, y);
      const buffer = await fetchTileWithRetry(url);
      await ensureDir(path.dirname(filePath));
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, buffer);
      await fs.rename(tempPath, filePath);
      // Opportunistic, fire-and-forget sweep so the cache stays bounded between
      // timer ticks under heavy write load. Does not block the tile response.
      if (Math.random() < PRUNE_AFTER_WRITE_PROBABILITY) {
        void runPrune();
      }
      return {
        buffer,
        cacheStatus: "miss"
      };
    })();

    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  async function getTile(provider: string, z: number, x: number, y: number): Promise<Buffer> {
    const result = await getTileResult(provider, z, x, y);
    return result.buffer;
  }

  async function handleTileRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    provider: string,
    z: number,
    x: number,
    y: number
  ): Promise<void> {
    if (!(provider in TILE_PROVIDERS)) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Unknown tile provider");
      return;
    }

    try {
      const tile = await getTileResult(provider, z, x, y);
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=2592000, stale-while-revalidate=86400",
        "X-MapAnim-Cache": tile.cacheStatus
      });
      response.end(tile.buffer);
    } catch (error) {
      response.writeHead(502, { "Content-Type": "text/plain" });
      response.end((error as Error).message);
    }
  }

  return { handleTileRequest, getTile, cacheDir: dir, pruneNow: runPrune };
}
