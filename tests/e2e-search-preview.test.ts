// End-to-end tests for the two user-facing flows that depend on the upstream map
// provider: place search and route preview. The real server is started as a child
// process and pointed (via NOMINATIM_URL / OSRM_URL) at a local stub that stands in
// for OSM's geocoder and OSRM's router, so the tests are deterministic and never
// touch the public internet or get rate-limited.

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface StubUpstream {
  baseUrl: string;
  /** Number of requests received, split by kind. */
  counts: { search: number; route: number };
  stop: () => Promise<void>;
}

/** A stand-in for Nominatim (/search) and OSRM (/route/v1/...). */
async function startStubUpstream(options: { status?: number } = {}): Promise<StubUpstream> {
  const counts = { search: 0, route: 0 };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (options.status && options.status !== 200) {
      response.writeHead(options.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "upstream failure" }));
      return;
    }

    if (url.pathname.startsWith("/search")) {
      counts.search += 1;
      const query = url.searchParams.get("q") ?? "";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify([
          { place_id: 42, display_name: `${query} (resolved)`, lon: "144.96", lat: "-37.81", address: { city: "Melbourne" } }
        ])
      );
      return;
    }

    if (url.pathname.startsWith("/route/")) {
      counts.route += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          code: "Ok",
          routes: [
            {
              geometry: { coordinates: [[144.96, -37.81], [144.97, -37.80], [144.98, -37.79]] },
              distance: 1234,
              duration: 567
            }
          ]
        })
      );
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

interface RunningServer {
  base: string;
  stop: () => Promise<void>;
}

async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const port = await getFreePort();
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: rootDir,
    env: {
      ...process.env,
      MAPANIM_SERVE_UI: "0",
      HOST: "127.0.0.1",
      LOG_LEVEL: "silent",
      PORT: String(port),
      ...env
    },
    stdio: ["ignore", "ignore", "inherit"]
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("server did not become healthy in time");
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      })
  };
}

test("search returns geocoded results from the upstream", async () => {
  const upstream = await startStubUpstream();
  const server = await startServer({ NOMINATIM_URL: upstream.baseUrl, OSRM_URL: upstream.baseUrl });
  try {
    const res = await fetch(`${server.base}/api/search?q=melbourne`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: Array<{ label: string; coords: [number, number] }> };
    assert.equal(body.results.length, 1);
    assert.match(body.results[0]!.label, /melbourne \(resolved\)/);
    assert.deepEqual(body.results[0]!.coords, [144.96, -37.81]);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test("repeated identical searches hit the upstream only once (server cache)", async () => {
  const upstream = await startStubUpstream();
  const server = await startServer({ NOMINATIM_URL: upstream.baseUrl, OSRM_URL: upstream.baseUrl });
  try {
    await fetch(`${server.base}/api/search?q=cached-place`);
    await fetch(`${server.base}/api/search?q=cached-place`);
    await fetch(`${server.base}/api/search?q=cached-place`);
    assert.equal(upstream.counts.search, 1, "the cache absorbed the repeat searches");
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test("preview resolves both endpoints and routes between them", async () => {
  const upstream = await startStubUpstream();
  const server = await startServer({ NOMINATIM_URL: upstream.baseUrl, OSRM_URL: upstream.baseUrl });
  try {
    const res = await fetch(`${server.base}/api/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: { start: { query: "from place" }, end: { query: "to place" }, mode: "walking" } })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      route: {
        start: { coords: [number, number] };
        end: { coords: [number, number] };
        path: { coordinates: [number, number][]; distanceMeters: number };
      };
    };
    // Both endpoints were geocoded...
    assert.deepEqual(body.route.start.coords, [144.96, -37.81]);
    assert.deepEqual(body.route.end.coords, [144.96, -37.81]);
    // ...and a routed path with distance came back from the router.
    assert.ok(body.route.path.coordinates.length >= 2);
    assert.equal(body.route.path.distanceMeters, 1234);
    assert.equal(upstream.counts.route, 1);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test("preview with explicit coords and a path needs no upstream calls", async () => {
  const upstream = await startStubUpstream();
  const server = await startServer({ NOMINATIM_URL: upstream.baseUrl, OSRM_URL: upstream.baseUrl });
  try {
    const res = await fetch(`${server.base}/api/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: {
          start: { query: "a", coords: [144.9, -37.8] },
          end: { query: "b", coords: [145.0, -37.7] },
          path: { coordinates: [[144.9, -37.8], [145.0, -37.7]] }
        }
      })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { route: { path: { coordinates: [number, number][] } } };
    assert.deepEqual(body.route.path.coordinates, [[144.9, -37.8], [145.0, -37.7]]);
    assert.equal(upstream.counts.search, 0, "coords provided, so no geocoding");
    assert.equal(upstream.counts.route, 0, "path provided, so no routing");
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test("an upstream 429 surfaces as a retryable 503 with a clear message, not a 500", async () => {
  const upstream = await startStubUpstream({ status: 429 });
  const server = await startServer({ NOMINATIM_URL: upstream.baseUrl, OSRM_URL: upstream.baseUrl });
  try {
    const res = await fetch(`${server.base}/api/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: { start: { query: "x" }, end: { query: "y" }, mode: "walking" } })
    });
    assert.equal(res.status, 503);
    assert.ok(res.headers.get("retry-after"), "advertises a back-off period");
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /rate-limit/i);
    assert.doesNotMatch(body.error, /internal server error/i);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test("an upstream outage surfaces as a 502", async () => {
  const upstream = await startStubUpstream({ status: 500 });
  const server = await startServer({ NOMINATIM_URL: upstream.baseUrl, OSRM_URL: upstream.baseUrl });
  try {
    const res = await fetch(`${server.base}/api/search?q=anything`);
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /temporarily unavailable/i);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});
