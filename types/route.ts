export interface LocationSpec {
  label?: string;
  query?: string;
  coords?: [number, number];
}

export interface CameraConfig {
  startZoom?: number;
  endZoom?: number;
  maxAltitude?: number;
  peakAltitude?: number;
  aggressiveness?: number;
  curvePosition?: number;
  smoothing?: number;
  cameraSmoothing?: number;
  timingCurve?: number;
  timingInverted?: boolean;
  clipPath?: boolean;
}

export interface NormalizedCamera {
  startZoom: number;
  endZoom: number;
  maxAltitude: number;
  aggressiveness: number;
  smoothing: number;
  timingCurve: number;
  timingInverted: boolean;
  clipPath: boolean;
}

export interface RoutedPath {
  coordinates: [number, number][];
  distanceMeters: number | null;
  durationSeconds: number | null;
  profile: string;
}

export interface RouteConfig {
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
  format?: "mp4" | "webm";
  overviewPadding?: number;
  output?: string;
  start?: LocationSpec;
  end?: LocationSpec;
  from?: LocationSpec;
  to?: LocationSpec;
  path?: Partial<RoutedPath>;
  camera?: CameraConfig;
  startZoom?: number;
  endZoom?: number;
  peakAltitude?: number;
  curvePosition?: number;
  cameraSmoothing?: number;
  avatarUrl?: string;
  avatarScale?: number;
  avatarBorderWidth?: number;
  avatarBorderColor?: string;
  avatarBgColor?: string;
  avatarShape?: "circle" | "square" | "rounded";
}

export interface PreparedRoute extends RouteConfig {
  id: string;
  provider: string;
  mode: string;
  travelMode: string;
  mapType: string;
  camera: NormalizedCamera;
  start: ResolvedLocation;
  end: ResolvedLocation;
  from: ResolvedLocation;
  to: ResolvedLocation;
  path: RoutedPath;
}

export interface ResolvedLocation {
  label: string;
  query: string;
  coords: [number, number];
}
