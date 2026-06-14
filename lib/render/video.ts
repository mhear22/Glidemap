import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { prepareRoute } from "../routes.js";
import { ensureDir, sleep } from "../utils.js";
import type { RouteConfig, PreparedRoute, RenderProgress, RenderResult } from "../../types/index.js";
import type { ProviderRegistry, RendererWindow } from "../../types/index.js";

interface RenderRouteToVideoOptions {
  rootDir: string;
  renderBaseUrl: string;
  providerRegistry?: ProviderRegistry;
  onProgress?: (progress: Partial<RenderProgress>) => void;
  signal?: AbortSignal;
}

async function ensureOutputDir(rootDir: string, filePath: string): Promise<void> {
  await ensureDir(path.dirname(path.resolve(rootDir, filePath)));
}

// Reuse one warm Chromium across render jobs (the queue runs them serially);
// cold-launching the browser per job is one of the most expensive steps.
let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  sharedBrowser = await chromium.launch();
  return sharedBrowser;
}

/** Close the warm browser (called on graceful shutdown). */
export async function closeRenderBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowser = null;
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}

export async function renderRouteToVideo(
  routeConfig: RouteConfig,
  options: RenderRouteToVideoOptions
): Promise<RenderResult> {
  const {
    rootDir,
    renderBaseUrl,
    providerRegistry,
    onProgress,
    signal
  } = options;

  function checkAborted(): void {
    if (signal?.aborted) {
      throw new DOMException("Render cancelled", "AbortError");
    }
  }

  onProgress?.({ stage: "preparing" });
  const route = await prepareRoute(
    routeConfig,
    providerRegistry ? { providerRegistry } : {}
  );

  let page: Page | undefined;
  let ffmpegProcess: ChildProcess | undefined;
  let ffmpegExited = false;

  try {
    const browser = await getBrowser();
    page = await browser.newPage({
      viewport: {
        width: Number(route.width ?? 1920),
        height: Number(route.height ?? 1080)
      },
      deviceScaleFactor: 1
    });

    page.on("pageerror", (error: Error) => {
      console.error("Page error:", error);
    });

    await page.goto(renderBaseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const rendererWindow = window as Window & RendererWindow;
      return Boolean(rendererWindow.__MAP_RENDERER_READY__);
    });

    onProgress?.({ stage: "priming_tiles" });
    checkAborted();
    await page.evaluate(async (scene: PreparedRoute) => {
      const rendererWindow = window as Window & RendererWindow;
      const renderer = rendererWindow.__MAP_RENDERER__;
      if (!renderer) {
        throw new Error("Renderer API is unavailable");
      }

      await renderer.setScene(scene);
      await renderer.primeTiles();
    }, route);

    const fps = Number(route.fps ?? 30);
    const durationSeconds = Number(route.durationSeconds ?? 8);
    const totalFrames = Math.max(2, Math.round(fps * durationSeconds));

    const output = `output/${crypto.randomUUID()}.mp4`;
    route.output = output;
    await ensureOutputDir(rootDir, output);
    const outputPath = path.resolve(rootDir, output);

    const ffmpegArgs = [
      "-y",
      "-f", "image2pipe",
      "-framerate", String(fps),
      "-i", "pipe:0",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath
    ];

    ffmpegProcess = spawn("ffmpeg", ffmpegArgs, { cwd: rootDir });
    const activeFfmpegProcess = ffmpegProcess;
    const ffmpegStdin = activeFfmpegProcess.stdin!;
    ffmpegStdin.on("error", () => {});
    activeFfmpegProcess.stdout!.on("data", () => {});
    // Capture the tail of ffmpeg stderr so a failure surfaces a real reason
    // (codec/arg/pipe error) instead of just a bare exit code.
    const ffmpegErrChunks: string[] = [];
    activeFfmpegProcess.stderr!.on("data", (chunk: Buffer) => {
      ffmpegErrChunks.push(chunk.toString());
      if (ffmpegErrChunks.length > 60) ffmpegErrChunks.splice(0, ffmpegErrChunks.length - 60);
    });
    const ffmpegErrorDetail = (): string => {
      const tail = ffmpegErrChunks.join("").trim().split("\n").slice(-8).join("\n");
      return tail ? `:\n${tail}` : "";
    };

    let ffmpegExitCode: number | null = null;

    activeFfmpegProcess.on("exit", (code: number | null) => {
      ffmpegExitCode = code;
      ffmpegExited = true;
    });

    onProgress?.({ stage: "capturing_frames", percent: 0 });

    for (let frame = 0; frame < totalFrames; frame += 1) {
      checkAborted();
      const progress = totalFrames === 1 ? 1 : frame / (totalFrames - 1);
      await page.evaluate(async (value: number) => {
        const rendererWindow = window as Window & RendererWindow;
        const renderer = rendererWindow.__MAP_RENDERER__;
        if (!renderer) {
          throw new Error("Renderer API is unavailable");
        }

        await renderer.renderFrame(value);
      }, progress);

      const buffer = await page.screenshot({ type: "jpeg", quality: 92 });

      if (ffmpegExited) {
        throw new Error(`ffmpeg exited prematurely with code ${ffmpegExitCode}${ffmpegErrorDetail()}`);
      }

      const drained = ffmpegStdin.write(buffer);
      if (!drained) {
        await new Promise<void>((resolve) => {
          const onDrain = () => { cleanup(); resolve(); };
          const onExit = () => { cleanup(); resolve(); };
          const cleanup = () => {
            ffmpegStdin.removeListener("drain", onDrain);
            activeFfmpegProcess.removeListener("exit", onExit);
          };
          ffmpegStdin.once("drain", onDrain);
          activeFfmpegProcess.once("exit", onExit);
        });
      }

      onProgress?.({
        stage: "capturing_frames",
        frame: frame + 1,
        totalFrames,
        percent: ((frame + 1) / totalFrames) * 100
      });
    }

    onProgress?.({ stage: "encoding_video", percent: 0 });
    checkAborted();
    ffmpegStdin.end();

    await new Promise<void>((resolve, reject) => {
      if (ffmpegExited) {
        if (ffmpegExitCode === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${ffmpegExitCode}${ffmpegErrorDetail()}`));
        }
        return;
      }

      activeFfmpegProcess.on("exit", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}${ffmpegErrorDetail()}`));
        }
      });

      activeFfmpegProcess.on("error", reject);
    });

    onProgress?.({
      stage: "completed",
      percent: 100
    });

    return {
      outputPath,
      route
    };
  } finally {
    if (signal?.aborted && ffmpegProcess && !ffmpegExited) {
      ffmpegProcess.kill("SIGKILL");
    }

    // Close the page but keep the browser warm for the next job.
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }

    await sleep(150);
  }
}
