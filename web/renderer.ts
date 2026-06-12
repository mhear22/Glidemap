import type { GeoJSONSource, Map as MapLibreMap, Marker as MapLibreMarker, StyleSpecification } from "maplibre-gl";
import type { PreparedRoute, RendererApi, RendererCommandMessage, RendererReadyMessage } from "../types/index.js";

// --- Types ---

export interface PathSampler {
  coordinates: [number, number][];
  cumulative: number[];
  total: number;
}

export interface CameraState {
  start: { center: [number, number]; zoom: number };
  overview: { center: [number, number]; zoom: number };
  end: { center: [number, number]; zoom: number };
  routePath: PathSampler;
  cameraPath: PathSampler;
  aggressiveness: number;
  timingCurve: number;
  timingInverted: boolean;
  clipPath: boolean;
}

export interface RendererState {
  map: MapLibreMap | null;
  scene: PreparedRoute | null;
  markers: MapLibreMarker[];
  avatarMarker: MapLibreMarker | null;
  cameras: CameraState | null;
  mapType: string | null;
  lastProgress: number;
}

declare global {
  interface Window {
    __MAP_RENDERER__?: RendererApi;
    __MAP_RENDERER_READY__?: boolean;
    maplibregl: typeof import("maplibre-gl");
  }
}

// --- Implementation ---

const { maplibregl } = window;

const state: RendererState = {
  map: null,
  scene: null,
  markers: [],
  avatarMarker: null,
  cameras: null,
  mapType: null,
  lastProgress: 0
};

let tileCacheReadyPromise: Promise<void> | null = null;

async function ensureTileCacheReady(): Promise<void> {
  if (tileCacheReadyPromise) {
    return tileCacheReadyPromise;
  }

  tileCacheReadyPromise = (async () => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      return;
    }

    await navigator.serviceWorker.register("/tile-cache-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  })().catch((error: unknown) => {
    console.warn("Tile cache service worker registration failed", error);
  });

  return tileCacheReadyPromise;
}

function buildBaseStyle(mapType = "satellite"): StyleSpecification {
  if (mapType === "standard") {
    return {
      version: 8 as const,
      sources: {
        carto: {
          type: "raster" as const,
          tiles: [
            "/tiles/standard/{z}/{x}/{y}"
          ],
          tileSize: 256,
          attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
        }
      },
      layers: [
        {
          id: "carto-base",
          type: "raster" as const,
          source: "carto"
        }
      ]
    };
  }

  return {
    version: 8 as const,
    sources: {
      carto: {
        type: "raster" as const,
        tiles: [
          "/tiles/satellite/{z}/{x}/{y}"
        ],
        tileSize: 256,
        attribution: "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
      }
    },
    layers: [
      {
        id: "carto-base",
        type: "raster" as const,
        source: "carto"
      }
    ]
  };
}

function requireMap(): MapLibreMap {
  if (!state.map) {
    throw new Error("Map has not been initialized");
  }

  return state.map;
}

function requireCameras(): CameraState {
  if (!state.cameras) {
    throw new Error("Camera state has not been initialized");
  }

  return state.cameras;
}

function getRouteSource(map: MapLibreMap): GeoJSONSource {
  const source = map.getSource("route");
  if (!source || !("setData" in source)) {
    throw new Error("Route source is unavailable");
  }

  return source as GeoJSONSource;
}

function toCoordinatePair(
  value: { toArray(): [number, number] } | { lng: number; lat: number } | { lon: number; lat: number } | [number, number]
): [number, number] {
  if (Array.isArray(value)) {
    const [lng = 0, lat = 0] = value;
    return [lng, lat];
  }

  if ("toArray" in value) {
    return value.toArray();
  }

  return ["lng" in value ? value.lng : value.lon, value.lat];
}

