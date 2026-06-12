<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PreparedRoute } from "../types.js";
import type { RenderFrameMessage, RendererCommandMessage, RendererResponseMessage, SetSceneMessage } from "../../../types/web.js";

const props = defineProps<{
  route: PreparedRoute | null;
  progress: number;
}>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const ready = ref(false);
const sceneReady = ref(false);
let sceneSyncVersion = 0;

interface PendingEntry {
  resolve: () => void;
  reject: (reason: Error) => void;
}

const pending = new Map<string, PendingEntry>();

function createRequestId(): string {
  return `req-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

function toSerializableMessage(message: RendererCommandMessage): RendererCommandMessage {
  return JSON.parse(JSON.stringify(message)) as RendererCommandMessage;
}

function onMessage(event: MessageEvent<RendererResponseMessage>): void {
  if (event.origin !== window.location.origin) return;
  const payload = event.data;
  if (!payload || payload.namespace !== "mapanim") return;
  if (payload.type === "ready") { ready.value = true; return; }
  const entry = payload.requestId ? pending.get(payload.requestId) : undefined;
  if (!entry) return;
  pending.delete(payload.requestId!);
  if (payload.type === "command-error") { entry.reject(new Error(payload.message)); return; }
  entry.resolve();
}

function sendCommand(message: RendererCommandMessage): Promise<void> {
  if (!iframeRef.value?.contentWindow) return Promise.resolve();
  const promise = new Promise<void>((resolve, reject) => { pending.set(message.requestId, { resolve, reject }); });
  iframeRef.value.contentWindow.postMessage(toSerializableMessage(message), window.location.origin);
  return promise;
}

async function syncScene(scene: PreparedRoute): Promise<void> {
  const version = ++sceneSyncVersion;
  sceneReady.value = false;
  await nextTick();
  if (!ready.value || !scene) return;
  const setSceneMessage: SetSceneMessage = { namespace: "mapanim", requestId: createRequestId(), type: "set-scene", scene };
  const renderFrameMessage: RenderFrameMessage = { namespace: "mapanim", requestId: createRequestId(), type: "render-frame", progress: props.progress };
  await sendCommand(setSceneMessage);
  if (version !== sceneSyncVersion) return;
  await sendCommand(renderFrameMessage);
  if (version !== sceneSyncVersion) return;
  sceneReady.value = true;
}

watch(ready, async (value) => {
  if (!value || !props.route) return;
  try { await syncScene(props.route); } catch (error) { console.error(error); }
});

watch(() => props.route, async (scene) => {
  sceneReady.value = false;
  if (!scene) return;
  try { await syncScene(scene); } catch (error) { console.error(error); }
}, { deep: true });

watch(() => props.progress, async (value) => {
  if (!ready.value || !props.route || !sceneReady.value) return;
  try {
    const message: RenderFrameMessage = { namespace: "mapanim", requestId: createRequestId(), type: "render-frame", progress: value };
    await sendCommand(message);
  } catch (error) { console.error(error); }
});

onMounted(() => { window.addEventListener("message", onMessage); });
onBeforeUnmount(() => { window.removeEventListener("message", onMessage); });
</script>

<template>
  <div class="preview-frame-wrap">
    <iframe ref="iframeRef" title="Map animation preview" src="/render/" />
    <div v-if="!route" class="preview-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
        <line x1="8" y1="2" x2="8" y2="18" />
        <line x1="16" y1="6" x2="16" y2="22" />
      </svg>
      Search two locations to load a preview
    </div>
  </div>
</template>
