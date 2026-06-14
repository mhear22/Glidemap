<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { FormCamera, PreviewRouteLike } from "../types.js";

const props = withDefaults(defineProps<{
  camera: FormCamera;
  progress?: number;
  route?: PreviewRouteLike | null;
}>(), {
  progress: 0,
  route: null
});

const emit = defineEmits<{
  (e: "update-camera", value: FormCamera): void;
}>();

const editField = ref<string | null>(null);
const startZoomInput = ref<HTMLInputElement | null>(null);
const endZoomInput = ref<HTMLInputElement | null>(null);
const maxAltitudeInput = ref<HTMLInputElement | null>(null);

watch(editField, async (field) => {
  if (!field) return;
  await nextTick();
  if (field === "startZoom" && startZoomInput.value) startZoomInput.value.focus();
  if (field === "endZoom" && endZoomInput.value) endZoomInput.value.focus();
  if (field === "maxAltitude" && maxAltitudeInput.value) maxAltitudeInput.value.focus();
});

function commitZoom(field: "startZoom" | "endZoom", event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }

  const value = clamp(parseFloat(event.target.value) || 3, minZoom, maxZoom);
  updateCamera({ [field]: value } as Partial<FormCamera>);
}

function commitAlt(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }

  const value = clamp(Math.round(parseFloat(event.target.value) || 100), 50, 150);
  updateCamera({ maxAltitude: value });
}

function finishEdit(field: string, event: Event): void {
  if (field === "startZoom") commitZoom("startZoom", event);
  else if (field === "endZoom") commitZoom("endZoom", event);
  else if (field === "maxAltitude") commitAlt(event);
  editField.value = null;
}

const width = 360;
const height = 220;
const minZoom = 2.2;
const maxZoom = 18;
const minAggressivenessControl = 0.02;
const maxAggressivenessControl = 0.98;
const mercatorTileSize = 512;
const holdIn = 0.08;
const holdOut = 0.08;
const margin = { top: 22, right: 18, bottom: 32, left: 24 };
const dragState = ref<string | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);

function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(value, min), max); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const ratio = (value - inMin) / (inMax - inMin || 1);
  return outMin + ratio * (outMax - outMin);
}
function toRadians(value: number): number { return (value * Math.PI) / 180; }

function depthToY(depth: number): number { return mapRange(clamp(depth, 0, 1), 0, 1, margin.top, height - margin.bottom); }
function progressToX(progress: number): number { return mapRange(clamp(progress, 0, 1), 0, 1, margin.left, width - margin.right); }
function xToProgress(x: number): number { return mapRange(clamp(x, margin.left, width - margin.right), margin.left, width - margin.right, 0, 1); }

function toAggressivenessControl(aggressiveness: number = 50): number {
  return lerp(minAggressivenessControl, maxAggressivenessControl, clamp(aggressiveness, 0, 100) / 100);
}

function controlToAggressiveness(control: number): number {
  return Math.round(mapRange(clamp(control, minAggressivenessControl, maxAggressivenessControl), minAggressivenessControl, maxAggressivenessControl, 0, 100));
}

function sampleMirroredBlend(progress: number, aggressiveness: number = 50): number {
  const t = clamp(progress, 0, 1);
  const control = toAggressivenessControl(aggressiveness);
  return 2 * (1 - t) * t * control + t * t;
}

function projectMercator([lng, lat]: [number, number]): { x: number; y: number } {
  const sinLat = clamp(Math.sin(toRadians(lat)), -0.9999, 0.9999);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)
  };
}

function fitBoundsZoom(coordinates: [number, number][], viewportWidth: number, viewportHeight: number, maxZoomValue: number): number {
  if (!coordinates?.length) return maxZoomValue;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const coordinate of coordinates) {
    const projected = projectMercator(coordinate);
    minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
    minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
  }
  const dx = Math.max(maxX - minX, 1e-6);
  const dy = Math.max(maxY - minY, 1e-6);
  const zoomX = Math.log2(viewportWidth / (mercatorTileSize * dx));
  const zoomY = Math.log2(viewportHeight / (mercatorTileSize * dy));
  return clamp(Math.min(zoomX, zoomY, maxZoomValue), minZoom, maxZoom);
}

const routeCoordinates = computed<[number, number][]>(() => {
  const pathCoordinates = props.route?.path?.coordinates;
  if (pathCoordinates && pathCoordinates.length >= 2) {
    return pathCoordinates;
  }

  const fromCoords = props.route?.from?.coords;
  const toCoords = props.route?.to?.coords;
  if (fromCoords && toCoords) {
    return [fromCoords, toCoords];
  }

  return [];
});

