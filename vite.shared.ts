import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type UserConfigExport } from "vite";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version?: string };
const appVersion = packageJson.version ?? "0.0.0";

interface FrontendViteConfigOptions {
  root: string;
  defaultPort: number;
  portEnv: string;
}

export function createFrontendViteConfig(options: FrontendViteConfigOptions): UserConfigExport {
  const { root, defaultPort, portEnv } = options;
  const apiPort = process.env["MAPANIM_API_PORT"] ?? "4822";
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const port = Number(process.env[portEnv] ?? defaultPort);

  return defineConfig({
    plugins: [vue()],
    root,
    define: {
      __APP_VERSION__: JSON.stringify(appVersion)
    },
    // Each app needs its own dep-optimizer cache: sharing node_modules/.vite
    // makes the two dev servers invalidate each other's pre-bundled deps,
    // which 504s ("Outdated Optimize Dep") and leaves a blank page.
    cacheDir: path.join(repoRoot, "node_modules", `.vite-${root}`),
    server: {
      port,
      strictPort: true,
      proxy: {
        "/api": apiBaseUrl,
        "/render": apiBaseUrl,
        "/output": apiBaseUrl,
        "/tiles": apiBaseUrl,
        "/tile-cache-sw.js": apiBaseUrl,
        "/node_modules/maplibre-gl": apiBaseUrl
      }
    },
    build: {
      outDir: "dist",
      emptyOutDir: true
    }
  });
}