function createMarker(label: string, className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = `route-label ${className}`.trim();
  element.textContent = label;
  return element;
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function sampleTimingEasing(t: number, intensity: number, inverted: boolean): number {
  const linear = t;
  const cubic = easeInOutCubic(t);
  const sign = inverted ? -1 : 1;
  return linear + (cubic - linear) * clamp(intensity, 0, 1) * sign;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPoint(a: [number, number], b: [number, number], t: number): [number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

function haversineKilometers(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const lat1 = a[1] * rad;
  const lat2 = b[1] * rad;
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function buildLineFeature(scene: PreparedRoute) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "LineString" as const,
      coordinates: scene.path?.coordinates?.length ? scene.path.coordinates : [scene.from.coords, scene.to.coords]
    },
    properties: {}
  };
}

function buildPointFeature(location: { coords: [number, number] }, kind: string) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "Point" as const,
      coordinates: location.coords
    },
    properties: {
      kind
    }
  };
}

function computeBounds(coordinates: [number, number][]) {
  const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
  for (let index = 1; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index];
    if (coordinate) {
      bounds.extend(coordinate);
    }
  }
  return bounds;
}

function midpoint(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function toAggressivenessControl(aggressiveness = 50): number {
  return lerp(0.02, 1.0, clamp(aggressiveness, 0, 100) / 100);
}

function sampleMirroredBlend(progress: number, aggressiveness = 50): number {
  const t = clamp(progress, 0, 1);
  const control = toAggressivenessControl(aggressiveness);
  return 2 * (1 - t) * t * control + t * t;
}

function normalizeWindowRadius(value: number): number {
  return Math.max(1, Math.round(value));
}

function buildPathSampler(coordinates?: [number, number][]): PathSampler {
  if (!coordinates?.length) {
    return {
      coordinates: [],
      cumulative: [0],
      total: 0
    };
  }

  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    const priorDistance = cumulative[index - 1] ?? 0;
    if (!previous || !current) {
      cumulative.push(priorDistance);
      continue;
    }

    const segmentLength = haversineKilometers(previous, current);
    cumulative.push(priorDistance + segmentLength);
  }

  return {
    coordinates,
    cumulative,
    total: cumulative[cumulative.length - 1] ?? 0
  };
}

function smoothCoordinates(coordinates: [number, number][], passes = 1, radius = 2): [number, number][] {
  if (!coordinates?.length || coordinates.length < 3) {
    return coordinates;
  }

  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (!first || !last) {
    return coordinates;
  }

  const smoothed: [number, number][] = coordinates.map((coordinate) => [...coordinate]);
  const windowRadius = normalizeWindowRadius(radius);

  for (let pass = 0; pass < passes; pass += 1) {
    const next: [number, number][] = smoothed.map((coordinate) => [...coordinate]);
    for (let index = 1; index < smoothed.length - 1; index += 1) {
      let lngSum = 0;
      let latSum = 0;
      let weightSum = 0;

      for (
        let neighbor = Math.max(0, index - windowRadius);
        neighbor <= Math.min(smoothed.length - 1, index + windowRadius);
        neighbor += 1
      ) {
        const distanceFromCenter = Math.abs(neighbor - index);
        const weight = windowRadius + 1 - distanceFromCenter;
        const neighborCoordinate = smoothed[neighbor];
        if (!neighborCoordinate) {
          continue;
        }

        lngSum += neighborCoordinate[0] * weight;
        latSum += neighborCoordinate[1] * weight;
        weightSum += weight;
      }

      next[index] = [lngSum / weightSum, latSum / weightSum];
    }

    next[0] = [...first];
    next[next.length - 1] = [...last];

    for (let index = 0; index < smoothed.length; index += 1) {
      const nextCoordinate = next[index];
      if (nextCoordinate) {
        smoothed[index] = nextCoordinate;
      }
    }
  }

  return smoothed;
}

