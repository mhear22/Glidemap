import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TRACK_POINTS, parseTrack } from "../lib/parse-track.js";

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Morning glide</name>
    <trkseg>
      <trkpt lat="-37.6700" lon="144.8400"><ele>120</ele></trkpt>
      <trkpt lat="-37.6500" lon="144.8600"><ele>180</ele></trkpt>
      <trkpt lon="144.8800" lat="-37.6300"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const SAMPLE_GPX_NAMESPACED = `<?xml version="1.0"?>
<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1">
  <gpx:trk><gpx:trkseg>
    <gpx:trkpt lat="1.0" lon="2.0"/>
    <gpx:trkpt lat="3.0" lon="4.0"/>
  </gpx:trkseg></gpx:trk>
</gpx:gpx>`;

const SAMPLE_GPX_RTEPT_FALLBACK = `<gpx version="1.1">
  <rte>
    <rtept lat="10.5" lon="20.5"></rtept>
    <rtept lat="11.5" lon="21.5"></rtept>
  </rte>
</gpx>`;

const SAMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <LineString>
        <coordinates>
          144.8400,-37.6700,120
          144.8600,-37.6500,180
          144.8800,-37.6300,0
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;

test("parseTrack reads GPX trkpt points in [lng, lat] order", () => {
  const result = parseTrack(SAMPLE_GPX);

  assert.equal(result.coordinates.length, 3);
  assert.deepEqual(result.coordinates[0], [144.84, -37.67]);
  assert.deepEqual(result.coordinates[1], [144.86, -37.65]);
  assert.deepEqual(result.coordinates[2], [144.88, -37.63]);
  assert.equal(result.profile, "track");
  assert.equal(result.durationSeconds, null);
  assert.ok(result.distanceMeters !== null && result.distanceMeters > 0);
});

test("parseTrack is namespace/prefix tolerant for GPX", () => {
  const result = parseTrack(SAMPLE_GPX_NAMESPACED);

  assert.equal(result.coordinates.length, 2);
  assert.deepEqual(result.coordinates[0], [2, 1]);
  assert.deepEqual(result.coordinates[1], [4, 3]);
});

test("parseTrack falls back to rtept when there are no trkpt elements", () => {
  const result = parseTrack(SAMPLE_GPX_RTEPT_FALLBACK);

  assert.equal(result.coordinates.length, 2);
  assert.deepEqual(result.coordinates[0], [20.5, 10.5]);
  assert.deepEqual(result.coordinates[1], [21.5, 11.5]);
});

test("parseTrack reads KML coordinates in [lng, lat] order and drops altitude", () => {
  const result = parseTrack(SAMPLE_KML);

  assert.equal(result.coordinates.length, 3);
  assert.deepEqual(result.coordinates[0], [144.84, -37.67]);
  assert.deepEqual(result.coordinates[1], [144.86, -37.65]);
  assert.deepEqual(result.coordinates[2], [144.88, -37.63]);
  assert.equal(result.profile, "track");
});

test("parseTrack downsamples deterministically while keeping endpoints", () => {
  const count = MAX_TRACK_POINTS * 2 + 7;
  const trkpts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const lng = (i * 0.0001).toFixed(4);
    const lat = (10 + i * 0.0001).toFixed(4);
    trkpts.push(`<trkpt lat="${lat}" lon="${lng}"/>`);
  }
  const gpx = `<gpx><trk><trkseg>${trkpts.join("")}</trkseg></trk></gpx>`;

  const first = parseTrack(gpx);
  const second = parseTrack(gpx);

  assert.equal(first.coordinates.length, MAX_TRACK_POINTS);
  assert.deepEqual(first.coordinates[0], [0, 10]);
  assert.deepEqual(first.coordinates[first.coordinates.length - 1], [
    Number(((count - 1) * 0.0001).toFixed(4)),
    Number((10 + (count - 1) * 0.0001).toFixed(4))
  ]);
  // Deterministic: identical input yields identical output.
  assert.deepEqual(first.coordinates, second.coordinates);
});

test("parseTrack throws on empty input", () => {
  assert.throws(() => parseTrack(""), /empty/i);
  assert.throws(() => parseTrack("   \n  "), /empty/i);
});

test("parseTrack throws on unrecognised input", () => {
  assert.throws(() => parseTrack("not xml at all, just text"), /Unrecognised track format/i);
});

test("parseTrack throws when a GPX/KML document has no usable points", () => {
  assert.throws(
    () => parseTrack(`<gpx version="1.1"><trk><trkseg></trkseg></trk></gpx>`),
    /No track points found/i
  );
  assert.throws(
    () => parseTrack(`<kml><Document><Placemark></Placemark></Document></kml>`),
    /Unrecognised track format|No track points found/i
  );
});
