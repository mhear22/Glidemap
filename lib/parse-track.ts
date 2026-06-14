import type { RoutedPath } from "../types/index.js";

/**
 * Result of parsing an uploaded track file. Shaped to match the renderer's
 * RoutedPath (see lib/routes.ts / prepareRoute -> route.path.coordinates), so
 * the output can be assigned directly to RouteConfig.path.
 *
 * Coordinates are emitted as [longitude, latitude] pairs — the exact order the
 * renderer consumes (confirmed against lib/routes.ts: lngLatToVector([lng, lat]),
 * haversineKilometers treating a[0] as lng / a[1] as lat, and buildFlightPath
 * pushing [point[0]=lng, point[1]=lat]).
 */
export interface ParsedTrack {
  coordinates: [number, number][];
  distanceMeters: number | null;
  durationSeconds: number | null;
  profile: string;
}

// A satisfies check that ParsedTrack stays assignable to RoutedPath.
const _shapeGuard: ParsedTrack = {
  coordinates: [],
  distanceMeters: null,
  durationSeconds: null,
  profile: "track"
} satisfies RoutedPath;
void _shapeGuard;

/** Upper bound on emitted points; longer tracks are deterministically downsampled. */
export const MAX_TRACK_POINTS = 4000;

const FORMAT_GPX = "gpx";
const FORMAT_KML = "kml";

function detectFormat(text: string): typeof FORMAT_GPX | typeof FORMAT_KML | null {
  // Look at element names so leading XML declarations / comments don't fool us.
  if (/<\s*(?:[\w.-]+:)?gpx\b/i.test(text) || /<\s*(?:[\w.-]+:)?(?:trkpt|rtept|wpt)\b/i.test(text)) {
    return FORMAT_GPX;
  }
  if (/<\s*(?:[\w.-]+:)?kml\b/i.test(text) || /<\s*(?:[\w.-]+:)?coordinates\b/i.test(text)) {
    return FORMAT_KML;
  }
  return null;
}

function isFiniteLngLat(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * Extract points from GPX. Namespace/prefix tolerant. Prefers <trkpt>, then
 * falls back to <rtept>, then <wpt>. Each carries lat="" lon="" attributes
 * (in any attribute order).
 */
function parseGpx(text: string): [number, number][] {
  for (const tag of ["trkpt", "rtept", "wpt"]) {
    const points = extractGpxPoints(text, tag);
    if (points.length > 0) {
      return points;
    }
  }
  return [];
}

function extractGpxPoints(text: string, tag: string): [number, number][] {
  // Match opening element regardless of namespace prefix or self-closing form.
  const elementPattern = new RegExp(
    `<\\s*(?:[\\w.-]+:)?${tag}\\b([^>]*?)/?\\s*>`,
    "gi"
  );
  const latPattern = /\blat\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  const lonPattern = /\blon\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

  const points: [number, number][] = [];
  let match: RegExpExecArray | null;
  while ((match = elementPattern.exec(text)) !== null) {
    const attrs = match[1] ?? "";
    const latMatch = latPattern.exec(attrs);
    const lonMatch = lonPattern.exec(attrs);
    if (!latMatch || !lonMatch) {
      continue;
    }
    const lat = Number(latMatch[1] ?? latMatch[2]);
    const lng = Number(lonMatch[1] ?? lonMatch[2]);
    if (isFiniteLngLat(lng, lat)) {
      points.push([lng, lat]);
    }
  }
  return points;
}

/**
 * Extract points from KML <coordinates> blocks. Each block holds whitespace-
 * separated tuples of "lon,lat[,alt]". Multiple blocks (e.g. several
 * LineStrings) are concatenated in document order.
 */
function parseKml(text: string): [number, number][] {
  const blockPattern = /<\s*(?:[\w.-]+:)?coordinates\b[^>]*>([\s\S]*?)<\s*\/\s*(?:[\w.-]+:)?coordinates\s*>/gi;
  const points: [number, number][] = [];
  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(text)) !== null) {
    const body = block[1] ?? "";
    for (const tuple of body.split(/\s+/)) {
      if (!tuple) {
        continue;
      }
      const parts = tuple.split(",");
      if (parts.length < 2) {
        continue;
      }
      const lng = Number(parts[0]);
      const lat = Number(parts[1]);
      if (isFiniteLngLat(lng, lat)) {
        points.push([lng, lat]);
      }
    }
  }
  return points;
}

/**
 * Deterministically downsample to at most `max` points while always keeping the
 * first and last point. Uses even index spacing so the same input always yields
 * the same output.
 */
function downsample(points: [number, number][], max: number): [number, number][] {
  if (points.length <= max || max < 2) {
    return points;
  }
  const result: [number, number][] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) {
    const index = Math.round(i * step);
    const point = points[index];
    if (point) result.push(point);
  }
  // Guarantee the true endpoints survive rounding.
  result[0] = points[0]!;
  result[result.length - 1] = points[points.length - 1]!;
  return result;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

/** Total great-circle length of the track in metres. */
function trackDistanceMeters(points: [number, number][]): number {
  let meters = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [lng1, lat1] = points[i - 1]!;
    const [lng2, lat2] = points[i]!;
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
    meters += 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return meters;
}

/**
 * Parse an uploaded GPX or KML track into a renderer-ready path.
 *
 * @param text Raw file contents.
 * @returns A {@link ParsedTrack} with `coordinates` as [lng, lat] pairs.
 * @throws Error if the input is empty, unrecognised, or contains no points.
 */
export function parseTrack(text: string): ParsedTrack {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Cannot parse an empty track file");
  }

  const format = detectFormat(text);
  if (!format) {
    throw new Error("Unrecognised track format: expected a GPX or KML file");
  }

  const rawPoints = format === FORMAT_GPX ? parseGpx(text) : parseKml(text);
  if (rawPoints.length === 0) {
    throw new Error(
      `No track points found in ${format.toUpperCase()} file ` +
        "(expected <trkpt>/<rtept>/<wpt> for GPX or <coordinates> for KML)"
    );
  }

  const coordinates = downsample(rawPoints, MAX_TRACK_POINTS);

  return {
    coordinates,
    distanceMeters: coordinates.length >= 2 ? Math.round(trackDistanceMeters(coordinates)) : 0,
    durationSeconds: null,
    profile: "track"
  };
}