function buildCameraPathSampler(coordinates: [number, number][], smoothing = 0.9): PathSampler {
  const routePath = buildPathSampler(coordinates);
  if (routePath.coordinates.length < 3 || routePath.total === 0) {
    return routePath;
  }

  const normalizedSmoothing = clamp(smoothing, 0, 1);
  const sampleCount = Math.round(clamp(24 + routePath.total * 4, 32, 120));
  const resampled: [number, number][] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = sampleCount === 1 ? 1 : index / (sampleCount - 1);
    resampled.push(samplePath(routePath, progress));
  }

  const passes = Math.round(lerp(1, 10, normalizedSmoothing));
  const radius = lerp(1, 5, normalizedSmoothing);
  return buildPathSampler(smoothCoordinates(resampled, passes, radius));
}

function findSegmentIndex(path: PathSampler, target: number): number {
  let low = 1;
  let high = path.cumulative.length - 1;

  while (low < high) {
    const mid = low + ((high - low) >> 1);
    const segmentEnd = path.cumulative[mid] ?? Number.POSITIVE_INFINITY;
    if (target <= segmentEnd) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
}

function samplePath(path: PathSampler, progress: number): [number, number] {
  const firstCoordinate = path.coordinates[0];
  if (!firstCoordinate) {
    return [0, 0];
  }

  if (path.coordinates.length === 1 || path.total === 0) {
    return firstCoordinate;
  }

  const target = path.total * clamp(progress, 0, 1);
  const index = findSegmentIndex(path, target);
  const segmentEnd = path.cumulative[index];
  const segmentStart = path.cumulative[index - 1];
  const from = path.coordinates[index - 1];
  const to = path.coordinates[index];

  if (segmentEnd !== undefined && segmentStart !== undefined && from && to) {
    const segmentLength = segmentEnd - segmentStart || 1;
    const segmentProgress = (target - segmentStart) / segmentLength;
    return lerpPoint(from, to, segmentProgress);
  }

  return path.coordinates[path.coordinates.length - 1] ?? firstCoordinate;
}

function clipCoordinatesToProgress(path: PathSampler, progress: number): [number, number][] {
  const firstCoordinate = path.coordinates[0];
  if (!firstCoordinate || path.coordinates.length < 2 || path.total === 0) {
    return path.coordinates.length ? [...path.coordinates] : [];
  }

  if (progress <= 0) return [firstCoordinate];
  if (progress >= 1) return [...path.coordinates];

  const target = path.total * progress;
  const index = findSegmentIndex(path, target);
  const segmentEnd = path.cumulative[index];
  const segmentStart = path.cumulative[index - 1];
  const from = path.coordinates[index - 1];
  const to = path.coordinates[index];

  if (segmentEnd !== undefined && segmentStart !== undefined && from && to) {
    const segmentLength = segmentEnd - segmentStart || 1;
    const segmentProgress = (target - segmentStart) / segmentLength;
    const clipped = path.coordinates.slice(0, index);
    clipped.push(lerpPoint(from, to, segmentProgress));
    return clipped;
  }

  return [...path.coordinates];
}

function waitForMapEvent(eventName: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const map = requireMap();
    let settled = false;
    let timeoutId = 0;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      map.off(eventName, onEvent);
      resolve(result);
    };

    const onEvent = () => {
      finish(true);
    };

    map.on(eventName, onEvent);
    timeoutId = window.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

// Wait until every tile in view has loaded (or errored), re-checking
// periodically because an "idle" event can fire between checks and be missed.
async function waitForIdle(timeoutMs = 10000): Promise<void> {
  const map = requireMap();
  const deadline = performance.now() + timeoutMs;

  while (!(map.loaded() && map.areTilesLoaded())) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      break;
    }

    await waitForMapEvent("idle", Math.min(remaining, 1000));
  }

  await sleep(120);
}

async function waitForStyleLoad(timeoutMs = 2500): Promise<void> {
  const map = requireMap();
  if (map.isStyleLoaded()) {
    return;
  }

  const loaded = await waitForMapEvent("style.load", timeoutMs);
  if (!loaded && !map.isStyleLoaded()) {
    throw new Error("Timed out waiting for the map style to load");
  }
}

