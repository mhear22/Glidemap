import test from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../lib/cache/ttl-cache.js";

function fixedClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    }
  };
}

test("ttl cache validates options", () => {
  assert.throws(() => createTtlCache<number>({ maxEntries: 0, ttlMs: 1000 }), /maxEntries/);
  assert.throws(() => createTtlCache<number>({ maxEntries: 1.5, ttlMs: 1000 }), /maxEntries/);
  assert.throws(() => createTtlCache<number>({ maxEntries: 10, ttlMs: 0 }), /ttlMs/);
});

test("stores and returns values, tracking hits and misses", () => {
  const cache = createTtlCache<string>({ maxEntries: 10, ttlMs: 1000 });
  assert.equal(cache.get("a"), undefined);
  cache.set("a", "alpha");
  assert.equal(cache.get("a"), "alpha");
  assert.equal(cache.get("a"), "alpha");

  const stats = cache.stats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 1);
  assert.equal(stats.size, 1);
  assert.equal(stats.maxEntries, 10);
});

test("expires entries after the ttl elapses", () => {
  const clock = fixedClock();
  const cache = createTtlCache<string>({ maxEntries: 10, ttlMs: 1000, now: clock.now });
  cache.set("a", "alpha");

  clock.advance(999);
  assert.equal(cache.get("a"), "alpha");

  clock.advance(2);
  assert.equal(cache.get("a"), undefined, "entry is a miss once past its ttl");
});

test("evicts the least-recently-used entry past maxEntries", () => {
  const cache = createTtlCache<number>({ maxEntries: 2, ttlMs: 10_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  // Touch "a" so "b" becomes least-recently-used.
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);

  assert.equal(cache.get("b"), undefined, "b was evicted as LRU");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.stats().size, 2);
});

test("getOrLoad caches the loaded value and only loads on a miss", async () => {
  const cache = createTtlCache<number>({ maxEntries: 10, ttlMs: 1000 });
  let calls = 0;
  const load = () => {
    calls += 1;
    return Promise.resolve(42);
  };

  assert.equal(await cache.getOrLoad("k", load), 42);
  assert.equal(await cache.getOrLoad("k", load), 42);
  assert.equal(calls, 1, "second call is served from cache");
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 1);
});

test("getOrLoad coalesces concurrent loads into a single upstream call", async () => {
  const cache = createTtlCache<number>({ maxEntries: 10, ttlMs: 1000 });
  let calls = 0;
  let release: (value: number) => void = () => {};
  const gate = new Promise<number>((resolve) => {
    release = resolve;
  });
  const load = () => {
    calls += 1;
    return gate;
  };

  const a = cache.getOrLoad("k", load);
  const b = cache.getOrLoad("k", load);
  const c = cache.getOrLoad("k", load);
  release(7);

  assert.deepEqual(await Promise.all([a, b, c]), [7, 7, 7]);
  assert.equal(calls, 1, "three concurrent callers share one loader");
  // One real miss (the loader) plus two coalesced hits.
  assert.equal(cache.stats().misses, 1);
  assert.equal(cache.stats().hits, 2);
});

test("getOrLoad does not cache a rejected loader and propagates the error", async () => {
  const cache = createTtlCache<number>({ maxEntries: 10, ttlMs: 1000 });
  let calls = 0;
  const failOnce = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(99);
  };

  await assert.rejects(cache.getOrLoad("k", failOnce), /boom/);
  // A failure must not be cached, so the next call retries the loader.
  assert.equal(await cache.getOrLoad("k", failOnce), 99);
  assert.equal(calls, 2);
});

test("clear and delete drop entries", () => {
  const cache = createTtlCache<number>({ maxEntries: 10, ttlMs: 1000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);

  cache.clear();
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.stats().size, 0);
});
