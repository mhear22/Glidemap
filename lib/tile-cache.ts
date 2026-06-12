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
}

interface TileResult {
  buffer: Buffer;
  cacheStatus: "hit" | "miss";
}

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1000];

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

  return { handleTileRequest, getTile, cacheDir: dir };
}
