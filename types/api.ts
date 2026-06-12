import type { ProviderSearchResult } from "./provider.js";
import type { RouteConfig, PreparedRoute } from "./route.js";
import type { SerializedJob } from "./render.js";

export type PresetSource = "preset" | "route";

export interface SearchResponse {
  results: ProviderSearchResult[];
}

export interface PreviewResponse {
  route: PreparedRoute;
}

export interface PresetItem {
  id: string;
  source: PresetSource;
  name: string;
  updatedAt: string | null;
}

export interface PresetListResponse {
  presets: PresetItem[];
}

export interface PresetDetail {
  id: string;
  source: PresetSource;
  name: string;
  route: RouteConfig;
}

export interface PresetSaveRequest {
  name?: string;
  route: RouteConfig;
}

export interface RenderJobsResponse {
  jobs: SerializedJob[];
}

export interface RenderJobCreateResponse {
  job: SerializedJob;
}

export interface MetricsBucket {
  time: string;
  visitors: number;
  searches: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface MetricsResponse {
  buckets: MetricsBucket[];
  summary: {
    visitors: number;
    searches: number;
    cacheHits: number;
    cacheMisses: number;
    hitRate: number;
  };
}