async function ensureRouteLayers(): Promise<void> {
  await waitForStyleLoad();
  const map = requireMap();

  if (!map.getSource("route")) {
    map.addSource("route", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: []
      }
    });
  }

  if (!map.getLayer("route-shadow")) {
    map.addLayer({
      id: "route-shadow",
      type: "line",
      source: "route",
      filter: ["==", "$type", "LineString"],
      paint: {
        "line-color": "rgba(9, 35, 58, 0.25)",
        "line-width": 14,
        "line-blur": 1
      }
    });
  }

  if (!map.getLayer("route-line")) {
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      filter: ["==", "$type", "LineString"],
      paint: {
        "line-color": "#0f9f8f",
        "line-width": 8
      }
    });
  }

  if (!map.getLayer("route-points")) {
    map.addLayer({
      id: "route-points",
      type: "circle",
      source: "route",
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-radius": 8,
        "circle-color": [
          "match",
          ["get", "kind"],
          "end",
          "#0f9f8f",
          "#152634"
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3
      }
    });
  }
}

async function setupMap(): Promise<void> {
  if (state.map) {
    return;
  }

  await ensureTileCacheReady();

  state.map = new maplibregl.Map({
    container: "map",
    style: buildBaseStyle("satellite"),
    center: [144.9631, -37.8136],
    zoom: 13,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    pitch: 0,
    bearing: 0,
    canvasContextAttributes: {
      preserveDrawingBuffer: true
    }
  });

  await waitForMapEvent("load");
  await ensureRouteLayers();
  state.mapType = "satellite";

  await waitForIdle();
}

function removeMarkers(): void {
  for (const marker of state.markers) {
    marker.remove();
  }

  state.markers = [];
  removeAvatarMarker();
}

function removeAvatarMarker(): void {
  if (state.avatarMarker) {
    state.avatarMarker.remove();
    state.avatarMarker = null;
  }
}

function avatarBorderRadius(shape: string): string {
  if (shape === "square") return "0";
  if (shape === "rounded") return "22%";
  return "50%";
}

function createAvatarMarkerElement(
  avatarUrl: string,
  scale: number,
  borderWidth: number,
  borderColor: string,
  bgColor: string,
  shape: string
): HTMLDivElement {
  const size = Math.round(40 * scale);
  const container = document.createElement("div");
  container.className = "avatar-marker";
  container.style.width = `${size}px`;
  container.style.height = `${size}px`;
  container.style.border = `${borderWidth}px solid ${borderColor}`;
  container.style.borderRadius = avatarBorderRadius(shape);
  container.style.background = bgColor || "transparent";

  const img = document.createElement("img");
  img.src = avatarUrl;
  img.alt = "Avatar";
  img.draggable = false;
  container.appendChild(img);

  return container;
}

