<script setup lang="ts">
import { computed, ref } from "vue";
import type { ProviderSearchResult } from "../types.js";

const props = withDefaults(defineProps<{
  label: string;
  modelValue: string;
  results: ProviderSearchResult[];
  loading?: boolean;
  selectedLabel?: string;
  modalActive?: boolean;
}>(), {
  loading: false,
  selectedLabel: "",
  modalActive: false
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "select", result: ProviderSearchResult): void;
  (e: "open-modal"): void;
}>();
const open = ref(false);

const showDropdown = computed<boolean>(() => {
  if (props.modalActive) return false;
  return open.value && (props.loading || props.results.length > 0 || props.modelValue.trim().length >= 3);
});

function onInput(event: Event): void {
  if (event.target instanceof HTMLInputElement) {
    emit("update:modelValue", event.target.value);
  }
}

function onBlur(): void {
  window.setTimeout(() => { open.value = false; }, 120);
}

function chooseResult(result: ProviderSearchResult): void {
  emit("select", result);
  open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  const firstResult = props.results[0];
  if (event.key === "Enter" && showDropdown.value && firstResult) {
    event.preventDefault();
    chooseResult(firstResult);
  }
  if (event.key === "Escape" && open.value) {
    event.stopPropagation();
    open.value = false;
  }
}
</script>

<template>
  <label class="field">
    <span class="field-label">{{ label }}</span>
    <div class="search-wrapper">
      <div class="search-input-row">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          :value="modelValue"
          class="text-input"
          placeholder="Search for a place"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="showDropdown"
          :aria-label="label"
          @focus="open = true; emit('open-modal')"
          @blur="onBlur"
          @input="onInput"
          @keydown="onKeydown"
        />
        <div v-if="loading" class="search-spinner" />
      </div>
      <div v-if="showDropdown" class="search-results">
        <div v-if="loading" class="search-empty">Searching&hellip;</div>
        <template v-else>
          <button
            v-for="result in results"
            :key="result.id"
            class="search-result"
            type="button"
            @mousedown.prevent
            @click="chooseResult(result)"
          >
            {{ result.label }}
          </button>
          <div v-if="!results.length" class="search-empty">No results found</div>
        </template>
      </div>
    </div>
    <div class="field-hint">
      {{ selectedLabel || "Type at least three characters" }}
    </div>
  </label>
</template>
