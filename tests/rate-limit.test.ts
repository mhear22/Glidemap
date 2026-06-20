import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../lib/http/rate-limit.js";

function fixedClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    }
  };
}

test("rate limiter allows up to max then blocks within a window", () => {
  const clock = fixedClock();
  const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: clock.now, sweepIntervalMs: 0 });

  assert.equal(limiter.check("ip").allowed, true);
  assert.equal(limiter.check("ip").allowed, true);
  const third = limiter.check("ip");
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  const blocked = limiter.check("ip");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds >= 1);
  limiter.stop();
});

test("rate limiter resets after the window elapses", () => {
  const clock = fixedClock();
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: clock.now, sweepIntervalMs: 0 });

  assert.equal(limiter.check("ip").allowed, true);
  assert.equal(limiter.check("ip").allowed, false);

  clock.advance(1001);
  assert.equal(limiter.check("ip").allowed, true);
  limiter.stop();
});

test("rate limiter tracks keys independently", () => {
  const clock = fixedClock();
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: clock.now, sweepIntervalMs: 0 });

  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("b").allowed, true);
  assert.equal(limiter.check("a").allowed, false);
  assert.equal(limiter.size(), 2);
  limiter.stop();
});

test("rate limiter reset clears a single key", () => {
  const clock = fixedClock();
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: clock.now, sweepIntervalMs: 0 });
  limiter.check("a");
  assert.equal(limiter.check("a").allowed, false);
  limiter.reset("a");
  assert.equal(limiter.check("a").allowed, true);
  limiter.stop();
});

test("rate limiter validates options", () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 1 }));
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }));
});

test("background sweep evicts expired keys so memory stays bounded", async () => {
  const clock = fixedClock();
  const limiter = createRateLimiter({ windowMs: 50, max: 5, now: clock.now, sweepIntervalMs: 20 });

  limiter.check("a");
  limiter.check("b");
  assert.equal(limiter.size(), 2);

  // Advance the injected clock past the window so entries are expired, then let
  // the real sweep timer fire.
  clock.advance(100);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(limiter.size(), 0);
  limiter.stop();
});