const startZoom = computed<number>(() => clamp(Number(props.camera.startZoom ?? 15.8), minZoom, maxZoom));
const endZoom = computed<number>(() => clamp(Number(props.camera.endZoom ?? startZoom.value), minZoom, maxZoom));
const maxAltitude = computed<number>(() => clamp(Number(props.camera.maxAltitude ?? 100), 50, 150));
const aggressiveness = computed<number>(() => clamp(Number(props.camera.aggressiveness ?? 50), 0, 100));

const baseOverviewZoom = computed<number>(() => {
  const fallbackZoom = Math.max(minZoom, Math.max(startZoom.value, endZoom.value) - 1.6);
  if (!routeCoordinates.value.length) return fallbackZoom;
  const sceneWidth = Number(props.route?.width ?? 1920);
  const sceneHeight = Number(props.route?.height ?? 1080);
  const maxPadding = Math.max(24, Math.floor(Math.min(sceneWidth, sceneHeight) / 4) || 24);
  const paddingValue = Math.min(Number(props.route?.overviewPadding ?? 180), maxPadding);
  const viewportWidth = Math.max(80, sceneWidth - (paddingValue * 2 + 40));
  const viewportHeight = Math.max(80, sceneHeight - paddingValue * 2);
  return fitBoundsZoom(routeCoordinates.value, viewportWidth, viewportHeight, Math.max(startZoom.value, endZoom.value) - 0.8);
});

const peakZoom = computed<number>(() => {
  const closerZoom = Math.max(startZoom.value, endZoom.value);
  const requiredZoomOut = Math.max(0, closerZoom - baseOverviewZoom.value);
  return clamp(closerZoom - requiredZoomOut * (maxAltitude.value / 100), minZoom, maxZoom);
});

const taperPower = 2.5;

function sampleFullDepth(progress: number): number {
  const mapped = clamp(progress, 0, 1);
  const halfProgress = 1 - Math.abs(mapped - 0.5) * 2;
  const rawBlend = sampleMirroredBlend(halfProgress, aggressiveness.value);
  return 1 - Math.pow(1 - rawBlend, taperPower);
}

const startPoint = computed<{ x: number; y: number }>(() => ({ x: progressToX(0), y: depthToY(0) }));
const peakPoint = computed<{ x: number; y: number }>(() => ({ x: progressToX(0.5), y: depthToY(1) }));
const endPoint = computed<{ x: number; y: number }>(() => ({ x: progressToX(1), y: depthToY(0) }));
const handlePoint = computed<{ x: number; y: number }>(() => {
  return { x: progressToX(0.25), y: depthToY(sampleFullDepth(0.25)) };
});

const currentMapped = computed<number>(() => {
  return clamp((props.progress - holdIn) / (1 - holdIn - holdOut), 0, 1);
});

const currentPoint = computed<{ x: number; y: number }>(() => ({
  x: progressToX(currentMapped.value),
  y: depthToY(sampleFullDepth(currentMapped.value))
}));

const pathData = computed<string>(() => {
  const samples = [];
  const sampleCount = 96;
  for (let index = 0; index < sampleCount; index++) {
    const progress = index === 0 ? 0 : index / (sampleCount - 1);
    samples.push(`${index === 0 ? "M" : "L"} ${progressToX(progress)} ${depthToY(sampleFullDepth(progress))}`);
  }
  return samples.join(" ");
});

