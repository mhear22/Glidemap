import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sleep, toError } from "../utils.js";
import type { Provider, ProviderSearchResult, RoutedPath } from "../../types/index.js";

const USER_AGENT = "MapAnim/0.2 (local webapp)";
const execFileAsync = promisify(execFile);

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

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-AU"
        }
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = toError(error);

      try {
        return await requestJsonViaCurl<T>(url);
      } catch (curlError) {
        lastError = toError(curlError);
      }

      if (attempt < retries - 1) {
        await sleep(450 * (attempt + 1));
      }
    }
  }

  throw lastError;
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
