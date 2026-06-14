<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
const inputRef = ref<HTMLInputElement | null>(null);
// Locally suppress the committed chip while the user re-edits, even though the
// parent still holds the previously selected label.
const editing = ref(false);

const committed = computed<boolean>(() => !editing.value && props.selectedLabel.trim().length > 0);

// A fresh selection (e.g. via the search modal) confirms the choice — surface
// the committed chip again even if the user had started re-editing.
watch(() => props.selectedLabel, () => { editing.value = false; });

function clearSelection(): void {
  editing.value = true;
  emit("update:modelValue", "");
  open.value = true;
  emit("open-modal");
  void Promise.resolve().then(() => inputRef.value?.focus());
}

const showDropdown = computed<boolean>(() => {
  if (props.modalActive) return false;
  return open.value && (props.loading || props.results.length > 0 || props.modelValue.trim().length >= 3);
});

function onInput(event: Event): void {
  if (event.target instanceof HTMLInputElement) {
    editing.value = true;
    emit("update:modelValue", event.target.value);
  }
}

function onBlur(): void {
  window.setTimeout(() => { open.value = false; }, 120);
}

function chooseResult(result: ProviderSearchResult): void {
  emit("select", result);
  editing.value = false;
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
          ref="inputRef"
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
    <div v-if="committed" class="selection-chip" role="status">
      <svg class="selection-chip-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span class="selection-chip-label">{{ selectedLabel }}</span>
      <button
        type="button"
        class="selection-chip-clear"
        :aria-label="`Clear selected place ${selectedLabel}`"
        @mousedown.prevent
        @click="clearSelection"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <div v-else class="field-hint">
      Type at least three characters
    </div>
  </label>
</template>

<style scoped>
/* A committed selection reads as a filled, confirmed chip — visually distinct
   from the plain "type at least three characters" hint. */
.selection-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin-top: 4px;
  padding: 4px 6px 4px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  color: var(--accent, #2f9e44);
  font-size: 0.82rem;
  line-height: 1.2;
}

.selection-chip-check {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
}

.selection-chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.selection-chip-clear {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.75;
}

.selection-chip-clear:hover,
.selection-chip-clear:focus-visible {
  opacity: 1;
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.selection-chip-clear svg {
  width: 12px;
  height: 12px;
}

@media (pointer: coarse) {
  .selection-chip-clear {
    width: 28px;
    height: 28px;
  }
}
</style>