const gridLines = computed<number[]>(() => {
  const values = [];
  for (let index = 0; index < 5; index++) {
    values.push(margin.top + (index / 4) * (height - margin.top - margin.bottom));
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
  const fullProgress = xToProgress(point.x);
  const targetDepth = clamp(mapRange(point.y, startPoint.value.y, peakPoint.value.y || startPoint.value.y + 1, 0, 1), 0, 1);
  const halfProgress = 1 - Math.abs(fullProgress - 0.5) * 2;
  const rawBlend = 1 - Math.pow(1 - targetDepth, 1 / taperPower);
  const control = clamp(
    (rawBlend - halfProgress * halfProgress) / (2 * (1 - halfProgress) * halfProgress || 1),
    minAggressivenessControl,
    maxAggressivenessControl
  );
  updateCamera({ aggressiveness: controlToAggressiveness(control) });
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
  <div class="curve-editor">
    <div class="curve-summary">
      <div v-if="editField === 'startZoom'" class="curve-summary-item editable">
        <div class="label">Start</div>
        <input
          ref="startZoomInput"
          :value="camera.startZoom"
          class="curve-inline-input"
          type="number"
          min="3"
          max="18"
          step="0.1"
          @blur="finishEdit('startZoom', $event)"
          @keydown.enter="finishEdit('startZoom', $event)"
          @keydown.escape="editField = null"
        />
      </div>
      <button
        v-else
        type="button"
        class="curve-summary-item editable"
        aria-label="Edit start zoom"
        @click="editField = 'startZoom'"
      >
        <div class="label">Start</div>
        <div class="value">{{ camera.startZoom.toFixed(1) }}x</div>
      </button>
      <div v-if="editField === 'maxAltitude'" class="curve-summary-item editable">
        <div class="label">Farthest</div>
        <input
          ref="maxAltitudeInput"
          :value="camera.maxAltitude"
          class="curve-inline-input"
          type="number"
          min="50"
          max="150"
          step="1"
          @blur="finishEdit('maxAltitude', $event)"
          @keydown.enter="finishEdit('maxAltitude', $event)"
          @keydown.escape="editField = null"
        />
      </div>
      <button
        v-else
        type="button"
        class="curve-summary-item editable"
        aria-label="Edit farthest altitude"
        @click="editField = 'maxAltitude'"
      >
        <div class="label">Farthest</div>
        <div class="value">{{ peakZoom.toFixed(1) }}x @ {{ camera.maxAltitude }}%</div>
      </button>
      <div v-if="editField === 'endZoom'" class="curve-summary-item editable">
        <div class="label">End</div>
        <input
          ref="endZoomInput"
          :value="camera.endZoom"
          class="curve-inline-input"
          type="number"
          min="3"
          max="18"
          step="0.1"
          @blur="finishEdit('endZoom', $event)"
          @keydown.enter="finishEdit('endZoom', $event)"
          @keydown.escape="editField = null"
        />
      </div>
      <button
        v-else
        type="button"
        class="curve-summary-item editable"
        aria-label="Edit end zoom"
        @click="editField = 'endZoom'"
      >
        <div class="label">End</div>
        <div class="value">{{ camera.endZoom.toFixed(1) }}x</div>
      </button>
    </div>
    <svg ref="svgRef" class="curve-canvas" :viewBox="`0 0 ${width} ${height}`">
      <rect class="curve-bg" :x="0" :y="0" :width="width" :height="height" />
      <line v-for="lineY in gridLines" :key="lineY" class="curve-grid" :x1="margin.left" :x2="width - margin.right" :y1="lineY" :y2="lineY" />
      <line class="curve-axis" :x1="margin.left" :x2="margin.left" :y1="margin.top" :y2="height - margin.bottom" />
      <line class="curve-axis" :x1="margin.left" :x2="width - margin.right" :y1="height - margin.bottom" :y2="height - margin.bottom" />
      <line class="curve-progress" :x1="currentPoint.x" :x2="currentPoint.x" :y1="margin.top" :y2="height - margin.bottom" />
      <line class="curve-midline" :x1="peakPoint.x" :x2="peakPoint.x" :y1="margin.top" :y2="height - margin.bottom" />
      <path class="curve-path" :d="pathData" />
      <line class="curve-guide" :x1="handlePoint.x" :x2="handlePoint.x" :y1="handlePoint.y" :y2="height - margin.bottom" />
      <circle class="curve-anchor" :cx="startPoint.x" :cy="startPoint.y" r="5" />
      <circle class="curve-anchor" :cx="peakPoint.x" :cy="peakPoint.y" r="5" />
      <circle class="curve-anchor" :cx="endPoint.x" :cy="endPoint.y" r="5" />
      <circle class="curve-handle-hit" :cx="handlePoint.x" :cy="handlePoint.y" r="16" fill="transparent" @pointerdown.prevent="startDrag($event)" />
      <circle class="curve-handle control" :cx="handlePoint.x" :cy="handlePoint.y" r="7" @pointerdown.prevent="startDrag($event)" />
      <circle class="curve-current" :cx="currentPoint.x" :cy="currentPoint.y" r="4" />
      <text class="curve-text" :x="margin.left" :y="height - 10">Start</text>
      <text class="curve-text" :x="peakPoint.x - 8" :y="height - 10">Mid</text>
      <text class="curve-text" :x="width - margin.right - 14" :y="height - 10">End</text>
      <text class="curve-text" :x="6" :y="margin.top + 4">Near</text>
      <text class="curve-text" :x="12" :y="height - margin.bottom">Far</text>
    </svg>
    <div class="curve-note">Drag handle to adjust the zoom curve shape.</div>
  </div>
</template>

<style scoped>
/* Reset UA button styling so the <button> variant of .curve-summary-item
   stays pixel-identical to the original clickable div (global styles.css). */
button.curve-summary-item {
  display: block;
  width: 100%;
  margin: 0;
  font: inherit;
  color: inherit;
  appearance: none;
  -webkit-appearance: none;
}

/* Invisible larger touch target behind the visible drag handle. */
.curve-handle-hit {
  cursor: grab;
}

.curve-handle-hit:active {
  cursor: grabbing;
}

@media (pointer: coarse) {
  .curve-handle-hit {
    r: 22px;
  }
}
</style>
