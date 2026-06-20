import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
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

interface RunningServer {
  port: number;
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
  // Poll readiness until the listener is accepting connections.
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        break;
      }
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
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        // Backstop in case graceful shutdown wedges.
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      })
  };
}

test("server health, readiness, security headers and 404s", async () => {
  const server = await startServer({});
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { status: string; version: string };
    assert.equal(healthBody.status, "ok");
    assert.ok(healthBody.version);

    // Security headers and request id on every response.
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.ok(health.headers.get("content-security-policy"));
    assert.ok(health.headers.get("x-request-id"));

    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);

    const notFound = await fetch(`${base}/api/does-not-exist`);
    assert.equal(notFound.status, 404);
    const notFoundBody = (await notFound.json()) as { error: string };
    assert.equal(notFoundBody.error, "Not found");

    // Rate-limit headers present on a real API response.
    const jobs = await fetch(`${base}/api/render-jobs`);
    assert.equal(jobs.status, 200);
    assert.ok(jobs.headers.get("x-ratelimit-limit"));

    // Input validation: out-of-range fps is rejected with 400.
    const badRoute = await fetch(`${base}/api/render-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: { fps: 100000 } })
    });
    assert.equal(badRoute.status, 400);

    // Malformed JSON is a client error (400), not a 500.
    const badJson = await fetch(`${base}/api/render-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json"
    });
    assert.equal(badJson.status, 400);

    // Over-long search query rejected.
    const longQuery = await fetch(`${base}/api/search?q=${"a".repeat(300)}`);
    assert.equal(longQuery.status, 400);

    // Prometheus exposition endpoint.
    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    const metricsText = await metrics.text();
    assert.match(metricsText, /glidemap_http_requests_total/);
    assert.match(metricsText, /glidemap_render_queue_depth/);
  } finally {
    await server.stop();
  }
});

test("server enforces bearer auth when a secret is configured", async () => {
  const secret = "integration-test-secret-0001";
  const server = await startServer({ MAPANIM_API_SECRET: secret });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // Health stays open for orchestrators.
    assert.equal((await fetch(`${base}/api/health`)).status, 200);

    // Unauthenticated API access is rejected.
    const noAuth = await fetch(`${base}/api/render-jobs`);
    assert.equal(noAuth.status, 401);
    assert.ok(noAuth.headers.get("www-authenticate"));

    // Wrong token rejected.
    const wrong = await fetch(`${base}/api/render-jobs`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);

    // Correct token accepted.
    const ok = await fetch(`${base}/api/render-jobs`, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(ok.status, 200);
  } finally {
    await server.stop();
  }
});

test("server applies CORS when origins are configured", async () => {
  const server = await startServer({ MAPANIM_CORS_ORIGINS: "https://app.example" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const allowed = await fetch(`${base}/api/render-jobs`, { headers: { Origin: "https://app.example" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example");

    // Preflight is answered with 204 and the allow headers.
    const preflight = await fetch(`${base}/api/render-jobs`, {
      method: "OPTIONS",
      headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example");

    // A disallowed origin gets no CORS header.
    const disallowed = await fetch(`${base}/api/render-jobs`, { headers: { Origin: "https://evil.example" } });
    assert.equal(disallowed.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.stop();
  }
});

test("server rejects oversized request bodies with 413", async () => {
  const server = await startServer({ MAPANIM_MAX_BODY_BYTES: "1024" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const huge = JSON.stringify({ route: { id: "x", note: "y".repeat(4096) } });
    const res = await fetch(`${base}/api/render-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: huge
    });
    assert.equal(res.status, 413);
  } finally {
    await server.stop();
  }
});

test("server enforces rate limits with 429 and Retry-After", async () => {
  const server = await startServer({ MAPANIM_RATE_MAX: "2" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${base}/api/render-jobs`);
      statuses.push(res.status);
      if (res.status === 429) {
        assert.ok(res.headers.get("retry-after"));
      }
    }
    // First two allowed, then throttled.
    assert.deepEqual(statuses.slice(0, 2), [200, 200]);
    assert.ok(statuses.includes(429));
  } finally {
    await server.stop();
  }
});
