import test from "node:test";
import assert from "node:assert/strict";
import { validateRouteConfig, RouteValidationError } from "../lib/validation/route.js";

test("accepts a well-formed route config and returns it", () => {
  const route = {
    id: "trip",
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 12,
    start: { label: "A", query: "A", coords: [144.96, -37.81] },
    end: { label: "B", query: "B", coords: [145.0, -37.8] },
    camera: { startZoom: 15, endZoom: 16, smoothing: 0.9, aggressiveness: 50 }
  };
  assert.equal(validateRouteConfig(route), route);
});

test("accepts an essentially empty route (all fields optional)", () => {
  assert.doesNotThrow(() => validateRouteConfig({}));
});

test("rejects a non-object body", () => {
  assert.throws(() => validateRouteConfig(null), RouteValidationError);
  assert.throws(() => validateRouteConfig([1, 2]), RouteValidationError);
});

test("rejects out-of-range dimensions, fps, and duration", () => {
  assert.throws(() => validateRouteConfig({ width: 99999 }), /width/);
  assert.throws(() => validateRouteConfig({ height: 0 }), /height/);
  assert.throws(() => validateRouteConfig({ fps: 1000 }), /fps/);
  assert.throws(() => validateRouteConfig({ fps: 30.5 }), /fps/);
  assert.throws(() => validateRouteConfig({ durationSeconds: 100000 }), /durationSeconds/);
});

test("rejects non-finite numbers", () => {
  assert.throws(() => validateRouteConfig({ width: Number.NaN }), /width/);
  assert.throws(() => validateRouteConfig({ fps: Number.POSITIVE_INFINITY }), /fps/);
});

test("validates coordinate bounds", () => {
  assert.throws(() => validateRouteConfig({ start: { coords: [200, 0] } }), /longitude/);
  assert.throws(() => validateRouteConfig({ start: { coords: [0, 200] } }), /latitude/);
  assert.throws(() => validateRouteConfig({ start: { coords: [0] } }), /lng, lat/);
  assert.doesNotThrow(() => validateRouteConfig({ start: { coords: [180, -90] } }));
});

test("validates nested camera ranges", () => {
  assert.throws(() => validateRouteConfig({ camera: { startZoom: 99 } }), /camera.startZoom/);
  assert.throws(() => validateRouteConfig({ camera: { smoothing: 5 } }), /camera.smoothing/);
});

test("rejects overly long strings and oversized path arrays", () => {
  assert.throws(() => validateRouteConfig({ name: "x".repeat(5000) }), /name/);
  assert.throws(() => validateRouteConfig({ path: { coordinates: new Array(200001).fill([0, 0]) } }), /path.coordinates/);
});

test("validates the contents of path.coordinates, not just the array shape", () => {
  assert.doesNotThrow(() => validateRouteConfig({ path: { coordinates: [[144.9, -37.8], [145, -37.7]] } }));
  assert.throws(() => validateRouteConfig({ path: { coordinates: [null] } }), /path.coordinates\[0\]/);
  assert.throws(() => validateRouteConfig({ path: { coordinates: ["nope"] } }), /path.coordinates\[0\]/);
  assert.throws(() => validateRouteConfig({ path: { coordinates: [[Number.NaN, 0]] } }), /longitude/);
  assert.throws(() => validateRouteConfig({ path: { coordinates: [[0, 200]] } }), /latitude/);
  assert.throws(() => validateRouteConfig({ path: { coordinates: [[1, 2, 3]] } }), /path.coordinates\[0\]/);
});

test("RouteValidationError carries a 400 status and field", () => {
  try {
    validateRouteConfig({ fps: -1 });
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof RouteValidationError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.field, "fps");
  }
});
