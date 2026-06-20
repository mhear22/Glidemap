import { EventEmitter } from "node:events";
import type { RenderJob, RenderProgress, RenderResult } from "../../types/index.js";
import type { RouteConfig } from "../../types/index.js";

type WorkerCallback = (
  payload: { route: RouteConfig },
  emitProgress: (progress: Partial<RenderProgress>) => void,
  signal: AbortSignal
) => Promise<RenderResult>;

type JobsListener = (jobs: RenderJob[]) => void;

interface DrainResult {
  /** Ids of jobs that were running and have been signalled to abort. */
  running: string[];
  /** Ids of queued jobs that were cancelled before they could start. */
  queued: string[];
}

interface RenderQueue {
  list(): RenderJob[];
  enqueue(payload: { route: RouteConfig }): RenderJob;
  cancel(jobId: string): boolean;
  subscribe(listener: JobsListener): () => void;
  /** Cancel queued jobs and abort any running job. Used during shutdown. */
  drain(): DrainResult;
}

class CancelledError extends Error {
  constructor() {
    super("Render cancelled");
    this.name = "CancelledError";
  }
}

function isCancelledError(error: unknown): boolean {
  return error instanceof CancelledError || (error instanceof DOMException && error.name === "AbortError");
}

export function createRenderQueue({ worker }: { worker: WorkerCallback }): RenderQueue {
  const emitter = new EventEmitter();
  const jobs: RenderJob[] = [];
  const controllers = new Map<string, AbortController>();
  let running = false;
  let draining = false;

  function broadcast(): void {
    emitter.emit("jobs", jobs.map((job) => ({ ...job })));
  }

  async function pump(): Promise<void> {
    if (running || draining) {
      return;
    }

    const nextJob = jobs.find((job) => job.status === "queued");
    if (!nextJob) {
      return;
    }

    running = true;
    nextJob.status = "running";
    nextJob.stage = "preparing";
    nextJob.updatedAt = new Date().toISOString();
    broadcast();

    const controller = controllers.get(nextJob.id);

    try {
      const result = await worker(nextJob.payload, (progress) => {
        nextJob.stage = progress.stage ?? nextJob.stage;
        nextJob.progress = {
          ...nextJob.progress,
          ...progress
        };
        nextJob.updatedAt = new Date().toISOString();
        broadcast();
      }, controller?.signal ?? new AbortController().signal);
      nextJob.status = "completed";
      nextJob.stage = "completed";
      nextJob.result = result;
      nextJob.updatedAt = new Date().toISOString();
      broadcast();
    } catch (error) {
      if (isCancelledError(error)) {
        nextJob.status = "cancelled";
        nextJob.stage = "cancelled";
      } else {
        nextJob.status = "failed";
        nextJob.stage = "failed";
        nextJob.error = (error as Error).message;
      }
      nextJob.updatedAt = new Date().toISOString();
      broadcast();
    } finally {
      controllers.delete(nextJob.id);
      running = false;
      await pump();
    }
  }

  return {
    list(): RenderJob[] {
      return jobs.map((job) => ({ ...job }));
    },

    enqueue(payload: { route: RouteConfig }): RenderJob {
      const controller = new AbortController();
      const job: RenderJob = {
        id: `job-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        payload,
        status: "queued",
        stage: "queued",
        progress: {
          stage: "queued",
          percent: 0
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      controllers.set(job.id, controller);
      jobs.unshift(job);
      broadcast();
      void pump();
      return { ...job };
    },

    cancel(jobId: string): boolean {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        return false;
      }

      if (job.status !== "queued" && job.status !== "running") {
        return false;
      }

      job.status = "cancelled";
      job.stage = "cancelled";
      job.updatedAt = new Date().toISOString();

      const controller = controllers.get(jobId);
      if (controller) {
        controller.abort();
      }

      broadcast();
      return true;
    },

    subscribe(listener: JobsListener): () => void {
      emitter.on("jobs", listener);
      return () => emitter.off("jobs", listener);
    },

    drain(): DrainResult {
      draining = true;
      const result: DrainResult = { running: [], queued: [] };
      const now = new Date().toISOString();

      for (const job of jobs) {
        if (job.status === "queued") {
          job.status = "cancelled";
          job.stage = "cancelled";
          job.updatedAt = now;
          result.queued.push(job.id);
        } else if (job.status === "running") {
          result.running.push(job.id);
          controllers.get(job.id)?.abort();
        }
      }

      if (result.queued.length > 0 || result.running.length > 0) {
        broadcast();
      }
      return result;
    }
  };
}
