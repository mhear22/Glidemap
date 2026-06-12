<script setup lang="ts">
const emit = defineEmits<{
  (e: "enter"): void;
  (e: "guide"): void;
}>();

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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
          <line x1="8" y1="2" x2="8" y2="18" />
          <line x1="16" y1="6" x2="16" y2="22" />
        </svg>
        MapAnim
      </div>
      <button type="button" class="btn btn-primary" @click="emit('enter')">Open the studio</button>
    </header>

    <main class="landing-main">
      <section class="landing-intro">
        <h1>Turn a route into a map flyover video</h1>
        <p>
          MapAnim animates the journey between two places — a smooth camera move that
          starts on the origin, pulls out to show the whole route, and lands on the
          destination — and renders it to MP4. It runs entirely on your machine.
        </p>
        <div class="landing-actions">
          <button type="button" class="btn btn-primary" @click="emit('enter')">Open the studio</button>
          <button type="button" class="btn" @click="emit('guide')">Read the guide</button>
        </div>
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
      <span>Built by Mika, <a href="https://z.ai/chat" target="_blank" rel="noreferrer">GLM</a>, and <a href="https://openai.com/codex" target="_blank" rel="noreferrer">Codex</a></span>
      <span>Map data &copy; OpenStreetMap contributors &middot; Imagery &copy; Esri &middot; Basemap &copy; CARTO</span>
    </footer>
  </div>
</template>
