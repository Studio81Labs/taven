<script setup lang="ts">
type PacketaPoint = Readonly<{ id?: unknown }>;

type PacketaWidget = Readonly<{
  pick: (
    accountId: string,
    callback: (point: PacketaPoint | null) => void,
    options?: Record<string, unknown>,
  ) => void;
  close?: () => void;
}>;

declare global {
  interface Window {
    Packeta?: { Widget?: PacketaWidget };
  }
}

const props = defineProps<{
  accountId: string;
  options: Record<string, unknown>;
  disabled?: boolean;
  selectedLabel?: string;
  onSelect: (destination: {
    providerEndpointId: string;
    endpointType: string;
  }) => Promise<boolean>;
}>();

const trigger = ref<HTMLButtonElement>();
const loading = ref(false);
const selecting = ref(false);
const errorMessage = ref<string>();
let selectionGeneration = 0;
let widgetLoading: Promise<PacketaWidget> | undefined;

onBeforeUnmount(() => {
  selectionGeneration += 1;
  window.Packeta?.Widget?.close?.();
});

async function openPicker(): Promise<void> {
  if (props.disabled || loading.value || selecting.value) return;
  errorMessage.value = undefined;
  loading.value = true;
  const generation = ++selectionGeneration;
  try {
    const widget = await loadWidget();
    if (generation !== selectionGeneration) return;
    widget.pick(
      props.accountId,
      (point) => {
        if (generation !== selectionGeneration) return;
        if (!point) {
          trigger.value?.focus();
          return;
        }
        const providerEndpointId = pointId(point);
        if (!providerEndpointId) {
          errorMessage.value =
            "Vybrané výdejní místo nemá platný identifikátor. Zkuste výběr znovu.";
          trigger.value?.focus();
          return;
        }
        void commitSelection(generation, providerEndpointId);
      },
      props.options,
    );
  } catch {
    if (generation === selectionGeneration) {
      errorMessage.value =
        "Výběr výdejního místa se nepodařilo načíst. Zkuste to prosím znovu nebo požádejte o individuální nabídku.";
    }
  } finally {
    if (generation === selectionGeneration) loading.value = false;
  }
}

function pointId(point: PacketaPoint): string {
  if (typeof point.id === "string") return point.id.trim();
  return typeof point.id === "number" && Number.isFinite(point.id)
    ? String(point.id)
    : "";
}

async function commitSelection(
  generation: number,
  providerEndpointId: string,
): Promise<void> {
  selecting.value = true;
  try {
    const accepted = await props.onSelect({
      providerEndpointId,
      endpointType: "pickup_point",
    });
    if (generation !== selectionGeneration) return;
    if (!accepted) {
      errorMessage.value =
        "Výdejní místo se nepodařilo ověřit. Vyberte jiné místo nebo akci opakujte.";
    }
  } catch {
    if (generation === selectionGeneration) {
      errorMessage.value =
        "Výdejní místo se nepodařilo ověřit. Zkuste to prosím znovu.";
    }
  } finally {
    if (generation === selectionGeneration) {
      selecting.value = false;
      trigger.value?.focus();
    }
  }
}

async function loadWidget(): Promise<PacketaWidget> {
  if (window.Packeta?.Widget) return window.Packeta.Widget;
  if (widgetLoading) return widgetLoading;
  document
    .querySelector<HTMLScriptElement>('script[data-taven-packeta-widget="v6"]')
    ?.remove();
  widgetLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://widget.packeta.com/v6/www/js/library.js";
    script.async = true;
    script.dataset.tavenPacketaWidget = "v6";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => {
        script.remove();
        reject(new Error("widget load failed"));
      },
      { once: true },
    );
    document.head.append(script);
  })
    .then(() => {
      if (!window.Packeta?.Widget) throw new Error("widget unavailable");
      return window.Packeta.Widget;
    })
    .finally(() => {
      widgetLoading = undefined;
    });
  return widgetLoading;
}
</script>

<template>
  <div class="delivery-picker">
    <p v-if="selectedLabel" class="selected-destination" aria-live="polite">
      Aktuálně vybráno: {{ selectedLabel }}
    </p>
    <button
      ref="trigger"
      class="secondary-button"
      type="button"
      :disabled="disabled || loading || selecting"
      @click="openPicker"
    >
      {{
        loading
          ? "Načítám výběr místa…"
          : selecting
            ? "Ověřuji místo…"
            : "Vybrat výdejní místo"
      }}
    </button>
    <p v-if="errorMessage" class="notice error-state" role="alert">
      {{ errorMessage }}
    </p>
    <NuxtLink
      v-if="errorMessage"
      class="text-button"
      :to="{ path: '/poptavka', query: { source: 'delivery-unavailable' } }"
    >
      Pokračovat individuální poptávkou
    </NuxtLink>
  </div>
</template>
