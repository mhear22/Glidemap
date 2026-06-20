import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProviderRegistry } from "../lib/providers/index.js";

// Spin up a stub that speaks just enough of the Nominatim search API to let us
// count how many requests actually reach the upstream provider.
async function withStubNominatim(
  run: (baseUrl: string, counter: { count: number }) => Promise<void>
): Promise<void> {
  const counter = { count: 0 };
  const server = http.createServer((request, response) => {
    counter.count += 1;
    const url = new URL(request.url ?? "/", "http://localhost");
    const query = url.searchParams.get("q") ?? "";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify([
        { place_id: 1, display_name: `Result for ${query}`, lon: "1.5", lat: "2.5", address: { city: "Test" } }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`, counter);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("registry caches repeated searches, hitting the upstream once", async () => {
  await withStubNominatim(async (baseUrl, counter) => {
    const registry = createProviderRegistry({
      nominatimUrl: baseUrl,
      searchCache: { maxEntries: 100, ttlMs: 60_000 }
    });
    const provider = registry.getProvider();

    const first = await provider.search("melbourne");
    const second = await provider.search("melbourne");

    assert.equal(counter.count, 1, "second identical search is served from cache");
    assert.deepEqual(first, second);

    const stats = registry.searchCacheStats?.();
    assert.ok(stats);
    assert.equal(stats?.hits, 1);
    assert.equal(stats?.misses, 1);
    assert.equal(stats?.size, 1);
  });
});

test("registry normalises queries so casing and surrounding space share an entry", async () => {
  await withStubNominatim(async (baseUrl, counter) => {
    const registry = createProviderRegistry({
      nominatimUrl: baseUrl,
      searchCache: { maxEntries: 100, ttlMs: 60_000 }
    });
    const provider = registry.getProvider();

    await provider.search("Melbourne");
    await provider.search("  melbourne  ");

    assert.equal(counter.count, 1);
  });
});

test("geocode reuses the cached search result", async () => {
  await withStubNominatim(async (baseUrl, counter) => {
    const registry = createProviderRegistry({
      nominatimUrl: baseUrl,
      searchCache: { maxEntries: 100, ttlMs: 60_000 }
    });
    const provider = registry.getProvider();

    await provider.geocode("paris");
    const result = await provider.geocode("paris");

    assert.equal(counter.count, 1, "geocode is built on the cached search");
    assert.equal(result.coords[0], 1.5);
    assert.equal(result.coords[1], 2.5);
  });
});

test("different limits are cached independently", async () => {
  await withStubNominatim(async (baseUrl, counter) => {
    const registry = createProviderRegistry({
      nominatimUrl: baseUrl,
      searchCache: { maxEntries: 100, ttlMs: 60_000 }
    });
    const provider = registry.getProvider();

    await provider.search("rome", { limit: 5 });
    await provider.search("rome", { limit: 1 });

    assert.equal(counter.count, 2, "a different limit is a distinct upstream query");
  });
});

test("registry without a cache hits the upstream every time and reports no stats", async () => {
  await withStubNominatim(async (baseUrl, counter) => {
    const registry = createProviderRegistry({ nominatimUrl: baseUrl });
    const provider = registry.getProvider();

    await provider.search("oslo");
    await provider.search("oslo");

    assert.equal(counter.count, 2);
    assert.equal(registry.searchCacheStats?.(), null);
  });
});

test("a zero-size cache config disables caching", async () => {
  await withStubNominatim(async (baseUrl, counter) => {
    const registry = createProviderRegistry({
      nominatimUrl: baseUrl,
      searchCache: { maxEntries: 0, ttlMs: 60_000 }
    });
    const provider = registry.getProvider();

    await provider.search("berlin");
    await provider.search("berlin");

    assert.equal(counter.count, 2);
    assert.equal(registry.searchCacheStats?.(), null);
  });
});
