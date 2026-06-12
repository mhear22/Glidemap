import vue from "@vitejs/plugin-vue";
import { defineConfig, type UserConfigExport } from "vite";

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
