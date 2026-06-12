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
