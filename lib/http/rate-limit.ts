// In-memory fixed-window rate limiter.
//
// Keyed by an arbitrary identity (typically client IP). Each key gets a counter
// that resets every `windowMs`. This is intentionally simple and process-local —
// adequate for protecting a single-node service and the upstream APIs it calls.
// The clock is injectable so behavior is fully deterministic under test, and a
// background sweep evicts stale keys so memory can't grow without bound.

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests permitted in the current window. */
  remaining: number;
  /** Epoch milliseconds when the current window resets. */
  resetAt: number;
  /** Configured maximum per window. */
  limit: number;
  /** Seconds until reset, for a Retry-After header. Only meaningful when blocked. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  reset(key: string): void;
  /** Number of tracked keys; primarily for tests/observability. */
  size(): number;
  /** Stop the background eviction timer. */
  stop(): void;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** How often to sweep expired entries. Defaults to windowMs. Set 0 to disable. */
  sweepIntervalMs?: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, max } = options;
  if (windowMs <= 0) {
    throw new Error("rate limiter windowMs must be positive");
  }
  if (max <= 0) {
    throw new Error("rate limiter max must be positive");
  }

  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();

  const sweepInterval = options.sweepIntervalMs ?? windowMs;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  if (sweepInterval > 0) {
    sweepTimer = setInterval(() => {
      const current = now();
      for (const [key, window] of windows) {
        if (window.resetAt <= current) {
          windows.delete(key);
        }
      }
    }, sweepInterval);
    // Don't keep the event loop alive purely for cache eviction.
    sweepTimer.unref?.();
  }

  function check(key: string): RateLimitResult {
    const current = now();
    let window = windows.get(key);

    if (!window || window.resetAt <= current) {
      window = { count: 0, resetAt: current + windowMs };
      windows.set(key, window);
    }

    window.count += 1;
    const allowed = window.count <= max;
    const remaining = Math.max(0, max - window.count);
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((window.resetAt - current) / 1000));

    return {
      allowed,
      remaining,
      resetAt: window.resetAt,
      limit: max,
      retryAfterSeconds
    };
  }

  return {
    check,
    reset(key: string): void {
      windows.delete(key);
    },
    size(): number {
      return windows.size;
    },
    stop(): void {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    }
  };
}
