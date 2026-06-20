import fs from "node:fs/promises";
import path from "node:path";
import { isRecord, readJson, slugify, writeJson } from "../utils.js";
import type { RouteConfig } from "../../types/index.js";
import type { PresetItem, PresetDetail, PresetSaveRequest } from "../../types/api.js";

interface FilePresetItem extends PresetItem {
  filePath: string;
  updatedAt: string;
}

interface RoutesConfigFile {
  routes: RouteConfig[];
}

// Preset ids become filenames, so they must never contain path separators or
// traversal sequences. The charset is a no-op for normal slugs (from slugify)
// and uuids, but rejects anything that could escape the presets directory.
const SAFE_PRESET_ID = /^[a-z0-9][a-z0-9-_]*$/i;

export class InvalidPresetIdError extends Error {
  readonly statusCode = 400;
  constructor(id: string) {
    super(`Invalid preset id "${id}"`);
    this.name = "InvalidPresetIdError";
  }
}

// Reject ids with path separators or traversal sequences, then enforce the safe
// charset. Returns legitimate ids unchanged so existing presets still load.
function sanitizePresetId(rawId: string): string {
  const id = String(rawId);
  if (
    id.length === 0 ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0") ||
    id === "." ||
    id === ".." ||
    id.includes("..") ||
    !SAFE_PRESET_ID.test(id)
  ) {
    throw new InvalidPresetIdError(rawId);
  }
  return id;
}

export function createPresetStore({ rootDir }: { rootDir: string }) {
  const presetsDir = path.join(rootDir, "presets");
  const resolvedPresetsDir = path.resolve(presetsDir);
  const routesConfigPath = path.join(rootDir, "routes.json");

  // Defense-in-depth: build the preset file path from a sanitized id and verify
  // the resolved path stays inside the presets directory.
  function presetFilePath(rawId: string): string {
    const safeId = sanitizePresetId(rawId);
    const filePath = path.join(presetsDir, `${safeId}.json`);
    const resolved = path.resolve(filePath);
    if (resolved !== resolvedPresetsDir && !resolved.startsWith(resolvedPresetsDir + path.sep)) {
      throw new InvalidPresetIdError(rawId);
    }
    return filePath;
  }

  async function listFilePresets(): Promise<FilePresetItem[]> {
    await fs.mkdir(presetsDir, { recursive: true });
    const entries = await fs.readdir(presetsDir, { withFileTypes: true });
    const items: FilePresetItem[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(presetsDir, entry.name);
      const data = await readJson<unknown>(filePath);
      const presetData = isRecord(data) ? data : {};
      const fileId = typeof presetData["id"] === "string" ? presetData["id"] : undefined;
      const fileName = typeof presetData["name"] === "string" ? presetData["name"] : undefined;
      items.push({
        id: `preset:${fileId ?? entry.name.replace(/\.json$/, "")}`,
        source: "preset",
        name: fileName ?? fileId ?? entry.name.replace(/\.json$/, ""),
        filePath,
        updatedAt: (await fs.stat(filePath)).mtime.toISOString()
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function listRouteConfigPresets(): Promise<PresetItem[]> {
    try {
      const parsed = await readJson<RoutesConfigFile>(routesConfigPath);
      return (parsed.routes ?? []).map((route) => ({
        id: `route:${route.id}`,
        source: "route",
        name: route.name ?? route.id ?? "Unnamed",
        updatedAt: null
      }));
    } catch {
      return [];
    }
  }

  return {
    async list(): Promise<PresetItem[]> {
      const [filePresets, routePresets] = await Promise.all([listFilePresets(), listRouteConfigPresets()]);
      return [...routePresets, ...filePresets];
    },

    async get(id: string): Promise<PresetDetail> {
      const [source, rawId] = String(id).split(":");
      if (!rawId) {
        throw new Error(`Malformed preset id "${id}"`);
      }

      if (source === "route") {
        const parsed = await readJson<RoutesConfigFile>(routesConfigPath);
        const match = (parsed.routes ?? []).find((route) => route.id === rawId);
        if (!match) {
          throw new Error(`Unknown route preset "${id}"`);
        }

        return {
          id,
          source,
          name: match.name ?? match.id ?? "Unnamed",
          route: match
        };
      }

      if (source !== "preset") {
        throw new Error(`Unknown preset source "${source}"`);
      }

      const filePath = presetFilePath(rawId);
      const route = await readJson<RouteConfig>(filePath);
      return {
        id,
        source,
        name: route.name ?? route.id ?? rawId,
        route
      };
    },

    async save({ name, route }: PresetSaveRequest): Promise<PresetDetail> {
      // An explicit route.id is validated strictly (a bad one is rejected, not
      // silently rewritten); a missing id is derived from the name and slugified
      // into a safe filename. Both then pass the containment check.
      const id = sanitizePresetId(route.id || slugify(name || `${route.start?.label ?? "route"}-preset`));
      const filePath = presetFilePath(id);
      const payload: RouteConfig & { id: string; name: string } = {
        ...route,
        id,
        name: name ?? route.name ?? id
      };
      await writeJson(filePath, payload);

      return {
        id: `preset:${id}`,
        source: "preset",
        name: payload.name,
        route: payload
      };
    }
  };
}
