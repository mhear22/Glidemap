<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import BrandMark from "../../webapp/src/components/BrandMark.vue";
import { branding } from "../../branding.js";
import type { MetricsResponse, MetricsBucket } from "../../types/index.js";

const metrics = ref<MetricsResponse | null>(null);
const loading = ref(true);
const error = ref("");
const updatedAt = ref<Date | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const CHART_HEIGHT = 180;
const CHART_WIDTH = 864;
// Horizontal gridlines (as fractions of the chart height) for axis hints.
const GRID_FRACTIONS = [0.25, 0.5, 0.75];

async function fetchMetrics(): Promise<void> {
  try {
    const response = await fetch("/api/metrics?range=24h");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    metrics.value = (await response.json()) as MetricsResponse;
    error.value = "";
    updatedAt.value = new Date();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

function fmt(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

const updatedLabel = computed<string>(() => {
  if (!updatedAt.value) return "";
  return updatedAt.value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

const buckets = computed<MetricsBucket[]>(() => metrics.value?.buckets ?? []);

interface StackedBar {
  x: number;
  w: number;
  primaryY: number;
  primaryH: number;
  secondaryY: number;
  secondaryH: number;
}

/**
 * Builds stacked bars for the chart. A bucket with a non-zero value gets a
 * small minimum height so a lone data point is a visible bar, not a hairline.
 */
function buildBars(
  primaryOf: (b: MetricsBucket) => number,
  secondaryOf: (b: MetricsBucket) => number
): StackedBar[] {
  const bs = buckets.value;
  if (!bs.length) return [];
  const barW = Math.max(1, Math.floor(CHART_WIDTH / bs.length) - 1);
  const MIN_BAR = 3;
  let max = 1;
  for (const b of bs) {
    const t = primaryOf(b) + secondaryOf(b);
    if (t > max) max = t;
  }
  return bs.map((b, i) => {
    const primary = primaryOf(b);
    const secondary = secondaryOf(b);
    const total = primary + secondary;
    let totalH = (total / max) * CHART_HEIGHT;
    if (total > 0) totalH = Math.max(totalH, MIN_BAR);
    const primaryH = total > 0 ? (primary / total) * totalH : 0;
    const secondaryH = totalH - primaryH;
    return {
      x: i * (barW + 1),
      w: barW,
      primaryY: CHART_HEIGHT - totalH,
      primaryH,
      secondaryY: CHART_HEIGHT - secondaryH,
      secondaryH
    };
  });
}

const cacheBars = computed<StackedBar[]>(() =>
  buildBars((b) => b.cacheHits, (b) => b.cacheMisses)
);
const trafficBars = computed<StackedBar[]>(() =>
  buildBars((b) => b.visitors, (b) => b.searches)
);

// Gate the zero-state on the DATA TOTAL, not the bucket-array length:
// the API always returns a full bucket array even when every value is 0.
const cacheTotal = computed<number>(() => {
  const s = metrics.value?.summary;
  return s ? s.cacheHits + s.cacheMisses : 0;
});
const trafficTotal = computed<number>(() => {
  const s = metrics.value?.summary;
  return s ? s.visitors + s.searches : 0;
});

const hasCacheData = computed<boolean>(() => cacheTotal.value > 0);
const hasTrafficData = computed<boolean>(() => trafficTotal.value > 0);

function viewWidth(bars: StackedBar[]): number {
  if (!bars.length) return CHART_WIDTH;
  const last = bars[bars.length - 1]!;
  return last.x + last.w + 1;
}

const cacheAria = computed<string>(() => {
  const s = metrics.value?.summary;
  if (!s) return "Cache performance chart";
  return `Cache performance over the last 24 hours: ${fmt(s.cacheHits)} hits and ${fmt(s.cacheMisses)} misses, ${pct(s.hitRate)} hit rate.`;
});
const trafficAria = computed<string>(() => {
  const s = metrics.value?.summary;
  if (!s) return "Traffic chart";
  return `Traffic over the last 24 hours: ${fmt(s.visitors)} visitors and ${fmt(s.searches)} searches.`;
});

onMounted(async () => {
  await fetchMetrics();
  refreshTimer = setInterval(fetchMetrics, 5 * 60 * 1000);
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-logo">
        <BrandMark />
        <span>Admin</span>
      </div>
      <div class="header-actions">
        <span class="status-badge status-badge-green" :title="`${branding.name} metrics`">Metrics</span>
      </div>
    </header>

    <main class="admin-content">
      <div class="admin-inner">
        <div class="page-head">
          <h1 class="page-title">
            Overview
            <span class="page-range">· Last 24 hours</span>
          </h1>
          <span v-if="updatedLabel" class="page-updated">Updated {{ updatedLabel }}</span>
        </div>

        <p v-if="error" class="notice notice-danger">{{ error }}</p>

        <div class="summary-grid">
          <div class="summary-card accent-visitors">
            <div class="summary-head">
              <span class="summary-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </span>
              <span class="summary-label">Visitors (24h)</span>
            </div>
            <div class="summary-value" :class="{ 'is-empty': (metrics?.summary.visitors ?? 0) === 0 }">
              {{ fmt(metrics?.summary.visitors ?? 0) }}
            </div>
          </div>

          <div class="summary-card accent-searches">
            <div class="summary-head">
              <span class="summary-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
              </span>
              <span class="summary-label">Searches (24h)</span>
            </div>
            <div class="summary-value" :class="{ 'is-empty': (metrics?.summary.searches ?? 0) === 0 }">
              {{ fmt(metrics?.summary.searches ?? 0) }}
            </div>
          </div>

          <div class="summary-card accent-cache">
            <div class="summary-head">
              <span class="summary-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
              </span>
              <span class="summary-label">Cache Hit Rate</span>
            </div>
            <div class="summary-value" :class="{ 'is-empty': cacheTotal === 0 }">
              {{ cacheTotal === 0 ? "n/a" : pct(metrics?.summary.hitRate ?? 0) }}
            </div>
            <div class="summary-sub" v-if="metrics">
              {{ fmt(metrics.summary.cacheHits) }} hits / {{ fmt(metrics.summary.cacheMisses) }} misses
            </div>
          </div>
        </div>

        <div v-if="loading && !metrics" class="empty-state">Loading metrics…</div>

        <template v-else-if="metrics">
          <!-- Cache chart -->
          <div class="section">
            <div class="section-header">
              <h2>Cache Performance</h2>
              <span class="section-meta">{{ fmt(metrics.summary.cacheHits + metrics.summary.cacheMisses) }} tile requests</span>
            </div>
            <div class="section-body">
              <div class="chart-body">
                <svg
                  v-if="hasCacheData"
                  :viewBox="`0 0 ${viewWidth(cacheBars)} ${CHART_HEIGHT}`"
                  class="chart"
                  preserveAspectRatio="none"
                  role="img"
                  :aria-label="cacheAria"
                >
                  <line
                    v-for="f in GRID_FRACTIONS"
                    :key="`g${f}`"
                    class="chart-grid"
                    x1="0"
                    :x2="viewWidth(cacheBars)"
                    :y1="CHART_HEIGHT * f"
                    :y2="CHART_HEIGHT * f"
                  />
                  <line class="chart-baseline" x1="0" :x2="viewWidth(cacheBars)" :y1="CHART_HEIGHT" :y2="CHART_HEIGHT" />
                  <g v-for="(bar, i) in cacheBars" :key="i" class="bar-group">
                    <rect class="bar-miss" :x="bar.x" :y="bar.secondaryY" :width="bar.w" :height="bar.secondaryH" />
                    <rect class="bar-hit" :x="bar.x" :y="bar.primaryY" :width="bar.w" :height="bar.primaryH" />
                  </g>
                </svg>
                <div v-else class="chart-zero">
                  <span class="chart-zero-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 3v18h18" />
                      <path d="m19 9-5 5-4-4-3 3" />
                    </svg>
                  </span>
                  No cache activity in the last 24 hours.
                </div>
              </div>
              <template v-if="hasCacheData">
                <div class="chart-axis">
                  <span>00:00</span>
                  <span>now</span>
                </div>
                <div class="chart-legend">
                  <span class="legend-item"><span class="legend-swatch swatch-hit" /> Hits</span>
                  <span class="legend-item"><span class="legend-swatch swatch-miss" /> Misses</span>
                </div>
              </template>
              <!-- Offscreen data alternative for assistive tech. -->
              <table v-if="hasCacheData" class="visually-hidden">
                <caption>Cache performance, last 24 hours</caption>
                <thead><tr><th>Time</th><th>Hits</th><th>Misses</th></tr></thead>
                <tbody>
                  <tr v-for="(b, i) in buckets" :key="i">
                    <td>{{ b.time }}</td><td>{{ b.cacheHits }}</td><td>{{ b.cacheMisses }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Traffic chart -->
          <div class="section">
            <div class="section-header">
              <h2>Traffic</h2>
              <span class="section-meta">Per 5-minute block</span>
            </div>
            <div class="section-body">
              <div class="chart-body">
                <svg
                  v-if="hasTrafficData"
                  :viewBox="`0 0 ${viewWidth(trafficBars)} ${CHART_HEIGHT}`"
                  class="chart"
                  preserveAspectRatio="none"
                  role="img"
                  :aria-label="trafficAria"
                >
                  <line
                    v-for="f in GRID_FRACTIONS"
                    :key="`g${f}`"
                    class="chart-grid"
                    x1="0"
                    :x2="viewWidth(trafficBars)"
                    :y1="CHART_HEIGHT * f"
                    :y2="CHART_HEIGHT * f"
                  />
                  <line class="chart-baseline" x1="0" :x2="viewWidth(trafficBars)" :y1="CHART_HEIGHT" :y2="CHART_HEIGHT" />
                  <g v-for="(bar, i) in trafficBars" :key="i" class="bar-group">
                    <rect class="series-accent" :x="bar.x" :y="bar.primaryY" :width="bar.w" :height="bar.primaryH" />
                    <rect class="bar-hit" :x="bar.x" :y="bar.secondaryY" :width="bar.w" :height="bar.secondaryH" />
                  </g>
                </svg>
                <div v-else class="chart-zero">
                  <span class="chart-zero-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 3v18h18" />
                      <rect x="7" y="13" width="3" height="5" />
                      <rect x="14" y="9" width="3" height="9" />
                    </svg>
                  </span>
                  No traffic in the last 24 hours.
                </div>
              </div>
              <template v-if="hasTrafficData">
                <div class="chart-axis">
                  <span>00:00</span>
                  <span>now</span>
                </div>
                <div class="chart-legend">
                  <span class="legend-item"><span class="legend-swatch swatch-accent" /> Visitors</span>
                  <span class="legend-item"><span class="legend-swatch swatch-hit" /> Searches</span>
                </div>
              </template>
              <table v-if="hasTrafficData" class="visually-hidden">
                <caption>Traffic, last 24 hours</caption>
                <thead><tr><th>Time</th><th>Visitors</th><th>Searches</th></tr></thead>
                <tbody>
                  <tr v-for="(b, i) in buckets" :key="i">
                    <td>{{ b.time }}</td><td>{{ b.visitors }}</td><td>{{ b.searches }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>
    </main>
  </div>
</template>
