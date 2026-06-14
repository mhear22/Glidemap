<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

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
  (e: "close"): void;
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
const cardRef = ref<HTMLDivElement | null>(null);
const viewport = ref({ width: window.innerWidth, height: window.innerHeight });
const currentStep = computed(() => props.steps[index.value] ?? null);
const isLast = computed(() => index.value >= props.steps.length - 1);

// Fallback used only before the card has been measured for the first time.
const CARD_WIDTH_FALLBACK = 320;
const GAP = 12;

// Measured after each render; the fallbacks only apply before first measure.
const cardHeight = ref(190);
// Effective card width is content/CSS-driven (the CSS shrinks it below 380px),
// so we read it from the real element instead of trusting a hardcoded constant.
const cardWidth = ref(CARD_WIDTH_FALLBACK);

const cardStyle = computed<Record<string, string>>(() => {
  const { width: viewportWidth, height: viewportHeight } = viewport.value;
  const rect = spotlight.value;
  if (!rect) {
    return {
      top: `${Math.round(viewportHeight / 2 - cardHeight.value / 2)}px`,
      left: `${Math.round(viewportWidth / 2 - cardWidth.value / 2)}px`
    };
  }

  const left = Math.min(Math.max(rect.left, GAP), viewportWidth - cardWidth.value - GAP);
  let top = rect.top + rect.height + GAP;
  if (top + cardHeight.value > viewportHeight - GAP) {
    top = rect.top - cardHeight.value - GAP;
  }
  if (top < GAP) {
    top = Math.round(viewportHeight / 2 - cardHeight.value / 2);
  }
  return { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` };
});

// Read the card's real size (content/CSS-driven) and move keyboard focus into
// the dialog so tabbing doesn't land in the obscured page behind it.
async function syncCard(): Promise<void> {
  await nextTick();
  const card = cardRef.value;
  if (!card) return;
  const box = card.getBoundingClientRect();
  if (box.height > 0) cardHeight.value = box.height;
  if (box.width > 0) cardWidth.value = box.width;
  card.focus();
}

// ── Focus management ──────────────────────────────────────────────────────
// Element that had focus before the tour opened; focus is restored to it on close.
let previouslyFocused: HTMLElement | null = null;
// Elements outside the card we made inert while the tour is open (so we can undo it).
let inertElements: HTMLElement[] = [];

function focusableControls(): HTMLElement[] {
  const card = cardRef.value;
  if (!card) return [];
  return Array.from(
    card.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

// Make everything in the document inert except the tour card, so assistive tech
// and Tab can't reach the obscured page behind the spotlight. The card is
// mounted deep inside the app tree, so we walk from the card up to <body> and,
// at each level, inert every sibling that isn't on the path to the card.
function applyInert(): void {
  const card = cardRef.value;
  if (!card) return;
  inertElements = [];
  let node: HTMLElement | null = card;
  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      if (!(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
      inertElements.push(sibling);
    }
    node = parent;
  }
}

function releaseInert(): void {
  for (const node of inertElements) {
    node.removeAttribute("inert");
    node.removeAttribute("aria-hidden");
  }
  inertElements = [];
}

function trapTab(event: KeyboardEvent): void {
  const items = focusableControls();
  if (items.length === 0) {
    event.preventDefault();
    cardRef.value?.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (active === first || active === cardRef.value || !items.includes(active as HTMLElement)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    event.preventDefault();
    first.focus();
  }
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case "Tab":
      trapTab(event);
      break;
    case "Enter":
      // Let native button activation handle Enter when a control is focused,
      // so we don't double-fire (e.g. Enter on "Skip" closing AND advancing).
      if (document.activeElement instanceof HTMLButtonElement) return;
      event.preventDefault();
      next();
      break;
    case "ArrowRight":
      event.preventDefault();
      next();
      break;
    case "ArrowLeft":
      event.preventDefault();
      back();
      break;
    case "Escape":
      event.preventDefault();
      emit("close");
      break;
    default:
      break;
  }
}

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

let rafId: number | undefined;

function cancelScheduledMeasure(): void {
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    rafId = undefined;
  }
}

// The sidebar slides in/out on small screens (and other layout settles), which
// moves the targets. Rather than guessing a fixed delay tied to the CSS
// transition duration, re-measure on every animation frame until the target
// rect stops changing, then stop. This adapts automatically to whatever the
// real transition length is, with a safety cap so we never loop forever.
function scheduleMeasure(): void {
  cancelScheduledMeasure();

  let lastKey = "";
  let stableFrames = 0;
  const STABLE_FRAMES_REQUIRED = 3;
  const MAX_FRAMES = 60; // ~1s safety cap

  let frames = 0;
  const step = (): void => {
    rafId = undefined;
    measure();
    const rect = spotlight.value;
    const key = rect ? `${rect.top}|${rect.left}|${rect.width}|${rect.height}` : "none";
    stableFrames = key === lastKey ? stableFrames + 1 : 0;
    lastKey = key;
    frames += 1;
    if (stableFrames >= STABLE_FRAMES_REQUIRED || frames >= MAX_FRAMES) {
      cancelScheduledMeasure();
      return;
    }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

// Set up / tear down the document-level state that should exist only while the
// tour is on screen: captured focus, inert background, and keyboard handling.
function activateTour(): void {
  previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(() => {
    applyInert();
  });
  window.addEventListener("keydown", onKeydown);
}

function deactivateTour(): void {
  window.removeEventListener("keydown", onKeydown);
  cancelScheduledMeasure();
  releaseInert();
  const target = previouslyFocused;
  previouslyFocused = null;
  if (target && document.contains(target)) {
    target.focus();
  }
}

watch(
  () => props.open,
  (open, wasOpen) => {
    if (!open) {
      if (wasOpen) deactivateTour();
      return;
    }
    activateTour();
    if (index.value !== 0) {
      // The index watcher emits and measures; doing it here too would double-fire.
      index.value = 0;
      return;
    }
    emit("change", 0);
    scheduleMeasure();
    void syncCard();
  }
);

watch(index, (value) => {
  emit("change", value);
  scheduleMeasure();
  void syncCard();
});

function next(): void {
  if (isLast.value) {
    emit("close");
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
  viewport.value = { width: window.innerWidth, height: window.innerHeight };
  if (props.open) measure();
}

window.addEventListener("resize", onResize);
onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  if (props.open) deactivateTour();
  else cancelScheduledMeasure();
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
    <div ref="cardRef" class="tour-card" role="dialog" aria-modal="true" tabindex="-1" :aria-label="`Tour step ${index + 1} of ${steps.length}`" :style="cardStyle">
      <div class="tour-progress">{{ index + 1 }} / {{ steps.length }}</div>
      <h3>{{ currentStep.title }}</h3>
      <p>{{ currentStep.body }}</p>
      <div class="tour-actions">
        <button type="button" class="btn btn-sm" @click="emit('close')">Skip</button>
        <div class="tour-actions-right">
          <button v-if="index > 0" type="button" class="btn btn-sm" @click="back">Back</button>
          <button type="button" class="btn btn-sm btn-primary" @click="next">{{ isLast ? "Done" : "Next" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
