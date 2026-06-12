<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import BrandMark from "../../webapp/src/components/BrandMark.vue";
import { branding } from "../../branding.js";
import type { MetricsResponse, MetricsBucket } from "../../types/index.js";

const metrics = ref<MetricsResponse | null>(null);
const loading = ref(true);
const error = ref("");
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const CHART_HEIGHT = 180;

async function fetchMetrics(): Promise<void> {
  try {
    const response = await fetch("/api/metrics?range=24h");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    metrics.value = (await response.json()) as MetricsResponse;
    error.value = "";
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
  if (fraction === 0) return "—";
  return `${Math.round(fraction * 100)}%`;
}

const buckets = computed<MetricsBucket[]>(() => metrics.value?.buckets ?? []);

function cacheBars(): { x: number; hitY: number; hitH: number; missY: number; missH: number; w: number }[] {
  const bs = buckets.value;
  if (!bs.length) return [];
  const barW = Math.max(1, Math.floor(864 / bs.length) - 1);
  let max = 1;
  for (const b of bs) {
    const t = b.cacheHits + b.cacheMisses;
    if (t > max) max = t;
  }
  return bs.map((b, i) => {
    const total = b.cacheHits + b.cacheMisses;
    const totalH = (total / max) * CHART_HEIGHT;
    const hitH = total > 0 ? (b.cacheHits / total) * totalH : 0;
    const missH = totalH - hitH;
    return {
      x: i * (barW + 1),
      w: barW,
      hitY: CHART_HEIGHT - totalH,
      hitH,
      missY: CHART_HEIGHT - missH,
      missH
    };
  });
}

function trafficBars(): { x: number; visitorY: number; visitorH: number; searchY: number; searchH: number; w: number }[] {
  const bs = buckets.value;
  if (!bs.length) return [];
  const barW = Math.max(1, Math.floor(864 / bs.length) - 1);
  let max = 1;
  for (const b of bs) {
    const t = b.visitors + b.searches;
    if (t > max) max = t;
  }
  return bs.map((b, i) => {
    const total = b.visitors + b.searches;
    const totalH = (total / max) * CHART_HEIGHT;
    const visitorH = total > 0 ? (b.visitors / total) * totalH : 0;
    const searchH = totalH - visitorH;
    return {
      x: i * (barW + 1),
      w: barW,
      visitorY: CHART_HEIGHT - totalH,
      visitorH,
      searchY: CHART_HEIGHT - searchH,
      searchH
    };
  });
}

function viewWidth(bars: { x: number; w: number }[]): number {
  if (!bars.length) return 864;
  const last = bars[bars.length - 1]!;
  return last.x + last.w + 1;
}

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
        <p v-if="error" class="notice notice-danger">{{ error }}</p>

        <div class="summary-grid">
          <div class="summary-card">
            <span class="summary-label">Visitors (24h)</span>
            <div class="summary-value">{{ fmt(metrics?.summary.visitors ?? 0) }}</div>
          </div>
          <div class="summary-card">
            <span class="summary-label">Searches (24h)</span>
            <div class="summary-value">{{ fmt(metrics?.summary.searches ?? 0) }}</div>
          </div>
          <div class="summary-card">
            <span class="summary-label">Cache Hit Rate</span>
            <div class="summary-value">{{ pct(metrics?.summary.hitRate ?? 0) }}</div>
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
              <svg v-if="cacheBars().length" :viewBox="`0 0 ${viewWidth(cacheBars())} ${CHART_HEIGHT}`" class="chart" preserveAspectRatio="none">
                <g v-for="(bar, i) in cacheBars()" :key="i">
                  <rect :x="bar.x" :y="bar.missY" :width="bar.w" :height="bar.missH" fill="#f85149" opacity="0.6" />
                  <rect :x="bar.x" :y="bar.hitY" :width="bar.w" :height="bar.hitH" fill="#3fb950" opacity="0.85" />
                </g>
              </svg>
              <div v-else class="empty-state">No cache data yet.</div>
              <div v-if="cacheBars().length" class="chart-legend">
                <span class="legend-item"><span class="legend-swatch" style="background:#3fb950" /> Hits</span>
                <span class="legend-item"><span class="legend-swatch" style="background:#f85149" /> Misses</span>
              </div>
            </div>
          </div>

          <!-- Traffic chart -->
          <div class="section">
            <div class="section-header">
              <h2>Traffic</h2>
              <span class="section-meta">Per 5-minute block</span>
            </div>
            <div class="section-body">
              <svg v-if="trafficBars().length" :viewBox="`0 0 ${viewWidth(trafficBars())} ${CHART_HEIGHT}`" class="chart" preserveAspectRatio="none">
                <g v-for="(bar, i) in trafficBars()" :key="i">
                  <rect :x="bar.x" :y="bar.visitorY" :width="bar.w" :height="bar.visitorH" fill="#58a6ff" opacity="0.7" />
                  <rect :x="bar.x" :y="bar.searchY" :width="bar.w" :height="bar.searchH" fill="#3fb950" opacity="0.85" />
                </g>
              </svg>
              <div v-else class="empty-state">No traffic data yet.</div>
              <div v-if="trafficBars().length" class="chart-legend">
                <span class="legend-item"><span class="legend-swatch" style="background:#58a6ff" /> Visitors</span>
                <span class="legend-item"><span class="legend-swatch" style="background:#3fb950" /> Searches</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </main>
  </div>
</template>
