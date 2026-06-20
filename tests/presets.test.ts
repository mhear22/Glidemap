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

test("preset store sanitizes ids on save so they stay inside the presets dir", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapanim-presets-"));
  await fs.writeFile(path.join(rootDir, "routes.json"), JSON.stringify({ routes: [] }), "utf8");
  const store = createPresetStore({ rootDir });

  const saved = await store.save({
    route: {
      id: "../../escape",
      start: { label: "A", query: "A" },
      end: { label: "B", query: "B" }
    }
  });

  // The slugified id must be a safe slug with no traversal characters.
  assert.equal(saved.id, "preset:escape");
  assert.match(saved.id, /^preset:[a-z0-9-]+$/);

  // And nothing escaped the presets directory.
  const entries = await fs.readdir(path.join(rootDir, "presets"));
  for (const entry of entries) {
    assert.doesNotMatch(entry, /\.\./);
  }
});
