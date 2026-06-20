import test from "node:test";
import assert from "node:assert/strict";
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

test("drain cancels queued jobs and aborts the running job", async () => {
  let abortObserved = false;
  const queue = createRenderQueue({
    worker: (payload, _emit, signal) =>
      new Promise<RenderResult>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          reject(new DOMException("Render cancelled", "AbortError"));
        });
        // Never resolves on its own; only abort ends it.
        void payload;
      })
  });

  queue.enqueue({ route: { id: "running" } });
  queue.enqueue({ route: { id: "waiting" } });

  // Let the first job start.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const result = queue.drain();
  assert.equal(result.running.length, 1);
  assert.equal(result.queued.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(abortObserved, true);

  const statuses = queue.list().map((job) => job.status);
  // The queued job is cancelled; the running job ends cancelled via abort.
  assert.ok(statuses.every((status) => status === "cancelled"));
});
