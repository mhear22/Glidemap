import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sleep, toError } from "../utils.js";
import type { Provider, ProviderSearchResult, RoutedPath } from "../../types/index.js";

const USER_AGENT = "MapAnim/0.2 (local webapp)";
const execFileAsync = promisify(execFile);

/**
 * An upstream map-data provider (geocoding/routing) failed. Carries an HTTP
 * status for the API layer to surface and `expose: true` so the friendly message
 * reaches the client even in production (where opaque 5xx messages are hidden).
 * A 429 from upstream becomes a retryable 503 so the UI can tell the user to wait,
 * rather than showing a confusing "Internal server error".
 */
export class UpstreamError extends Error {
  readonly statusCode: number;
  readonly expose = true;
  readonly retryAfterSeconds?: number;

  constructor(message: string, statusCode: number, options?: { retryAfterSeconds?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export function classifyUpstreamError(upstreamStatus: number | null, cause: unknown): UpstreamError {
  if (upstreamStatus === 429) {
    return new UpstreamError(
      "The map data provider is rate-limiting requests right now. Please wait a few seconds and try again.",
      503,
      { retryAfterSeconds: 5, cause }
    );
  }
  return new UpstreamError("The map data provider is temporarily unavailable. Please try again shortly.", 502, { cause });
}

interface NominatimResult {
  place_id?: number;
  display_name: string;
  lon: string;
  lat: string;
  address?: Record<string, string>;
}

interface OsrmRouteResponse {
  code?: string;
  routes?: Array<{
    geometry: { coordinates: [number, number][] };
    distance: number;
    duration: number;
  }>;
}

async function requestJsonViaCurl<T = unknown>(url: URL): Promise<T> {
  const { stdout } = await execFileAsync("curl", [
    "--silent",
    "--show-error",
    "--fail",
    "--location",
    "--max-time",
    "20",
    "--user-agent",
    USER_AGENT,
    "--header",
    "Accept-Language: en-AU",
    String(url)
  ]);
  return JSON.parse(stdout) as T;
}

async function requestJson<T = unknown>(url: URL, { retries = 3 }: { retries?: number } = {}): Promise<T> {
  let lastError: Error = new Error("Unknown error");
  // Track the most recent upstream HTTP status so the final thrown error can be
  // classified (a 429 is retryable; anything else is treated as unavailable).
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-AU"
        }
      });

      if (!response.ok) {
        lastStatus = response.status;
        throw new Error(`Request failed with status ${response.status}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = toError(error);

      try {
        return await requestJsonViaCurl<T>(url);
      } catch (curlError) {
        lastError = toError(curlError);
        // curl surfaces an HTTP status in its message (e.g. "error: 429"); recover
        // it so a rate-limit is still classified correctly when fetch was blocked.
        const curlStatus = /returned error: (\d{3})/.exec(lastError.message)?.[1];
        if (curlStatus) {
          lastStatus = Number(curlStatus);
        }
      }

      if (attempt < retries - 1) {
        await sleep(450 * (attempt + 1));
      }
    }
  }

  throw classifyUpstreamError(lastStatus, lastError);
}

export function createOsmProvider(
  baseUrl: string = "https://nominatim.openstreetmap.org",
  osrmBaseUrl: string = "https://router.project-osrm.org"
): Provider {
  return {
    id: "osm",

    async search(query: string, { limit = 5 }: { limit?: number } = {}): Promise<ProviderSearchResult[]> {
      const url = new URL("/search", baseUrl);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("q", query);

      const results = await requestJson<NominatimResult[]>(url);
      return Array.isArray(results)
        ? results.map((item, index) => ({
            id: `osm-${item.place_id ?? index}`,
            provider: "osm",
            label: item.display_name,
            query: item.display_name,
            coords: [Number(item.lon), Number(item.lat)] as [number, number],
            address: item.address ?? null
          }))
        : [];
    },

    async geocode(query: string): Promise<ProviderSearchResult> {
      const results = await this.search(query, { limit: 1 });
      const [result] = results;
      if (!result) {
        throw new Error(`No geocoding result found for "${query}"`);
      }

      return result;
    },

    async route({ fromCoords, toCoords, mode }: { fromCoords: [number, number]; toCoords: [number, number]; mode: string }): Promise<RoutedPath> {
      const profile = mapTravelModeToProfile(mode);
      const url = new URL(
        `/route/v1/${profile}/${fromCoords[0]},${fromCoords[1]};${toCoords[0]},${toCoords[1]}`,
        osrmBaseUrl
      );
      url.searchParams.set("overview", "full");
      url.searchParams.set("geometries", "geojson");
      url.searchParams.set("steps", "false");

      const payload = await requestJson<OsrmRouteResponse>(url);
      if (payload.code !== "Ok" || !payload.routes?.[0]?.geometry?.coordinates?.length) {
        throw new Error(`Routing failed with code ${payload.code ?? "unknown"}`);
      }

      return {
        coordinates: payload.routes[0].geometry.coordinates,
        distanceMeters: payload.routes[0].distance,
        durationSeconds: payload.routes[0].duration,
        profile
      };
    }
  };
}

export function mapTravelModeToProfile(mode: string = "walking"): string {
  switch (mode) {
    case "walking":
    case "foot":
      return "foot";
    case "driving":
    case "car":
      return "driving";
    case "flying":
    case "flight":
      return "flight";
    case "public transport":
    case "public-transport":
    case "transit":
      throw new Error("Public transport requires route.path.coordinates because no built-in transit router is configured");
    default:
      throw new Error(`Unsupported travel mode "${mode}"`);
  }
}
