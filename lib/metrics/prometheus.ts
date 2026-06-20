// Minimal Prometheus metrics registry.
//
// Exposes counters, callback gauges, and a histogram in the Prometheus text
// exposition format — enough for the standard golden signals (request rate,
// errors, latency) plus queue depth — without pulling in a dependency. Label
// values are escaped per the exposition spec.

export interface Counter {
  inc(labels?: Record<string, string>, value?: number): void;
}

export interface Histogram {
  observe(value: number): void;
}

export interface PrometheusRegistry {
  counter(name: string, help: string): Counter;
  histogram(name: string, help: string, buckets: number[]): Histogram;
  /** Register a gauge whose value is read from `read()` at scrape time. */
  gauge(name: string, help: string, read: () => number): void;
  render(): string;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function serializeLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return "";
  }
  const inner = keys.map((key) => `${key}="${escapeLabelValue(labels[key] ?? "")}"`).join(",");
  return `{${inner}}`;
}

interface CounterState {
  name: string;
  help: string;
  series: Map<string, { labels: Record<string, string>; value: number }>;
}

interface HistogramState {
  name: string;
  help: string;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

interface GaugeState {
  name: string;
  help: string;
  read: () => number;
}

export function createPrometheusRegistry(): PrometheusRegistry {
  const counters: CounterState[] = [];
  const histograms: HistogramState[] = [];
  const gauges: GaugeState[] = [];

  function counter(name: string, help: string): Counter {
    const state: CounterState = { name, help, series: new Map() };
    counters.push(state);
    return {
      inc(labels: Record<string, string> = {}, value = 1): void {
        const key = serializeLabels(labels);
        const existing = state.series.get(key);
        if (existing) {
          existing.value += value;
        } else {
          state.series.set(key, { labels, value });
        }
      }
    };
  }

  function histogram(name: string, help: string, buckets: number[]): Histogram {
    const sorted = [...buckets].sort((a, b) => a - b);
    const state: HistogramState = {
      name,
      help,
      buckets: sorted,
      counts: new Array(sorted.length).fill(0),
      sum: 0,
      count: 0
    };
    histograms.push(state);
    return {
      observe(value: number): void {
        // Durations are non-negative; drop NaN/Infinity/negative values rather
        // than let them corrupt the sum (and therefore the computed average).
        if (!Number.isFinite(value) || value < 0) {
          return;
        }
        state.sum += value;
        state.count += 1;
        for (let i = 0; i < state.buckets.length; i += 1) {
          if (value <= (state.buckets[i] ?? Infinity)) {
            state.counts[i] = (state.counts[i] ?? 0) + 1;
          }
        }
      }
    };
  }

  function gauge(name: string, help: string, read: () => number): void {
    gauges.push({ name, help, read });
  }

  function render(): string {
    const lines: string[] = [];

    for (const c of counters) {
      lines.push(`# HELP ${c.name} ${c.help}`);
      lines.push(`# TYPE ${c.name} counter`);
      if (c.series.size === 0) {
        lines.push(`${c.name} 0`);
      }
      for (const { labels, value } of c.series.values()) {
        lines.push(`${c.name}${serializeLabels(labels)} ${value}`);
      }
    }

    for (const g of gauges) {
      lines.push(`# HELP ${g.name} ${g.help}`);
      lines.push(`# TYPE ${g.name} gauge`);
      let value = 0;
      try {
        value = g.read();
      } catch {
        value = 0;
      }
      lines.push(`${g.name} ${value}`);
    }

    for (const h of histograms) {
      lines.push(`# HELP ${h.name} ${h.help}`);
      lines.push(`# TYPE ${h.name} histogram`);
      // counts[i] is already cumulative: observe() increments every bucket whose
      // upper bound is >= the value, so each entry is the "<= le" total.
      for (let i = 0; i < h.buckets.length; i += 1) {
        lines.push(`${h.name}_bucket{le="${h.buckets[i]}"} ${h.counts[i] ?? 0}`);
      }
      lines.push(`${h.name}_bucket{le="+Inf"} ${h.count}`);
      lines.push(`${h.name}_sum ${h.sum}`);
      lines.push(`${h.name}_count ${h.count}`);
    }

    return `${lines.join("\n")}\n`;
  }

  return { counter, histogram, gauge, render };
}