async function setScene(scene: PreparedRoute): Promise<void> {
  await setupMap();
  const map = requireMap();
  const targetMapType = scene.mapType ?? "satellite";
  if (targetMapType !== state.mapType) {
    map.setStyle(buildBaseStyle(targetMapType));
    state.mapType = targetMapType;
  }
  await ensureRouteLayers();
  map.resize();
  removeMarkers();
  state.scene = scene;

  const routeSource = getRouteSource(map);
  const clippedStart = scene.path?.coordinates?.[0];
  const lineFeature = (scene.camera.clipPath && clippedStart)
    ? { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: [clippedStart, clippedStart] }, properties: {} }
    : buildLineFeature(scene);
  routeSource.setData({
    type: "FeatureCollection",
    features: [
      lineFeature,
      buildPointFeature(scene.from, "start"),
      buildPointFeature(scene.to, "end")
    ]
  });

  const camera = scene.camera;
  const startZoom = camera.startZoom ?? scene.startZoom ?? 15.8;
  const endZoom = camera.endZoom ?? scene.endZoom ?? startZoom;
  const routeCoordinates =
    scene.path?.coordinates?.length >= 2 ? scene.path.coordinates : [scene.from.coords, scene.to.coords];
  const bounds = computeBounds(routeCoordinates);
  const canvas = map.getCanvas();
  const maxPadding = Math.max(24, Math.floor(Math.min(canvas.width || 0, canvas.height || 0) / 4) || 24);
  const paddingValue = clamp(Number(scene.overviewPadding ?? 180), 0, maxPadding);
  const overviewCamera = map.cameraForBounds(bounds, {
    padding: {
      top: paddingValue,
      right: paddingValue + 40,
      bottom: paddingValue,
      left: paddingValue + 40
    },
    maxZoom: Math.max(startZoom, endZoom) - 0.8
  });
  const closerZoom = Math.max(startZoom, endZoom);
  const requiredZoomOut = Math.max(0, closerZoom - (overviewCamera?.zoom ?? startZoom - 1.6));
  const maxAltitude = clamp(camera.maxAltitude, 50, 150);

  state.cameras = {
    start: {
      center: scene.from.coords,
      zoom: startZoom
    },
    overview: {
      center: overviewCamera?.center ? toCoordinatePair(overviewCamera.center) : midpoint(scene.from.coords, scene.to.coords),
      zoom: Math.max(2.2, closerZoom - requiredZoomOut * (maxAltitude / 100))
    },
    end: {
      center: scene.to.coords,
      zoom: endZoom
    },
    routePath: buildPathSampler(routeCoordinates),
    cameraPath: buildCameraPathSampler(routeCoordinates, camera.smoothing),
    aggressiveness: clamp(camera.aggressiveness, 0, 100),
    timingCurve: clamp(camera.timingCurve, 0, 100),
    timingInverted: camera.timingInverted,
    clipPath: camera.clipPath ?? false
  };

  state.markers.push(
    new maplibregl.Marker({
      element: createMarker(scene.from.label, "start"),
      anchor: "bottom-left",
      offset: [12, -18]
    })
      .setLngLat(scene.from.coords)
      .addTo(map)
  );

  state.markers.push(
    new maplibregl.Marker({
      element: createMarker(scene.to.label, "end"),
      anchor: "bottom-left",
      offset: [12, -18]
    })
      .setLngLat(scene.to.coords)
      .addTo(map)
  );

  if (scene.avatarUrl && state.cameras) {
    const scale = scene.avatarScale ?? 1;
    const borderWidth = scene.avatarBorderWidth ?? 3;
    const borderColor = scene.avatarBorderColor ?? "#ffffff";
    const bgColor = scene.avatarBgColor ?? "";
    const shape = scene.avatarShape ?? "circle";
    const avatarElement = createAvatarMarkerElement(scene.avatarUrl, scale, borderWidth, borderColor, bgColor, shape);
    const startPosition = samplePath(state.cameras.routePath, 0);
    state.avatarMarker = new maplibregl.Marker({
      element: avatarElement,
      anchor: "center"
    })
      .setLngLat(startPosition)
      .addTo(map);
  }

  map.jumpTo({
    center: scene.from.coords,
    zoom: startZoom,
    bearing: 0,
    pitch: 0
  });

  await waitForIdle();
}

// Prime along the actual animation path so frame capture rarely has to wait.
// renderFrame uses the exact camera math, so the tiles it loads here are the
// tiles each captured frame will need.
async function primeTiles(): Promise<void> {
  const primeSamples = 9;
  for (let index = 0; index < primeSamples; index += 1) {
    await renderFrame(index / (primeSamples - 1));
  }
}

