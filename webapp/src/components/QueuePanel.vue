<script setup lang="ts">
import type { SerializedJob } from "../types.js";

defineProps<{
  jobs: SerializedJob[];
}>();

const emit = defineEmits<{
  cancel: [jobId: string];
}>();

function describeProgress(job: SerializedJob): string {
  if (!job.progress) return job.stage;
  if (job.progress.frame != null) return `${job.progress.frame}/${job.progress.totalFrames ?? 0} frames`;
  if (typeof job.progress.percent === "number") return `${Math.round(job.progress.percent)}%`;
  return job.stage;
}

function routeLine(job: SerializedJob): string {
  const start = job.summary?.startLabel || "Unknown start";
  const end = job.summary?.endLabel || "Unknown end";
  return `${start} → ${end}`;
}

function isCancellable(job: SerializedJob): boolean {
  return job.status === "queued" || job.status === "running";
}
</script>

<template>
  <div class="queue-dropdown" @click.stop>
    <div class="queue-dropdown-header">
      <span>Render Queue</span>
      <span class="queue-count">{{ jobs.length }} job{{ jobs.length === 1 ? '' : 's' }}</span>
    </div>
    <div v-if="!jobs.length" class="queue-empty">No render jobs queued yet.</div>
    <div v-else class="queue-dropdown-list">
      <article
        v-for="job in jobs"
        :key="job.id"
        class="queue-item"
        :data-status="job.status"
      >
        <div class="queue-item-title">{{ job.summary?.name || routeLine(job) }}</div>
        <div class="queue-item-route">{{ routeLine(job) }}</div>
        <div class="queue-item-row">
          <span>{{ job.summary?.mode || "walking" }} &middot; {{ job.summary?.mapType || "satellite" }}</span>
          <span class="queue-status-badge" :class="job.status">{{ job.status }}</span>
        </div>
        <div class="queue-item-row">
          <span>{{ job.stage }}</span>
          <span>{{ describeProgress(job) }}</span>
        </div>
        <div v-if="typeof job.progress?.percent === 'number'" class="queue-bar">
          <div class="queue-bar-fill" :style="{ width: `${Math.max(4, job.progress.percent)}%` }" />
        </div>
        <div v-if="job.error" class="queue-error">{{ job.error }}</div>
        <div class="queue-item-actions">
          <button
            v-if="isCancellable(job)"
            type="button"
            class="queue-cancel-btn"
            title="Cancel render"
            aria-label="Cancel render"
            @click="emit('cancel', job.id)"
          >&times;</button>
          <a
            v-if="job.result?.outputUrl"
            class="queue-link"
            :href="job.result.outputUrl"
            target="_blank"
            rel="noreferrer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
            Open MP4
          </a>
        </div>
      </article>
    </div>
  </div>
</template>
