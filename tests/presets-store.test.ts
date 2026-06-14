import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPresetStore } from "../lib/presets/store.js";
import type { PresetDetail } from "../types/index.js";

async function makeRoot(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapanim-presets-store-"));
  await fs.writeFile(path.join(rootDir, "routes.json"), JSON.stringify({ routes: [] }), "utf8");
  return rootDir;
}

test("normal preset id round-trips through save and get", async () => {
  const rootDir = await makeRoot();
  const store = createPresetStore({ rootDir });

  const saved: PresetDetail = await store.save({
    name: "Mountain Run",
    route: {
      id: "mountain-run",
      start: { label: "A", query: "A" },
      end: { label: "B", query: "B" },
      camera: { peakAltitude: 50 }
    }
  });

  assert.equal(saved.id, "preset:mountain-run");

  const loaded: PresetDetail = await store.get("preset:mountain-run");
  assert.equal(loaded.route.id, "mountain-run");
  assert.equal(loaded.route.camera!.peakAltitude, 50);

  // File lives inside the presets directory.
  const onDisk = await fs.readFile(path.join(rootDir, "presets", "mountain-run.json"), "utf8");
  assert.ok(onDisk.includes("mountain-run"));
});

test("get() rejects a ../ traversal id and does not read outside the dir", async () => {
  const rootDir = await makeRoot();
  const store = createPresetStore({ rootDir });

  // Plant a target file outside the presets dir that a traversal would hit.
  const secretPath = path.join(rootDir, "secret.json");
  await fs.writeFile(secretPath, JSON.stringify({ id: "secret", name: "secret" }), "utf8");

  await assert.rejects(
    () => store.get("preset:../secret"),
    /Invalid preset id/
  );

  // Deeper traversal attempts are also rejected.
  await assert.rejects(
    () => store.get("preset:../../etc/something"),
    /Invalid preset id/
  );
});

test("save() rejects a ../ traversal id and does not write outside the dir", async () => {
  const rootDir = await makeRoot();
  const store = createPresetStore({ rootDir });

  await assert.rejects(
    () =>
      store.save({
        name: "evil",
        route: {
          id: "../escaped",
          start: { label: "A", query: "A" },
          end: { label: "B", query: "B" }
        }
      }),
    /Invalid preset id/
  );

  // Nothing was written outside the presets directory.
  await assert.rejects(() => fs.stat(path.join(rootDir, "escaped.json")));
});

test("ids containing path separators are rejected", async () => {
  const rootDir = await makeRoot();
  const store = createPresetStore({ rootDir });

  for (const badId of ["foo/bar", "foo\\bar", "..", ".", "/abs", "a/../b"]) {
    await assert.rejects(
      () => store.get(`preset:${badId}`),
      /Invalid preset id/,
      `expected get to reject id "${badId}"`
    );
    await assert.rejects(
      () =>
        store.save({
          name: "x",
          route: {
            id: badId,
            start: { label: "A", query: "A" },
            end: { label: "B", query: "B" }
          }
        }),
      /Invalid preset id/,
      `expected save to reject id "${badId}"`
    );
  }
});
