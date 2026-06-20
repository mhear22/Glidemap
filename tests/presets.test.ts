import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPresetStore } from "../lib/presets/store.js";
import type { PresetDetail, PresetItem } from "../types/index.js";

test("preset store saves, lists, and reloads presets", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapanim-presets-"));
  await fs.writeFile(path.join(rootDir, "routes.json"), JSON.stringify({ routes: [] }), "utf8");
  const store = createPresetStore({ rootDir });

  const saved: PresetDetail = await store.save({
    name: "Airport Hop",
    route: {
      id: "airport-hop",
      start: { label: "A", query: "A" },
      end: { label: "B", query: "B" },
      camera: { peakAltitude: 72 }
    }
  });

  assert.equal(saved.id, "preset:airport-hop");

  const listed: PresetItem[] = await store.list();
  const [firstPreset] = listed;
  assert.equal(listed.length, 1);
  assert.ok(firstPreset);
  assert.equal(firstPreset.name, "Airport Hop");

  const loaded: PresetDetail = await store.get("preset:airport-hop");
  assert.equal(loaded.route.camera!.peakAltitude, 72);
});

test("preset store rejects path traversal in get", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapanim-presets-"));
  // Plant a secret one level above the presets directory.
  await fs.writeFile(path.join(rootDir, "secret.json"), JSON.stringify({ id: "secret" }), "utf8");
  const store = createPresetStore({ rootDir });

  await assert.rejects(() => store.get("preset:../secret"), /Invalid preset id/);
  await assert.rejects(() => store.get("preset:..%2f..%2fsecret"), /Invalid preset id/);
});

test("preset store rejects an explicit traversal id on save", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapanim-presets-"));
  await fs.writeFile(path.join(rootDir, "routes.json"), JSON.stringify({ routes: [] }), "utf8");
  const store = createPresetStore({ rootDir });

  // An explicit, malformed route id is rejected rather than silently rewritten.
  await assert.rejects(
    () => store.save({ route: { id: "../../escape", start: { label: "A", query: "A" }, end: { label: "B", query: "B" } } }),
    /Invalid preset id/
  );
});

test("preset store derives a safe slug id when none is supplied", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapanim-presets-"));
  await fs.writeFile(path.join(rootDir, "routes.json"), JSON.stringify({ routes: [] }), "utf8");
  const store = createPresetStore({ rootDir });

  // No id provided: it's derived from the name and slugified into a safe slug.
  const saved = await store.save({
    name: "City / Loop!!",
    route: { start: { label: "A", query: "A" }, end: { label: "B", query: "B" } }
  });
  assert.match(saved.id, /^preset:[a-z0-9-]+$/);

  // And nothing escaped the presets directory.
  const entries = await fs.readdir(path.join(rootDir, "presets"));
  for (const entry of entries) {
    assert.doesNotMatch(entry, /\.\./);
  }
});
