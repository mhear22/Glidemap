<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { FormCamera } from "../types.js";

const props = withDefaults(defineProps<{
  camera: FormCamera;
  progress?: number;
}>(), {
  progress: 0
});

const emit = defineEmits<{
  (e: "update-camera", value: FormCamera): void;
}>();

const width = 360;
const height = 220;
const margin = { top: 22, right: 18, bottom: 32, left: 24 };
const dragState = ref<string | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);

const handleT = 0.25;

function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(value, min), max); }

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function sampleTimingEasing(t: number, intensity: number, isInverted: boolean): number {
  const linear = t;
  const cubic = easeInOutCubic(t);
  const sign = isInverted ? -1 : 1;
  return linear + (cubic - linear) * clamp(intensity, 0, 1) * sign;
}

function progressToX(p: number): number { return margin.left + p * (width - margin.left - margin.right); }
function easedToY(e: number): number { return margin.top + (1 - e) * (height - margin.top - margin.bottom); }
function xToProgress(x: number): number { return clamp((x - margin.left) / (width - margin.left - margin.right), 0, 1); }
function yToEased(y: number): number { return clamp(1 - (y - margin.top) / (height - margin.top - margin.bottom), 0, 1); }

const timingCurve = computed<number>(() => clamp(Number(props.camera.timingCurve ?? 50), 0, 100));
const intensity = computed<number>(() => timingCurve.value / 100);
const inverted = computed<boolean>(() => Boolean(props.camera.timingInverted));

const curveLabel = computed<string>(() => {
  const v = timingCurve.value;
  const prefix = inverted.value ? "Inverted " : "";
  if (v <= 10) return `${prefix}Linear`;
  if (v <= 35) return `${prefix}Subtle ease`;
  if (v <= 65) return `${prefix}Moderate ease`;
  if (v <= 90) return `${prefix}Strong ease`;
  return `${prefix}Max ease`;
});

function sampleCurve(progress: number): number { return sampleTimingEasing(progress, intensity.value, inverted.value); }

const startPoint = computed<{ x: number; y: number }>(() => ({ x: progressToX(0), y: easedToY(0) }));
const endPoint = computed<{ x: number; y: number }>(() => ({ x: progressToX(1), y: easedToY(1) }));
const handlePoint = computed<{ x: number; y: number }>(() => ({ x: progressToX(handleT), y: easedToY(sampleCurve(handleT)) }));

const currentPoint = computed<{ x: number; y: number }>(() => ({
  x: progressToX(props.progress),
  y: easedToY(sampleCurve(props.progress))
}));

const pathData = computed<string>(() => {
  const samples = [];
  const sampleCount = 64;
  for (let i = 0; i < sampleCount; i++) {
    const p = i / (sampleCount - 1);
    samples.push(`${i === 0 ? "M" : "L"} ${progressToX(p)} ${easedToY(sampleCurve(p))}`);
  }
  return samples.join(" ");
});

const linearPathData = computed<string>(() => {
  return `M ${progressToX(0)} ${easedToY(0)} L ${progressToX(1)} ${easedToY(1)}`;
});

const gridLines = computed<number[]>(() => {
  const values = [];
  for (let i = 0; i < 5; i++) {
    values.push(margin.top + (i / 4) * (height - margin.top - margin.bottom));
  }
  return values;
});

function updateCamera(nextValues: Partial<FormCamera>): void { emit("update-camera", { ...props.camera, ...nextValues }); }

function getLocalPoint(event: PointerEvent): { x: number; y: number } {
  const bounds = svgRef.value?.getBoundingClientRect();
  return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
}

function onPointerMove(event: PointerEvent): void {
  if (!dragState.value) return;
  const point = getLocalPoint(event);
  const eased = yToEased(point.y);
  const linear = handleT;
  const maxEased = easeInOutCubic(handleT);
  const easedRange = linear - maxEased;
  const isInv = inverted.value;
  const rawIntensity = easedRange > 0
    ? isInv
      ? (eased - linear) / easedRange
      : (linear - eased) / easedRange
    : 0;
  updateCamera({ timingCurve: Math.round(clamp(rawIntensity, 0, 1) * 100) });
}

function stopDrag(): void { dragState.value = null; }
function startDrag(event: PointerEvent): void { dragState.value = "handle"; onPointerMove(event); }

window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", stopDrag);
onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", stopDrag);
});
</script>

<template>
  <div class="timing-editor">
    <div class="curve-summary">
      <div class="curve-summary-item">
        <div class="label">Easing</div>
        <div class="value">{{ curveLabel }}</div>
      </div>
      <button
        class="btn btn-sm curve-invert-btn"
        :class="{ active: inverted }"
        title="Invert easing curve"
        aria-label="Invert easing curve"
        :aria-pressed="inverted"
        @click="updateCamera({ timingInverted: !inverted })"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 16V4m0 0L3 8m4-4l4 4" />
          <path d="M17 8v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      </button>
    </div>
    <svg ref="svgRef" class="curve-canvas" :viewBox="`0 0 ${width} ${height}`">
      <rect class="curve-bg" :x="0" :y="0" :width="width" :height="height" />
      <line v-for="lineY in gridLines" :key="lineY" class="curve-grid" :x1="margin.left" :x2="width - margin.right" :y1="lineY" :y2="lineY" />
      <line class="curve-axis" :x1="margin.left" :x2="margin.left" :y1="margin.top" :y2="height - margin.bottom" />
      <line class="curve-axis" :x1="margin.left" :x2="width - margin.right" :y1="height - margin.bottom" :y2="height - margin.bottom" />
      <line class="curve-linear-ref" :x1="progressToX(0)" :x2="progressToX(1)" :y1="easedToY(0)" :y2="easedToY(1)" />
      <line class="curve-progress" :x1="currentPoint.x" :x2="currentPoint.x" :y1="margin.top" :y2="height - margin.bottom" />
      <path class="curve-path" :d="pathData" />
      <line class="curve-guide" :x1="handlePoint.x" :x2="handlePoint.x" :y1="handlePoint.y" :y2="height - margin.bottom" />
      <circle class="curve-anchor" :cx="startPoint.x" :cy="startPoint.y" r="5" />
      <circle class="curve-anchor" :cx="endPoint.x" :cy="endPoint.y" r="5" />
      <circle class="curve-handle control" :cx="handlePoint.x" :cy="handlePoint.y" r="7" @pointerdown.prevent="startDrag($event)" />
      <circle class="curve-current" :cx="currentPoint.x" :cy="currentPoint.y" r="4" />
      <text class="curve-text" :x="margin.left" :y="height - 10">0%</text>
      <text class="curve-text" :x="width - margin.right - 22" :y="height - 10">100%</text>
      <text class="curve-text" :x="6" :y="margin.top + 4">End</text>
      <text class="curve-text" :x="12" :y="height - margin.bottom">Start</text>
    </svg>
    <div class="curve-note">Drag the handle to adjust easing. Diagonal = linear speed.</div>
  </div>
</template>
