<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

export interface TourStep {
  target: string;
  title: string;
  body: string;
  sidebar?: boolean;
}

const props = defineProps<{
  open: boolean;
  steps: TourStep[];
}>();

const emit = defineEmits<{
  (e: "close", completed: boolean): void;
  (e: "change", index: number): void;
}>();

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const index = ref(0);
const spotlight = ref<SpotlightRect | null>(null);
const currentStep = computed(() => props.steps[index.value] ?? null);
const isLast = computed(() => index.value >= props.steps.length - 1);

const CARD_WIDTH = 320;
const CARD_HEIGHT = 190;
const GAP = 12;

const cardStyle = computed<Record<string, string>>(() => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = spotlight.value;
  if (!rect) {
    return {
      top: `${Math.round(viewportHeight / 2 - CARD_HEIGHT / 2)}px`,
      left: `${Math.round(viewportWidth / 2 - CARD_WIDTH / 2)}px`
    };
  }

  const left = Math.min(Math.max(rect.left, GAP), viewportWidth - CARD_WIDTH - GAP);
  let top = rect.top + rect.height + GAP;
  if (top + CARD_HEIGHT > viewportHeight - GAP) {
    top = rect.top - CARD_HEIGHT - GAP;
  }
  if (top < GAP) {
    top = Math.round(viewportHeight / 2 - CARD_HEIGHT / 2);
  }
  return { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` };
});

function measure(): void {
  const step = currentStep.value;
  const element = step ? document.querySelector(step.target) : null;
  if (!element) {
    spotlight.value = null;
    return;
  }
  const rect = element.getBoundingClientRect();
  const pad = 6;
  spotlight.value = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2
  };
}

let measureTimer: ReturnType<typeof setTimeout> | undefined;

// The sidebar slides in on small screens, so measure once immediately and
// again after its transition has finished.
function scheduleMeasure(): void {
  measure();
  window.clearTimeout(measureTimer);
  measureTimer = window.setTimeout(measure, 320);
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    index.value = 0;
    emit("change", 0);
    scheduleMeasure();
  }
);

watch(index, (value) => {
  emit("change", value);
  scheduleMeasure();
});

function next(): void {
  if (isLast.value) {
    emit("close", true);
    return;
  }
  index.value += 1;
}

function back(): void {
  if (index.value > 0) {
    index.value -= 1;
  }
}

function onResize(): void {
  if (props.open) measure();
}

window.addEventListener("resize", onResize);
onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  window.clearTimeout(measureTimer);
});
</script>

<template>
  <div v-if="open && currentStep" class="tour-layer">
    <div
      v-if="spotlight"
      class="tour-spotlight"
      :style="{
        top: `${spotlight.top}px`,
        left: `${spotlight.left}px`,
        width: `${spotlight.width}px`,
        height: `${spotlight.height}px`
      }"
    />
    <div v-else class="tour-backdrop" />
    <div class="tour-card" role="dialog" aria-modal="true" :aria-label="`Tour step ${index + 1} of ${steps.length}`" :style="cardStyle">
      <div class="tour-progress">{{ index + 1 }} / {{ steps.length }}</div>
      <h3>{{ currentStep.title }}</h3>
      <p>{{ currentStep.body }}</p>
      <div class="tour-actions">
        <button type="button" class="btn btn-sm" @click="emit('close', false)">Skip</button>
        <div class="tour-actions-right">
          <button v-if="index > 0" type="button" class="btn btn-sm" @click="back">Back</button>
          <button type="button" class="btn btn-sm btn-primary" @click="next">{{ isLast ? "Done" : "Next" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
