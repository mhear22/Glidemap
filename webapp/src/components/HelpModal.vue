<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { branding } from "../../../branding.js";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "tour"): void;
}>();

const modalRef = ref<HTMLDivElement | null>(null);

// Move keyboard focus into the dialog when it opens.
watch(() => props.open, async (open) => {
  if (!open) return;
  await nextTick();
  modalRef.value?.focus();
});
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div ref="modalRef" class="modal help-modal" role="dialog" aria-modal="true" tabindex="-1" :aria-label="`How to use ${branding.name}`">
      <div class="help-header">
        <h3 class="modal-title">How to use {{ branding.name }}</h3>
        <button type="button" class="btn btn-sm" title="Close" aria-label="Close help" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="help-body">
        <section>
          <h4>Making a render</h4>
          <ol class="help-list">
            <li><strong>Search the origin and destination.</strong> Click either location field to open the map picker, type at least three characters, and choose a result. The preview loads as soon as both are set.</li>
            <li><strong>Choose how to travel.</strong> Walking and driving follow real roads; flying draws a curved arc for long distances. Pick satellite or standard map style.</li>
            <li><strong>Tune the camera.</strong> The first curve controls how far the camera pulls out mid-flight; the second controls the pacing. Duration, smoothing, and lerp aggressiveness have exact inputs below the curves.</li>
            <li><strong>Preview the move.</strong> Press play under the map or drag the timeline to scrub. The first preview of a new area spends a few seconds caching map tiles.</li>
            <li><strong>Queue the render.</strong> The Queue button renders the animation to MP4. Watch progress under the queue icon in the header, and use Open MP4 when it completes.</li>
          </ol>
        </section>

        <section>
          <h4>Camera controls</h4>
          <ul class="help-list">
            <li><strong>Start / End</strong> — zoom level at the origin and destination. Click the values above the curve to edit them.</li>
            <li><strong>Farthest</strong> — how far the camera pulls out at the midpoint. 100% frames the whole route; lower stays closer, higher gives more air.</li>
            <li><strong>Zoom curve handle</strong> — drag to make the pull-out open up earlier or later.</li>
            <li><strong>Easing curve</strong> — bends time: more ease means gentle starts and landings. The arrows button inverts it.</li>
            <li><strong>Smoothing</strong> — irons out bends in the camera path without changing the drawn route.</li>
            <li><strong>Lerp aggressiveness</strong> — exact numeric control for how quickly the pull-out opens up; the zoom curve handle drags this same value.</li>
            <li><strong>Clip path to camera</strong> — draws the route line progressively behind the camera instead of all at once.</li>
          </ul>
        </section>

        <section>
          <h4>Extras</h4>
          <ul class="help-list">
            <li><strong>Avatar marker</strong> — upload an image in Route Setup and it travels along the route. Click the thumbnail to change its shape, size, and border.</li>
            <li><strong>Presets</strong> — Save stores the whole route setup; Load brings it back. Presets live in the <code>presets/</code> folder.</li>
            <li><strong>Render queue</strong> — renders run one at a time. Queued or running jobs can be cancelled with the &times; button.</li>
          </ul>
        </section>
      </div>

      <div class="modal-actions help-actions">
        <button type="button" class="btn" @click="emit('tour')">Show the tour</button>
        <button type="button" class="btn btn-primary" @click="emit('close')">Got it</button>
      </div>
    </div>
  </div>
</template>
