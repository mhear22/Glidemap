import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRenderQueue } from "../lib/render/queue.js";
import type { RenderResult } from "../types/index.js";

test("render queue processes jobs sequentially", async () => {
  const order: string[] = [];
  const queue = createRenderQueue({
    worker: async (payload, emit) => {
      order.push(`start:${payload.route.id}`);
      emit({ stage: "capturing_frames", frame: 1, totalFrames: 2, percent: 50 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${payload.route.id}`);
      const result: RenderResult = {
        outputPath: `/tmp/${payload.route.id}.mp4`,
        route: { id: payload.route.id } as RenderResult["route"]
      };
      return result;
    }
  });

  queue.enqueue({ route: { id: "one" } });
  queue.enqueue({ route: { id: "two" } });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
  const jobs = queue.list();
  const [firstJob, secondJob] = jobs;
  assert.ok(firstJob);
  assert.ok(secondJob);
  assert.equal(firstJob.status, "completed");
  assert.equal(secondJob.status, "completed");
});

const fakeResult = { outputPath: "", route: {} } as unknown as RenderResult;

test("render queue reloads persisted jobs and fails interrupted running jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glidemap-queue-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(
    file,
    JSON.stringify([
      { id: "a", payload: { route: {} }, status: "running", stage: "capturing_frames", progress: null, createdAt: "t0", updatedAt: "t0" },
      { id: "b", payload: { route: {} }, status: "completed", stage: "completed", progress: null, createdAt: "t0", updatedAt: "t0", result: { outputPath: "/out/x.mp4" } }
    ])
  );

  const queue = createRenderQueue({ worker: async () => fakeResult, persistPath: file });
  const jobs = queue.list();

  assert.equal(jobs.length, 2);
  const a = jobs.find((job) => job.id === "a");
  assert.ok(a, "running job survives reload");
  assert.equal(a.status, "failed");
  assert.match(a.error ?? "", /restart/i);

  const b = jobs.find((job) => job.id === "b");
  assert.ok(b);
  assert.equal(b.status, "completed");
});

test("render queue without a persistPath starts empty and ignores missing state", () => {
  const queue = createRenderQueue({ worker: async () => fakeResult });
  assert.equal(queue.list().length, 0);

  const missing = createRenderQueue({
    worker: async () => fakeResult,
    persistPath: path.join(os.tmpdir(), "glidemap-missing-xyz-12345.json")
  });
  assert.equal(missing.list().length, 0);
});
