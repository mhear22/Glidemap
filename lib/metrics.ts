import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, writeJson } from "./utils.js";
import type { MetricsBucket, MetricsResponse } from "../types/api.js";

interface MutableBucket {
  visitors: number;
  searches: number;
  cacheHits: number;
  cacheMisses: number;
  visitorIps: Set<string>;
}

interface StoredBucket {
  visitors: number;
  searches: number;
  cacheHits: number;
  cacheMisses: number;
}

const BUCKETS_PER_DAY = 288;
const BLOCK_MINUTES = 5;

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentBucketIndex(): number {
  const now = new Date();
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / BLOCK_MINUTES);
}

function bucketTime(date: string, index: number): string {
  const totalMinutes = index * BLOCK_MINUTES;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

function createEmptyBuckets(): MutableBucket[] {
  const buckets: MutableBucket[] = [];
  for (let i = 0; i < BUCKETS_PER_DAY; i++) {
    buckets.push({
      visitors: 0,
      searches: 0,
      cacheHits: 0,
      cacheMisses: 0,
      visitorIps: new Set()
    });
  }
  return buckets;
}

function bucketsToStored(buckets: MutableBucket[]): StoredBucket[] {
  return buckets.map((b) => ({
    visitors: b.visitors,
    searches: b.searches,
    cacheHits: b.cacheHits,
    cacheMisses: b.cacheMisses
  }));
}

function storedToBuckets(stored: StoredBucket[]): MutableBucket[] {
  if (stored.length === BUCKETS_PER_DAY) {
    return stored.map((s) => ({
      ...s,
      visitorIps: new Set<string>()
    }));
  }
  const buckets = createEmptyBuckets();
  for (let i = 0; i < Math.min(stored.length, BUCKETS_PER_DAY); i++) {
    const target = buckets[i];
    const source = stored[i];
    if (!target || !source) continue;
    target.visitors = source.visitors;
    target.searches = source.searches;
    target.cacheHits = source.cacheHits;
    target.cacheMisses = source.cacheMisses;
  }
  return buckets;
}

export interface MetricsCollector {
  recordVisitor(ip: string): void;
  recordSearch(): void;
  recordCacheHit(): void;
  recordCacheMiss(): void;
  getMetrics(range: "24h"): Promise<MetricsResponse>;
  flush(): Promise<void>;
  stop(): void;
}

export function createMetricsCollector({ rootDir }: { rootDir: string }): MetricsCollector {
  const metricsDir = path.join(rootDir, ".metrics");
  let currentDate = todayString();
  let buckets = createEmptyBuckets();
  let dirty = false;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let flushing = false;

  void ensureDir(metricsDir).then(() => {
    void loadDay(currentDate);
  });

  flushTimer = setInterval(() => {
    void flush();
  }, 60_000);

  async function dayFilePath(date: string): Promise<string> {
    return path.join(metricsDir, `${date}.json`);
  }

  async function loadDay(date: string): Promise<void> {
    try {
      const filePath = await dayFilePath(date);
      const raw = await fs.readFile(filePath, "utf8");
      const stored = JSON.parse(raw) as StoredBucket[];
      if (date === currentDate) {
        buckets = storedToBuckets(stored);
      }
    } catch {
      if (date === currentDate) {
        buckets = createEmptyBuckets();
      }
    }
  }

  async function writeDay(date: string, data: StoredBucket[]): Promise<void> {
    const filePath = await dayFilePath(date);
    await writeJson(filePath, data);
  }

  function rolloverIfNeeded(): void {
    const today = todayString();
    if (today !== currentDate) {
      const oldDate = currentDate;
      const oldBuckets = bucketsToStored(buckets);
      currentDate = today;
      buckets = createEmptyBuckets();
      dirty = false;
      void writeDay(oldDate, oldBuckets);
      void loadDay(today);
    }
  }

  async function flush(): Promise<void> {
    if (!dirty || flushing) {
      return;
    }
    flushing = true;
    try {
      await writeDay(currentDate, bucketsToStored(buckets));
      dirty = false;
    } finally {
      flushing = false;
    }
  }

  function recordVisitor(ip: string): void {
    rolloverIfNeeded();
    const idx = currentBucketIndex();
    const bucket = buckets[idx];
    if (!bucket) {
      return;
    }
    if (!bucket.visitorIps.has(ip)) {
      bucket.visitorIps.add(ip);
      bucket.visitors++;
      dirty = true;
    }
  }

  function recordSearch(): void {
    rolloverIfNeeded();
    const idx = currentBucketIndex();
    const bucket = buckets[idx];
    if (!bucket) {
      return;
    }
    bucket.searches++;
    dirty = true;
  }

  function recordCacheHit(): void {
    rolloverIfNeeded();
    const idx = currentBucketIndex();
    const bucket = buckets[idx];
    if (!bucket) {
      return;
    }
    bucket.cacheHits++;
    dirty = true;
  }

  function recordCacheMiss(): void {
    rolloverIfNeeded();
    const idx = currentBucketIndex();
    const bucket = buckets[idx];
    if (!bucket) {
      return;
    }
    bucket.cacheMisses++;
    dirty = true;
  }

  async function getMetrics(range: "24h"): Promise<MetricsResponse> {
    await flush();

    const now = new Date();
    const resultBuckets: MetricsBucket[] = [];
    let totalVisitors = 0;
    let totalSearches = 0;
    let totalCacheHits = 0;
    let totalCacheMisses = 0;

    if (range === "24h") {
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);

      const yesterdayDate = new Date(startOfToday.getTime() - 86400000);
      const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

      let yesterdayBuckets: StoredBucket[] | null = null;
      if (yesterdayStr !== currentDate) {
        try {
          const filePath = await dayFilePath(yesterdayStr);
          const raw = await fs.readFile(filePath, "utf8");
          yesterdayBuckets = JSON.parse(raw) as StoredBucket[];
        } catch {
          yesterdayBuckets = null;
        }
      }

      const currentBucketIdx = currentBucketIndex();

      if (yesterdayBuckets) {
        const bucketsNeeded = BUCKETS_PER_DAY - currentBucketIdx - 1;
        for (let i = 0; i < bucketsNeeded && i < yesterdayBuckets.length; i++) {
          const srcIdx = BUCKETS_PER_DAY - bucketsNeeded + i;
          const src = yesterdayBuckets[srcIdx];
          if (!src) {
            continue;
          }
          resultBuckets.push({
            time: bucketTime(yesterdayStr, srcIdx),
            visitors: src.visitors,
            searches: src.searches,
            cacheHits: src.cacheHits,
            cacheMisses: src.cacheMisses
          });
          totalVisitors += src.visitors;
          totalSearches += src.searches;
          totalCacheHits += src.cacheHits;
          totalCacheMisses += src.cacheMisses;
        }
      }

      const stored = bucketsToStored(buckets);
      for (let i = 0; i <= currentBucketIdx && i < stored.length; i++) {
        const src = stored[i];
        if (!src) continue;
        resultBuckets.push({
          time: bucketTime(currentDate, i),
          visitors: src.visitors,
          searches: src.searches,
          cacheHits: src.cacheHits,
          cacheMisses: src.cacheMisses
        });
        totalVisitors += src.visitors;
        totalSearches += src.searches;
        totalCacheHits += src.cacheHits;
        totalCacheMisses += src.cacheMisses;
      }
    }

    const totalCache = totalCacheHits + totalCacheMisses;
    return {
      buckets: resultBuckets,
      summary: {
        visitors: totalVisitors,
        searches: totalSearches,
        cacheHits: totalCacheHits,
        cacheMisses: totalCacheMisses,
        hitRate: totalCache > 0 ? totalCacheHits / totalCache : 0
      }
    };
  }

  function stop(): void {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    void flush();
  }

  return {
    recordVisitor,
    recordSearch,
    recordCacheHit,
    recordCacheMiss,
    getMetrics,
    flush,
    stop
  };
}
