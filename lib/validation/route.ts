// Request-time validation for route configurations.
//
// The render pipeline feeds these numbers straight into Playwright (viewport
// size) and ffmpeg (fps/duration), so out-of-range values can crash a render or
// exhaust resources. We validate the externally-supplied fields against safe
// bounds before anything is queued, returning a typed 400 with the offending
// field rather than letting a bad value reach the renderer. Validation is
// intentionally lenient: absent optional fields are fine; only present-and-wrong
// values are rejected.

import { isRecord } from "../utils.js";
import type { RouteConfig, LocationSpec, CameraConfig } from "../../types/route.js";

export class RouteValidationError extends Error {
  readonly statusCode = 400;
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(`Invalid route: ${field} ${message}`);
    this.name = "RouteValidationError";
  }
}

const MAX_STRING_LENGTH = 2048;
const MAX_PATH_POINTS = 100_000;

function checkNumberRange(value: unknown, field: string, min: number, max: number, { integer = false } = {}): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RouteValidationError(field, "must be a finite number");
  }
  if (integer && !Number.isInteger(value)) {
    throw new RouteValidationError(field, "must be an integer");
  }
  if (value < min || value > max) {
    throw new RouteValidationError(field, `must be between ${min} and ${max}`);
  }
}

function checkString(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new RouteValidationError(field, "must be a string");
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new RouteValidationError(field, `must be at most ${MAX_STRING_LENGTH} characters`);
  }
}

function checkCoords(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new RouteValidationError(field, "must be a [lng, lat] pair");
  }
  const [lng, lat] = value;
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RouteValidationError(`${field}[0]`, "longitude must be between -180 and 180");
  }
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RouteValidationError(`${field}[1]`, "latitude must be between -90 and 90");
  }
}

function checkLocation(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new RouteValidationError(field, "must be an object");
  }
  checkString(value["label"], `${field}.label`);
  checkString(value["query"], `${field}.query`);
  checkCoords(value["coords"], `${field}.coords`);
}

function checkCamera(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new RouteValidationError("camera", "must be an object");
  }
  const camera = value as CameraConfig;
  checkNumberRange(camera.startZoom, "camera.startZoom", 0, 28);
  checkNumberRange(camera.endZoom, "camera.endZoom", 0, 28);
  checkNumberRange(camera.maxAltitude, "camera.maxAltitude", 0, 1000);
  checkNumberRange(camera.peakAltitude, "camera.peakAltitude", 0, 1000);
  checkNumberRange(camera.aggressiveness, "camera.aggressiveness", 0, 100);
  checkNumberRange(camera.curvePosition, "camera.curvePosition", 0, 100);
  checkNumberRange(camera.smoothing, "camera.smoothing", 0, 1);
  checkNumberRange(camera.cameraSmoothing, "camera.cameraSmoothing", 0, 1);
  checkNumberRange(camera.timingCurve, "camera.timingCurve", 0, 100);
}

function checkPath(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new RouteValidationError("path", "must be an object");
  }
  const coordinates = value["coordinates"];
  if (coordinates === undefined) {
    return;
  }
  if (!Array.isArray(coordinates)) {
    throw new RouteValidationError("path.coordinates", "must be an array");
  }
  if (coordinates.length > MAX_PATH_POINTS) {
    throw new RouteValidationError("path.coordinates", `must have at most ${MAX_PATH_POINTS} points`);
  }
  // Validate each point: the renderer indexes [0]/[1] and does arithmetic on
  // these, so a null/NaN/string/missing element would crash the render pipeline.
  for (let i = 0; i < coordinates.length; i += 1) {
    const point = coordinates[i];
    if (point === undefined) {
      throw new RouteValidationError(`path.coordinates[${i}]`, "must be a [lng, lat] pair");
    }
    checkCoords(point, `path.coordinates[${i}]`);
  }
}

/**
 * Validate and return a route configuration. Throws RouteValidationError (HTTP
 * 400) on the first invalid field.
 */
export function validateRouteConfig(value: unknown): RouteConfig {
  if (!isRecord(value)) {
    throw new RouteValidationError("body", "must be an object");
  }
  const route = value as RouteConfig;

  checkString(route.id, "id");
  checkString(route.name, "name");
  checkString(route.provider, "provider");
  checkString(route.mode, "mode");
  checkString(route.travelMode, "travelMode");
  checkString(route.mapType, "mapType");
  checkString(route.output, "output");

  checkNumberRange(route.width, "width", 16, 7680, { integer: true });
  checkNumberRange(route.height, "height", 16, 7680, { integer: true });
  checkNumberRange(route.fps, "fps", 1, 120, { integer: true });
  checkNumberRange(route.durationSeconds, "durationSeconds", 0.1, 600);
  checkNumberRange(route.overviewPadding, "overviewPadding", 0, 4000);
  checkNumberRange(route.startZoom, "startZoom", 0, 28);
  checkNumberRange(route.endZoom, "endZoom", 0, 28);
  checkNumberRange(route.peakAltitude, "peakAltitude", 0, 1000);
  checkNumberRange(route.curvePosition, "curvePosition", 0, 100);
  checkNumberRange(route.cameraSmoothing, "cameraSmoothing", 0, 1);

  checkLocation(route.start as LocationSpec | undefined, "start");
  checkLocation(route.end as LocationSpec | undefined, "end");
  checkLocation(route.from as LocationSpec | undefined, "from");
  checkLocation(route.to as LocationSpec | undefined, "to");
  checkCamera(route.camera);
  checkPath(route.path);

  return route;
}
