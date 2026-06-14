<script setup lang="ts">
import { onMounted, ref } from "vue";
import BrandMark from "./BrandMark.vue";
import { branding, creditJoiner } from "../../../branding.js";

const emit = defineEmits<{
  (e: "enter"): void;
  (e: "guide"): void;
  (e: "toggle-theme"): void;
}>();

const reelRef = ref<HTMLVideoElement | null>(null);
const reelPaused = ref(false);

// WCAG 2.2.2: looping motion must be pausable and respect reduced-motion.
onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches && reelRef.value) {
    reelRef.value.pause();
    reelPaused.value = true;
  }
});

function toggleReel(): void {
  const video = reelRef.value;
  if (!video) return;
  if (video.paused) {
    void video.play();
    reelPaused.value = false;
  } else {
    video.pause();
    reelPaused.value = true;
  }
}

const steps = [
  {
    title: "Pick two places",
    body: "Search any origin and destination. Routes follow real walking and driving paths, or a curved flight arc for long hops."
  },
  {
    title: "Shape the camera",
    body: "Set start and end zoom, how far the camera pulls out mid-flight, and the easing of the move with two small curve editors."
  },
  {
    title: "Preview it live",
    body: "The map preview updates as you type. Scrub the timeline or press play to watch the exact move before rendering."
  },
  {
    title: "Queue the render",
    body: "One click renders the animation frame by frame and encodes it to MP4. Track progress in the queue and open the file when it finishes."
  }
];

const features = [
  { name: "Place search", body: "Geocoding and routing backed by OpenStreetMap." },
  { name: "Camera curve editor", body: "Drag the zoom and easing curves instead of guessing numbers." },
  { name: "Satellite and standard maps", body: "Esri imagery or a clean CARTO basemap." },
  { name: "Avatar marker", body: "Put a face on the route — your own image travels the path." },
  { name: "Presets", body: "Save a route setup and load it back later." },
  { name: "Render queue", body: "Sequential renders with live progress and cancellation." }
];
</script>

<template>
  <div class="landing">
    <header class="landing-header">
      <div class="app-logo">
        <BrandMark />
      </div>
      <div class="header-actions">
        <button type="button" class="btn btn-sm theme-toggle landing-theme-toggle" aria-label="Toggle theme" @click="$emit('toggle-theme')">
          <svg class="theme-icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg class="theme-icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
        </button>
        <button type="button" class="btn btn-primary" @click="emit('enter')">Open the studio</button>
      </div>
    </header>

    <main class="landing-main">
      <section class="landing-intro">
        <h1>{{ branding.tagline }}</h1>
        <p>
          {{ branding.name }} animates the journey between two places — a smooth camera move that
          starts on the origin, pulls out to show the whole route, and lands on the
          destination — and renders it to MP4. It runs entirely on your machine.
        </p>
        <div class="landing-actions">
          <button type="button" class="btn btn-primary" @click="emit('enter')">Open the studio</button>
          <button type="button" class="btn" @click="emit('guide')">Read the guide</button>
        </div>
      </section>

      <section class="landing-reel">
        <video ref="reelRef" src="/about-reel.mp4" autoplay muted loop playsinline :aria-label="`Reel of ${branding.name} renders`" />
        <button type="button" class="landing-reel-toggle" :aria-label="reelPaused ? 'Play reel' : 'Pause reel'" @click="toggleReel">
          <svg v-if="reelPaused" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3" /></svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="5" y="3" width="4" height="18" /><rect x="15" y="3" width="4" height="18" /></svg>
        </button>
        <p class="landing-reel-caption">
          Straight out of the renderer: a satellite walk through Melbourne, a custom avatar crossing London, a drive across Paris, and a Melbourne&ndash;Sydney flight arc.
        </p>
      </section>

      <section class="landing-section">
        <h2>How it works</h2>
        <ol class="landing-steps">
          <li v-for="(step, index) in steps" :key="step.title">
            <span class="landing-step-number">{{ index + 1 }}</span>
            <div>
              <strong>{{ step.title }}</strong>
              <p>{{ step.body }}</p>
            </div>
          </li>
        </ol>
      </section>

      <section class="landing-section">
        <h2>Features</h2>
        <ul class="landing-features">
          <li v-for="feature in features" :key="feature.name">
            <strong>{{ feature.name }}</strong>
            <p>{{ feature.body }}</p>
          </li>
        </ul>
      </section>

      <section class="landing-section">
        <h2>Local by design</h2>
        <p class="landing-note">
          Rendering happens on your computer with a headless browser and ffmpeg.
          Nothing is uploaded anywhere: searches go to OpenStreetMap, map tiles are
          cached locally, and the finished videos stay in your output folder.
        </p>
      </section>
    </main>

    <footer class="landing-footer">
      <span>
        Built by
        <template v-for="(credit, index) in branding.builtBy" :key="credit.name">
          <template v-if="index > 0">{{ creditJoiner(index, branding.builtBy.length) }}</template>
          <a v-if="credit.url" :href="credit.url" target="_blank" rel="noreferrer">{{ credit.name }}</a>
          <template v-else>{{ credit.name }}</template>
        </template>
      </span>
      <span>Map data &copy; OpenStreetMap contributors &middot; Imagery &copy; Esri &middot; Basemap &copy; CARTO</span>
    </footer>
  </div>
</template>

<style scoped>
/* Theme toggle: mirror the studio behaviour (sun in dark mode, moon in light)
   without owning any state — derive the visible icon from the document theme. */
.landing-theme-toggle .theme-icon-sun,
.landing-theme-toggle .theme-icon-moon {
  display: none;
}
:root[data-theme="dark"] .landing-theme-toggle .theme-icon-sun {
  display: inline;
}
:root[data-theme="light"] .landing-theme-toggle .theme-icon-moon {
  display: inline;
}
/* Fallback when no explicit theme is set (default is dark). */
:root:not([data-theme="light"]) .landing-theme-toggle .theme-icon-sun {
  display: inline;
}
:root:not([data-theme="light"]) .landing-theme-toggle .theme-icon-moon {
  display: none;
}

/* WCAG 2.5.8: enlarge the reel toggle hit area on coarse pointers to 44px,
   keeping the visible icon size unchanged. */
@media (pointer: coarse) {
  .landing-reel-toggle {
    min-width: 44px;
    min-height: 44px;
  }
}
</style>