async function renderFrame(progress: number): Promise<void> {
  const map = requireMap();
  const cameras = state.cameras;
  if (!cameras) {
    state.lastProgress = progress;
    return;
  }
  const holdIn = 0.08;
  const holdOut = 0.08;
  const mapped = clamp((progress - holdIn) / (1 - holdIn - holdOut), 0, 1);
  const eased = sampleTimingEasing(mapped, cameras.timingCurve / 100, cameras.timingInverted);
  const pathProgress = 0.5 - 0.5 * Math.cos(eased * Math.PI);
  const pathCenter = samplePath(cameras.cameraPath, pathProgress);

  const halfProgress = 1 - Math.abs(mapped - 0.5) * 2;
  const rawBlend = sampleMirroredBlend(halfProgress, cameras.aggressiveness);
  const taperPower = 2.5;
  const zoomBlend = 1 - Math.pow(1 - rawBlend, taperPower);
  const zoomValue =
    mapped <= 0.5
      ? lerp(cameras.start.zoom, cameras.overview.zoom, zoomBlend)
      : lerp(cameras.overview.zoom, cameras.end.zoom, 1 - zoomBlend);

  map.jumpTo({
    center: pathCenter,
    zoom: zoomValue,
    bearing: 0,
    pitch: 0
  });

  if (state.avatarMarker) {
    const avatarPosition = samplePath(cameras.routePath, pathProgress);
    state.avatarMarker.setLngLat(avatarPosition);
  }

  if (cameras.clipPath && state.scene) {
    const clipProgress = Math.min(1, Math.max(0, (pathProgress - 0.05) / 0.9));
    const clippedCoords = clipCoordinatesToProgress(cameras.routePath, clipProgress);
    const routeSource = getRouteSource(map);
    const features = [];
    if (clippedCoords.length >= 2) {
      features.push({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: clippedCoords
        },
        properties: {}
      });
    }
    features.push(buildPointFeature(state.scene.from, "start"));
    features.push(buildPointFeature(state.scene.to, "end"));
    routeSource.setData({
      type: "FeatureCollection",
      features
    });
  }

  // Never hand a frame back while tiles in view are still loading — captured
  // frames are permanent, so a blank tile here means a blank tile in the MP4.
  if (!map.areTilesLoaded()) {
    await waitForIdle(8000);
  }

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  state.lastProgress = progress;
}

const rendererApi: RendererApi = {
  setScene,
  primeTiles,
  renderFrame
};

function isPostMessageTarget(value: MessageEventSource | null): value is WindowProxy {
  return Boolean(value && "postMessage" in value);
}

async function handleMessage(event: MessageEvent<RendererCommandMessage>): Promise<void> {
  const payload = event.data;
  if (!payload || payload.namespace !== "mapanim") {
    return;
  }

  const { requestId, type } = payload;

  try {
    switch (type) {
      case "set-scene":
        await rendererApi.setScene(payload.scene);
        break;
      case "prime-tiles":
        await rendererApi.primeTiles();
        break;
      case "render-frame":
        await rendererApi.renderFrame(payload.progress ?? state.lastProgress);
        break;
      default:
        throw new Error(`Unknown renderer command "${type}"`);
    }

    const origin = event.origin || "*";
    if (isPostMessageTarget(event.source)) {
      event.source.postMessage(
        {
          namespace: "mapanim",
          type: "command-complete",
          requestId
        },
        origin
      );
    }
  } catch (error) {
    const origin = event.origin || "*";
    if (isPostMessageTarget(event.source)) {
      const message = error instanceof Error ? error.message : String(error);
      event.source.postMessage(
        {
          namespace: "mapanim",
          type: "command-error",
          requestId,
          message
        },
        origin
      );
    }
  }
}

window.addEventListener("message", (event: MessageEvent<RendererCommandMessage>) => {
  void handleMessage(event);
});

window.__MAP_RENDERER__ = rendererApi;
window.__MAP_RENDERER_READY__ = true;

if (window.parent && window.parent !== window) {
  const readyMessage: RendererReadyMessage = {
    namespace: "mapanim",
    type: "ready"
  };
  window.parent.postMessage(
    readyMessage,
    "*"
  );
}
