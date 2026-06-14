import type {
  CameraConfig,
  LocationSpec,
  PreparedRoute,
  PresetDetail,
  PresetItem,
  PreviewResponse,
  ProviderSearchResult,
  RenderJobCreateResponse,
  RenderJobsResponse,
  RouteConfig,
  SearchResponse,
  SerializedJob
} from "../../types/index.js";

export type {
  CameraConfig,
  LocationSpec,
  PreparedRoute,
  PresetDetail,
  PresetItem,
  PreviewResponse,
  ProviderSearchResult,
  RenderJobCreateResponse,
  RenderJobsResponse,
  RouteConfig,
  SearchResponse,
  SerializedJob
}

export type SearchKind = "start" | "end";

export interface FormLocation {
  label: string;
  query: string;
  coords: [number, number] | null;
}

export interface FormCamera {
  startZoom: number;
  endZoom: number;
  maxAltitude: number;
  aggressiveness: number;
  smoothing: number;
  timingCurve: number;
  timingInverted: boolean;
  clipPath: boolean;
}

export interface RouteFormData {
  id: string;
  name: string;
  provider: string;
  mode: string;
  mapType: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  format: "mp4" | "webm";
  overviewPadding: number;
  output: string;
  start: FormLocation;
  end: FormLocation;
  path: RouteConfig["path"] | null;
  camera: FormCamera;
  avatarUrl?: string;
  avatarScale?: number;
  avatarBorderWidth?: number;
  avatarBorderColor?: string;
  avatarBgColor?: string;
  avatarShape?: "circle" | "square" | "rounded";
}

export interface RouteApplyInput {
  id?: string;
  name?: string;
  provider?: string;
  mode?: string;
  travelMode?: string;
  mapType?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  overviewPadding?: number;
  output?: string;
  path?: RouteConfig["path"] | null;
  start?: Partial<FormLocation> | LocationSpec;
  end?: Partial<FormLocation> | LocationSpec;
  from?: Partial<FormLocation> | LocationSpec;
  to?: Partial<FormLocation> | LocationSpec;
  camera?: Partial<FormCamera & CameraConfig>;
  avatarUrl?: string;
  avatarScale?: number;
  avatarBorderWidth?: number;
  avatarBorderColor?: string;
  avatarBgColor?: string;
  avatarShape?: "circle" | "square" | "rounded";
}

export interface SearchState {
  startResults: ProviderSearchResult[];
  endResults: ProviderSearchResult[];
  startLoading: boolean;
  endLoading: boolean;
}

export interface PreviewRouteLike {
  width?: number;
  height?: number;
  overviewPadding?: number;
  path?: PreparedRoute["path"];
  from?: Pick<PreparedRoute["from"], "coords">;
  to?: Pick<PreparedRoute["to"], "coords">;
}
