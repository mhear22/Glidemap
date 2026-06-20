# Glidemap

Render map videos from a root-level route JSON, or use the local webapp to search locations, tune the camera curve, preview the route, save presets, and queue MP4 exports.

The product name lives in [branding.ts](./branding.ts) — change it there and every user-facing surface (header, landing page, help, admin, titles, server logs) follows. The static `<title>` tags in `webapp/index.html`, `adminapp/index.html`, and `web/index.html` are pre-JS fallbacks that need a manual update on rename. Internal identifiers (docker image names, the `mapanim` postMessage namespace, service-worker cache name, localStorage keys) deliberately keep the old name so running installs don't break.

## Setup

```bash
npm install
npm run install:browsers
```

## Run The Apps

```bash
npm run dev
```

This starts three development processes:

- main app at [http://127.0.0.1:5173](http://127.0.0.1:5173)
- admin app at [http://127.0.0.1:5174](http://127.0.0.1:5174)
- shared backend API/render server at [http://127.0.0.1:4822](http://127.0.0.1:4822)

Both frontends proxy `/api`, `/render`, `/output`, `/tiles`, and related asset requests back to that shared backend.

If you want to run just the packaged local server, use:

```bash
npm run build:webapp
npm run build:admin
npm run serve
```

That serves the built main app on [http://127.0.0.1:5173](http://127.0.0.1:5173) and the built admin app on [http://127.0.0.1:5174](http://127.0.0.1:5174).

## Configuration

All runtime configuration is read from the environment once at startup and validated (the
process exits with a clear message on bad input). See [lib/config.ts](./lib/config.ts).

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` in containers. |
| `PORT` | `5173` (UI) / `4822` (API) | Main frontend port, or API port when UI hosting is off. |
| `MAPANIM_MAIN_PORT` | `5173` | Main frontend port (when `PORT` is unset). |
| `MAPANIM_ADMIN_PORT` | `5174` | Admin frontend port. Must differ from the main port. |
| `MAPANIM_API_PORT` | `4822` | Backend-only API port (when `PORT` is unset). |
| `MAPANIM_SERVE_UI` | `1` | Set `0` to run the backend API/render process only. |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | `debug`, `info`, `warn`, `error`, or `silent`. |
| `MAPANIM_MAX_BODY_BYTES` | `1048576` | Hard cap on request body size (DoS protection). |
| `MAPANIM_REQUEST_TIMEOUT_MS` | `30000` | Per-request receive timeout (`0` disables). |
| `MAPANIM_RATE_MAX` / `MAPANIM_RATE_WINDOW_MS` | `240` / `60000` | Default per-IP rate limit for `/api/*`. |
| `MAPANIM_SEARCH_RATE_MAX` / `MAPANIM_SEARCH_RATE_WINDOW_MS` | `30` / `60000` | Tighter limit for the upstream-hitting `/api/search`. |
| `MAPANIM_SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period for in-flight requests to drain on `SIGTERM`/`SIGINT`. |
| `MAPANIM_API_SECRET` | _(unset)_ | When set (min 16 chars), `/api/*` requires `Authorization: Bearer <secret>`. Health/readiness/metrics stay open. |
| `MAPANIM_TRUST_PROXY` | `0` | Trust `X-Forwarded-For` for client identity (rate limiting, metrics). Enable only behind a known proxy. |
| `MAPANIM_CORS_ORIGINS` | _(empty)_ | Comma-separated allowed origins, or `*`. Empty disables CORS (same-origin only). |
| `MAPANIM_CSP` | `1` | Emit the Content-Security-Policy header. Disable if a fronting proxy sets its own. |
| `NOMINATIM_URL` | OSM public server | Geocoding (search) provider base URL. |
| `OSRM_URL` | OSRM demo server | Routing provider base URL. |
| `MAPANIM_SEARCH_CACHE_MAX` | `500` | Max distinct geocoding queries cached in memory (`0` disables the cache). |
| `MAPANIM_SEARCH_CACHE_TTL_MS` | `3600000` | How long a cached search result stays fresh (`0` disables the cache). |

Logs are emitted as structured JSON lines (one object per line) with a per-request `requestId`,
so they drop straight into a log aggregator. The server honours an inbound `X-Request-Id`
header (sanitised and length-capped) for cross-service tracing and echoes the id back on the
response, minting a fresh one when the caller doesn't supply a valid one.

## Operational endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` (alias `/healthz`) | Liveness — always `200` while the process is up. Returns name, version, uptime. |
| `GET /api/ready` (alias `/readyz`) | Readiness — `200` once the render origin is wired up, `503` while starting or shutting down. |
| `GET /metrics` | Prometheus exposition (request rate/latency/errors, render queue depth, search-cache hits/misses/size). |
| `GET /api/metrics` | Visitor/search/cache counters for the last 24h (JSON, for the admin UI). |

Operational endpoints bypass rate limiting and auth so orchestrators and Prometheus scrapers
are never throttled or blocked; protect `/metrics` at the network layer if it must stay private.
Request validation rejects out-of-range render parameters (dimensions, fps, duration, zoom,
coordinates) with `400` before a job is queued.

Responses carry a baseline set of security headers (CSP tuned for MapLibre, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) and rate-limit headers
(`X-RateLimit-Limit`/`-Remaining`/`-Reset`). On `SIGTERM`/`SIGINT` the server stops accepting new
connections, drains in-flight requests, releases SSE streams, and exits within the shutdown timeout.

Geocoding searches are cached in a bounded, in-memory TTL cache (single-flight, so a
burst of identical queries makes one upstream call). This shields the upstream provider
— the public OSM Nominatim server requires callers to cache results — and cuts tail
latency. Tune or disable it with `MAPANIM_SEARCH_CACHE_MAX` / `MAPANIM_SEARCH_CACHE_TTL_MS`.

The app includes:

- place search backed by the default OSM provider
- live route preview via the existing MapLibre render surface
- a simplified half-curve editor for zoom aggressiveness plus exact controls for `startZoom`, `endZoom`, and `maxAltitude`
- exact numeric controls for `durationSeconds` and `smoothing`
- preset save/load from `presets/`
- sequential render queue with live progress updates
- a separate admin page for queue, preset, and output monitoring

## Render Everything

```bash
./render-all.sh
```

This reads [routes.json](./routes.json) and writes every configured video to `output/`.

## Render a one-off route

```bash
npm run render:route -- \
  --from "Melbourne Convention and Exhibition Centre, South Wharf VIC 3006, Australia" \
  --to "Melbourne CBD VIC 3000, Australia" \
  --mapType satellite \
  --mode walking \
  --cameraSmoothing 0.92 \
  --out output/custom.mp4
```

## Route JSON

Each route supports:

- `start` / `end`: each accepts `label`, `query`, and optional `coords`
- `mapType`: `satellite` or `standard`
- `mode`: `walking`, `driving`, `flying`, or `public transport`
- `path.coordinates`: optional explicit routed line as `[[lng, lat], ...]`
- `output`: output video path
- `width`, `height`, `fps`, `durationSeconds`, `overviewPadding`
- optional `camera` object:

```json
{
  "camera": {
    "startZoom": 15.8,
    "endZoom": 15.8,
    "maxAltitude": 100,
    "aggressiveness": 50,
    "smoothing": 0.92
  }
}
```

The older top-level `startZoom`, `endZoom`, and `cameraSmoothing` fields still work for CLI compatibility.

`public transport` is accepted in the JSON schema, but you need to provide `path.coordinates` for it because this project does not have a built-in transit router.

`smoothing` affects only the camera path, not the displayed route line. Higher values produce a much calmer glide through bends.

`maxAltitude` is a percentage from `50` to `150`. `100` is the baseline that zooms out far enough to see both endpoints.

`aggressiveness` controls how quickly the move opens up from the start toward that midpoint framing. The second half mirrors the first.

`flying` generates a curved flight path automatically, which is useful for long airport-to-airport moves.

## Releasing

Releases are driven by the `release` branch and [.github/workflows/release.yml](./.github/workflows/release.yml):

1. Bump the version in [VERSION](./VERSION).
2. Push (or merge) to the `release` branch.

The workflow builds the Docker image (the image build runs the test suite), pushes it to `ghcr.io/<owner>/glidemap` tagged `v<version>`, `sha-<commit>`, and `latest`, then creates a `v<version>` git tag and GitHub release. It refuses to run if the version tag already exists, so every release requires a version bump. The default `GITHUB_TOKEN` is enough for same-repo ghcr pushes; make sure the repository's Actions settings allow read/write workflow permissions.

The version lives in `VERSION` rather than `package.json` so that `package.json`'s bytes stay stable across releases — that keeps the Docker deps layer (`npm ci` + the Chromium install) a build-cache hit, so only the tests and frontend builds re-run per release.

The app displays its version (from `VERSION`, injected at build time) in the studio's info dropdown.

## Container

The repo now includes a root `Dockerfile` that works with Docker or Podman because it uses a standard OCI image layout. It installs Chromium for Playwright, `ffmpeg` for encoding, runs the test suite during the image build, builds both Vue frontends, and starts the packaged server on ports `5173` and `5174`.

If you want to run the app with Compose, use [docker-compose.yml](./docker-compose.yml).

Start it with:

```bash
mkdir -p output presets .tile-cache
podman compose up --build
```

Then open:

- [http://127.0.0.1:5173](http://127.0.0.1:5173) for the main app
- [http://127.0.0.1:5174](http://127.0.0.1:5174) for the admin app

If you prefer Docker, the equivalent command is:

```bash
docker compose up --build
```

Stop it with:

```bash
podman compose down
```

Build and run the container locally:

```bash
npm run docker
```

This builds a local `mapanim:local` image, creates `output/` and `presets/` if needed, and runs the container with ports `5173` and `5174` exposed plus the project `routes.json` mounted in.

Then open:

- [http://127.0.0.1:5173](http://127.0.0.1:5173)
- [http://127.0.0.1:5174](http://127.0.0.1:5174)

Build and push the image to ECR with the current git commit hash as the tag:

```bash
npm run docker:deploy
```

This requires the AWS CLI plus either Docker or Podman, and assumes you have permission to push to `115136208505.dkr.ecr.ap-southeast-2.amazonaws.com/mapanim`.

Notes:

- `--ipc=host` is recommended for Chromium stability in containers.
- The `:Z` suffix is useful on SELinux-enabled Podman hosts.
- Mounting `output/`, `presets/`, `.tile-cache`, and `routes.json` keeps your renders, cached tiles, and local data outside the container image.
- You can still run the split workflow manually with `npm run dev:server`, `npm run dev:webapp`, and `npm run dev:admin`.
