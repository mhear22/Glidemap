<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import maplibregl from "maplibre-gl";
import type { ProviderSearchResult } from "../types.js";
import { ensureTileCacheReady } from "../tile-cache.js";

const props = withDefaults(defineProps<{
  open: boolean;
  label: string;
  query: string;
  results: ProviderSearchResult[];
  loading?: boolean;
}>(), {
  loading: false
});

const emit = defineEmits<{
  (e: "update:query", value: string): void;
  (e: "select", result: ProviderSearchResult): void;
  (e: "close"): void;
}>();

const mapContainer = ref<HTMLDivElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const highlightedId = ref<string | null>(null);

let map: maplibregl.Map | null = null;
let markers: maplibregl.Marker[] = [];

const standardStyle: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: "raster",
      tiles: ["/tiles/standard/{z}/{x}/{y}"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    }
  },
  layers: [
    {
      id: "carto-base",
      type: "raster",
      source: "carto"
    }
  ]
};

function createMarkerElement(result: ProviderSearchResult, index: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "search-marker";
  el.textContent = String(index + 1);
  el.dataset["resultId"] = result.id;
  el.addEventListener("click", (event: MouseEvent) => {
    event.stopPropagation();
    highlightedId.value = result.id;
  });
  return el;
}

function syncMarkers(): void {
  if (!map) return;

  for (const marker of markers) {
    marker.remove();
  }
  markers = [];

  if (!props.results.length) return;

  for (let i = 0; i < props.results.length; i++) {
    const result = props.results[i];
    if (!result) continue;
    const el = createMarkerElement(result, i);
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat(result.coords)
      .addTo(map);
    markers.push(marker);
  }

  const onlyResult = props.results.length === 1 ? props.results[0] : undefined;
  if (onlyResult) {
    map.flyTo({ center: onlyResult.coords, zoom: 12, duration: 600 });
  } else {
    const bounds = new maplibregl.LngLatBounds();
    for (const result of props.results) {
      bounds.extend(result.coords);
    }
    map.fitBounds(bounds, { padding: 60, duration: 600, maxZoom: 14 });
  }
}

async function initMap(): Promise<void> {
  if (!mapContainer.value) return;
  await ensureTileCacheReady();

  map = new maplibregl.Map({
    container: mapContainer.value,
    style: standardStyle,
    center: [0, 20],
    zoom: 2,
    attributionControl: false
  });

  map.on("load", () => {
    syncMarkers();
    if (searchInput.value) {
      searchInput.value.focus();
    }
  });
}

function destroyMap(): void {
  for (const marker of markers) {
    marker.remove();
  }
  markers = [];
  if (map) {
    map.remove();
    map = null;
  }
}

watch(() => props.open, async (isOpen: boolean) => {
  if (isOpen) {
    await nextTick();
    await initMap();
  } else {
    destroyMap();
    highlightedId.value = null;
  }
});

watch(() => props.results, () => {
  syncMarkers();
}, { deep: true });

function onInput(event: Event): void {
  if (event.target instanceof HTMLInputElement) {
    emit("update:query", event.target.value);
  }
}

function selectResult(result: ProviderSearchResult): void {
  emit("select", result);
}

function moveHighlight(step: 1 | -1): void {
  if (!props.results.length) return;
  const currentIndex = props.results.findIndex((result) => result.id === highlightedId.value);
  const nextIndex = currentIndex === -1
    ? (step === 1 ? 0 : props.results.length - 1)
    : (currentIndex + step + props.results.length) % props.results.length;
  highlightedId.value = props.results[nextIndex]?.id ?? null;
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveHighlight(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveHighlight(-1);
    return;
  }
  if (event.key === "Enter") {
    const highlighted = props.results.find((result) => result.id === highlightedId.value) ?? props.results[0];
    if (highlighted) {
      event.preventDefault();
      selectResult(highlighted);
    }
  }
}

watch(highlightedId, (id: string | null) => {
  if (!map) return;

  // Update marker styles
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const result = props.results[i];
    if (!marker) continue;
    const el = marker.getElement();
    if (result && result.id === id) {
      el.classList.add("highlighted");
      map.flyTo({ center: result.coords, zoom: Math.max(map.getZoom(), 6), duration: 400 });
    } else {
      el.classList.remove("highlighted");
    }
  }

  // Scroll result into view
  if (id) {
    const el = document.querySelector(`.search-modal-result[data-id="${id}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});

onBeforeUnmount(() => {
  destroyMap();
});
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal search-modal" role="dialog" aria-modal="true" :aria-label="`Select ${label}`">
      <div class="search-modal-header">
        <h3 class="modal-title">Select {{ label }}</h3>
        <button class="btn btn-sm" @click="$emit('close')" title="Close" aria-label="Close search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div class="search-modal-input-row">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref="searchInput"
          :value="query"
          class="text-input"
          placeholder="Search for a place"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="results.length > 0"
          @input="onInput"
          @keydown="onInputKeydown"
        />
        <div v-if="loading" class="search-spinner" />
      </div>
      <div class="search-modal-body">
        <div ref="mapContainer" class="search-modal-map" />
        <div class="search-modal-results" role="listbox" :aria-label="`${label} search results`">
          <div v-if="loading && !results.length" class="search-empty">Searching&hellip;</div>
          <div v-else-if="!results.length && query.length >= 3" class="search-empty">No results found</div>
          <div v-else-if="!results.length" class="search-empty">Type at least three characters</div>
          <button
            v-for="(result, index) in results"
            :key="result.id"
            :data-id="result.id"
            class="search-modal-result"
            :class="{ highlighted: highlightedId === result.id }"
            role="option"
            :aria-selected="highlightedId === result.id"
            @mouseenter="highlightedId = result.id"
            @click="selectResult(result)"
          >
            <span class="search-modal-result-index">{{ index + 1 }}</span>
            <span class="search-modal-result-label">{{ result.label }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
