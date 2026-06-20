import test from "node:test";
import assert from "node:assert/strict";
import { createPrometheusRegistry } from "../lib/metrics/prometheus.js";

test("counter renders type, help, and labeled series", () => {
  const reg = createPrometheusRegistry();
  const c = reg.counter("http_requests_total", "Total requests.");
  c.inc({ method: "GET", status: "200" });
  c.inc({ method: "GET", status: "200" });
  c.inc({ method: "POST", status: "500" }, 3);

  const out = reg.render();
  assert.match(out, /# HELP http_requests_total Total requests\./);
  assert.match(out, /# TYPE http_requests_total counter/);
  assert.match(out, /http_requests_total\{method="GET",status="200"\} 2/);
  assert.match(out, /http_requests_total\{method="POST",status="500"\} 3/);
});

test("counter with no observations still emits a zero series", () => {
  const reg = createPrometheusRegistry();
  reg.counter("errors_total", "Errors.");
  assert.match(reg.render(), /errors_total 0/);
});

test("gauge reads its value at render time", () => {
  const reg = createPrometheusRegistry();
  let depth = 0;
  reg.gauge("queue_depth", "Queue depth.", () => depth);
  depth = 7;
  assert.match(reg.render(), /queue_depth 7/);
});

test("gauge that throws renders as 0", () => {
  const reg = createPrometheusRegistry();
  reg.gauge("flaky", "Flaky.", () => {
    throw new Error("boom");
  });
  assert.match(reg.render(), /flaky 0/);
});

test("histogram emits cumulative buckets, sum, and count", () => {
  const reg = createPrometheusRegistry();
  const h = reg.histogram("latency_seconds", "Latency.", [0.1, 0.5, 1]);
  h.observe(0.05);
  h.observe(0.2);
  h.observe(2);

  const out = reg.render();
  assert.match(out, /# TYPE latency_seconds histogram/);
  assert.match(out, /latency_seconds_bucket\{le="0.1"\} 1/);
  assert.match(out, /latency_seconds_bucket\{le="0.5"\} 2/);
  assert.match(out, /latency_seconds_bucket\{le="1"\} 2/);
  assert.match(out, /latency_seconds_bucket\{le="\+Inf"\} 3/);
  assert.match(out, /latency_seconds_count 3/);
  assert.match(out, /latency_seconds_sum 2.25/);
});

test("histogram ignores non-finite and negative observations", () => {
  const reg = createPrometheusRegistry();
  const h = reg.histogram("latency_seconds", "Latency.", [0.1, 1]);
  h.observe(0.5);
  h.observe(-3);
  h.observe(Number.NaN);
  h.observe(Number.POSITIVE_INFINITY);

  const out = reg.render();
  // Only the single valid observation counts; sum is not corrupted.
  assert.match(out, /latency_seconds_count 1/);
  assert.match(out, /latency_seconds_sum 0.5/);
});

test("label values are escaped", () => {
  const reg = createPrometheusRegistry();
  const c = reg.counter("weird", "Weird.");
  c.inc({ path: 'a"b\\c' });
  assert.match(reg.render(), /weird\{path="a\\"b\\\\c"\}/);
});
