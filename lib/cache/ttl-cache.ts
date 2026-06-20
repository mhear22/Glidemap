// Bounded, in-memory TTL cache with single-flight loading.
//
// A small dependency-free cache used to shield upstream services (geocoding) from
// repeated identical requests. Three properties make it safe for production:
//
//   * Bounded size — least-recently-used entries are evicted once `maxEntries` is
//     reached, so memory cannot grow without bound.
//   * Per-entry expiry — entries older than `ttlMs` are treated as misses, so the
//     cache never serves indefinitely stale data.
//   * Single-flight — concurrent `getOrLoad` calls for the same key share one
//     in-flight loader, so a burst of identical requests results in exactly one
//     upstream call (thundering-herd protection).
//
// The clock is injectable so expiry is fully deterministic under test, and there
// is no background timer to leak — expiry is evaluated lazily on access and bounded
// by LRU eviction.

export interface CacheStats {
  /** Entries currently held (including any expired-but-not-yet-accessed). */
  size: number;
  /** Configured maximum number of entries. */
  maxEntries: number;
  /** Reads served from a live cached value (includes coalesced single-flight waiters). */
  hits: number;
  /** Reads that triggered a loader invocation (i.e. an upstream call). */
  misses: number;
}

export interface TtlCacheOptions {
  /** Maximum entries retained; least-recently-used entries are evicted past this. */
  maxEntries: number;
  /** Entry lifetime in milliseconds. Entries older than this are misses. */
  ttlMs: number;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
}

export interface TtlCache<T> {
  /** Return a live cached value, or undefined on miss/expiry. Counts toward stats. */
  get(key: string): T | undefined;
  /** Store a value, refreshing its TTL and marking it most-recently-used. */
  set(key: string, value: T): void;
  /**
   * Return the cached value for `key`, or invoke `loader` to produce it. Concurrent
   * calls for the same key share a single loader invocation. A rejected loader is
   * not cached and propagates to every waiter.
   */
  getOrLoad(key: string, loader: () => Promise<T>): Promise<T>;
  delete(key: string): void;
  clear(): void;
  stats(): CacheStats;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createTtlCache<T>(options: TtlCacheOptions): TtlCache<T> {
  const { maxEntries, ttlMs } = options;
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("ttl cache maxEntries must be a positive integer");
  }
  if (ttlMs <= 0) {
    throw new Error("ttl cache ttlMs must be positive");
  }

  const now = options.now ?? Date.now;
  // Map iteration order is insertion order; re-inserting a key moves it to the
  // end, so the first key is always the least-recently-used.
  const entries = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<T>>();
  let hits = 0;
  let misses = 0;

  function readFresh(key: string): T | undefined {
    const entry = entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    // Mark most-recently-used by reinserting at the tail.
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function store(key: string, value: T): void {
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      entries.delete(oldest);
    }
  }

  return {
    get(key: string): T | undefined {
      const value = readFresh(key);
      if (value === undefined) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      return value;
    },

    set: store,

    async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
      const cached = readFresh(key);
      if (cached !== undefined) {
        hits += 1;
        return cached;
      }

      // Coalesce concurrent loads for the same key onto one upstream call. Waiters
      // count as hits because they avoid an upstream round-trip of their own.
      const pending = inflight.get(key);
      if (pending) {
        hits += 1;
        return pending;
      }

      misses += 1;
      const promise = (async () => {
        const value = await loader();
        store(key, value);
        return value;
      })();
      inflight.set(key, promise);
      try {
        return await promise;
      } finally {
        inflight.delete(key);
      }
    },

    delete(key: string): void {
      entries.delete(key);
    },

    clear(): void {
      entries.clear();
    },

    stats(): CacheStats {
      return { size: entries.size, maxEntries, hits, misses };
    }
  };
}
