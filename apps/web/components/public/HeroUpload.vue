<script setup lang="ts">
import { publicSite } from "../../content/public-site";
import { formatFileSize } from "../../utils/model-file";

const {
  canUpload,
  cancelUpload,
  estimate,
  estimateLoading,
  estimateMessage,
  errorMessage,
  filename,
  geometry,
  handoffMessage,
  metadata,
  phase,
  persistCurrentSession,
  previewMessage,
  quote,
  resetState,
  retry,
  retryEstimate,
  selectFile,
  sessionPersisted,
  startUpload,
  uploadProgress,
} = useModelUploadQuote({
  preserveStoredSessionOnSelection: true,
  restoreSession: false,
});

const fileInput = ref<HTMLInputElement>();
const isDragging = ref(false);
const isBusy = computed(
  () => phase.value === "preparing" || phase.value === "uploading",
);
let leaving = false;

watch(
  [quote, phase, sessionPersisted],
  ([currentQuote, currentPhase, stored]) => {
    if (
      leaving ||
      !stored ||
      !currentQuote?.sessionId ||
      !["complete", "handoff", "inspecting"].includes(currentPhase)
    ) {
      return;
    }

    leaving = true;
    void navigateTo("/objednavka");
  },
);

async function acceptFile(file: File | null): Promise<void> {
  if (!file || isBusy.value) return;
  await selectFile(file);
}

function acceptFileList(files: FileList | null): void {
  void acceptFile(files?.item(0) ?? null);
}

function onFileChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  acceptFileList(input.files);
  input.value = "";
}

function onDrop(event: DragEvent): void {
  isDragging.value = false;
  acceptFileList(event.dataTransfer?.files ?? null);
}

function chooseAnotherFile(): void {
  resetState(false);
  nextTick(() => fileInput.value?.click());
}

function millimeters(value: number): string {
  return `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 }).format(value)} mm`;
}

function cubicCentimeters(value: number): string {
  return `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 }).format(value / 1_000)} cm³`;
}

function currency(value: number, code: string): string {
  return new Intl.NumberFormat("cs-CZ", {
    currency: code,
    style: "currency",
    maximumFractionDigits: 0,
  }).format(value / 100);
}
</script>

<template>
  <div
    class="border border-[#1a1a16] bg-[#efefea] p-5 shadow-[8px_8px_0_#d9d9d2] sm:p-7"
  >
    <label
      v-if="phase === 'idle'"
      class="flex min-h-64 cursor-pointer flex-col items-center justify-center border-2 border-dashed px-5 py-10 text-center transition-colors focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-[#1b44e8]"
      :class="
        isDragging
          ? 'border-[#1b44e8] bg-white'
          : 'border-[#6e6f66] bg-[#efefea] hover:border-[#1b44e8] hover:bg-white'
      "
      @dragenter.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <input
        ref="fileInput"
        accept=".stl,.3mf,model/stl,model/3mf"
        class="sr-only"
        type="file"
        @change="onFileChange"
      />
      <span class="font-mono text-sm font-semibold text-[#1b44e8]">
        STL / 3MF
      </span>
      <strong class="mt-5 text-xl">Přetáhni soubor sem</strong>
      <span class="mt-2 text-[#54554c]">nebo ho vyber z počítače</span>
      <span class="mt-6 font-mono text-xs text-[#66675f]">nejvýše 100 MiB</span>
    </label>

    <div
      v-else-if="isBusy"
      class="flex min-h-64 flex-col justify-center bg-white p-6"
      role="status"
      aria-live="polite"
    >
      <p class="font-mono text-xs tracking-wider text-[#1b44e8] uppercase">
        {{ phase === "preparing" ? "Kontrola souboru" : "Bezpečné nahrání" }}
      </p>
      <h2 class="mt-4 break-all text-2xl font-semibold">
        {{ filename ?? "Vybraný model" }}
      </h2>
      <p class="mt-3 text-[#54554c]">
        {{
          phase === "preparing"
            ? "Ověřujeme formát a geometrii přímo v prohlížeči."
            : `Nahráváme soubor — ${uploadProgress} %`
        }}
      </p>
      <progress
        v-if="phase === 'uploading'"
        class="mt-6 h-2 w-full accent-[#1b44e8]"
        :value="uploadProgress"
        max="100"
      >
        {{ uploadProgress }} %
      </progress>
      <button
        v-if="phase === 'uploading'"
        class="mt-6 self-start font-semibold underline decoration-[#1b44e8] decoration-2 underline-offset-4"
        type="button"
        @click="cancelUpload"
      >
        Zrušit nahrání
      </button>
    </div>

    <div
      v-else-if="phase === 'ready'"
      class="flex min-h-64 flex-col justify-center bg-white p-6"
      role="status"
      aria-live="polite"
    >
      <p class="font-mono text-xs tracking-wider text-[#1b44e8] uppercase">
        Soubor zkontrolován
      </p>
      <h2 class="mt-4 break-all text-2xl font-semibold">
        {{ filename ?? "Vybraný model" }}
      </h2>
      <p v-if="metadata" class="mt-2 font-mono text-sm text-[#66675f]">
        {{ metadata.format }} · {{ formatFileSize(metadata.sizeBytes) }}
      </p>
      <template v-if="geometry">
        <div class="mt-5 overflow-hidden border border-[#d9d9d2] bg-[#f7f7f3]">
          <ClientOnly>
            <LazyOrderModelPreview :geometry="geometry" />
            <template #fallback>
              <div class="grid min-h-64 place-items-center text-[#54554c]">
                Připravujeme náhled modelu.
              </div>
            </template>
          </ClientOnly>
        </div>
        <dl class="mt-4 grid gap-px bg-[#d9d9d2] sm:grid-cols-3">
          <div class="bg-[#efefea] p-3">
            <dt class="text-xs text-[#66675f]">Rozměry X × Y × Z</dt>
            <dd class="mt-1 font-mono text-xs">
              {{ millimeters(geometry.dimensions.width) }} ×
              {{ millimeters(geometry.dimensions.depth) }} ×
              {{ millimeters(geometry.dimensions.height) }}
            </dd>
          </div>
          <div class="bg-[#efefea] p-3">
            <dt class="text-xs text-[#66675f]">Objekty</dt>
            <dd class="mt-1 font-mono text-xs">
              {{ geometry.objectCount }}
            </dd>
          </div>
          <div class="bg-[#efefea] p-3">
            <dt class="text-xs text-[#66675f]">Objem modelu</dt>
            <dd class="mt-1 font-mono text-xs">
              ≈ {{ cubicCentimeters(geometry.volumeMm3) }}
            </dd>
          </div>
        </dl>
        <section
          class="mt-4 border border-[#1b44e8] bg-[#eef2ff] p-4"
          aria-live="polite"
        >
          <p class="font-mono text-xs tracking-wider text-[#1b44e8] uppercase">
            Nezávazný rychlý odhad
          </p>
          <p v-if="estimateLoading" class="mt-2 text-[#54554c]">
            Počítáme orientační cenu z rozměrů modelu.
          </p>
          <template v-else-if="estimate">
            <p class="mt-2 text-2xl font-semibold">
              {{
                currency(
                  estimate.price.totalMinor ?? 0,
                  estimate.price.currency,
                )
              }}
            </p>
            <p class="mt-2 text-sm text-[#54554c]">
              Odhad pro {{ estimate.assumptions.material }},
              {{ estimate.assumptions.quality.toLowerCase() }}, výplň
              {{ estimate.assumptions.infillPreset.toLowerCase() }} a 1 kus.
              Doprava ani závazná cena v něm nejsou zahrnuté.
            </p>
          </template>
          <template v-else>
            <p class="mt-2 text-sm text-[#54554c]">
              {{
                estimateMessage ??
                "Rychlý odhad zatím není dostupný. Rozměry zkontrolujte v původním programu."
              }}
            </p>
            <button
              class="mt-3 font-semibold underline decoration-[#1b44e8] decoration-2 underline-offset-4"
              type="button"
              @click="retryEstimate"
            >
              Zkusit odhad znovu
            </button>
          </template>
        </section>
      </template>
      <p v-else-if="previewMessage" class="mt-4 text-[#54554c]">
        {{ previewMessage }}
      </p>
      <div class="mt-7 flex flex-wrap items-center gap-5">
        <button
          class="inline-flex min-h-12 items-center bg-[#1b44e8] px-6 font-semibold text-white hover:bg-[#1536b8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a16] disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="
            !canUpload || !publicSite.commercial.automaticQuotePubliclyEnabled
          "
          type="button"
          @click="startUpload"
        >
          {{
            publicSite.commercial.automaticQuotePubliclyEnabled
              ? "Nahrát a pokračovat ke konfiguraci"
              : "Kalkulace čeká na schválení"
          }}
        </button>
        <button
          class="font-semibold underline decoration-[#1b44e8] decoration-2 underline-offset-4"
          type="button"
          @click="chooseAnotherFile"
        >
          Jiný soubor
        </button>
      </div>
    </div>

    <div
      v-else-if="quote?.sessionId && !sessionPersisted"
      class="flex min-h-64 flex-col justify-center bg-white p-6"
      role="alert"
    >
      <p class="font-mono text-xs tracking-wider text-[#1b44e8] uppercase">
        Pokračování pozastaveno
      </p>
      <h2 class="mt-4 text-2xl font-semibold">
        Nahrání je uložené, ale prohlížeč zablokoval dočasnou relaci.
      </h2>
      <p class="mt-3 text-[#54554c]">
        Zůstaň na této stránce, povol úložiště relace pro tento web a zkus
        pokračovat znovu.
      </p>
      <button
        class="mt-7 self-start font-semibold underline decoration-[#1b44e8] decoration-2 underline-offset-4"
        type="button"
        @click="persistCurrentSession"
      >
        Zkusit pokračovat
      </button>
    </div>

    <div
      v-else
      class="flex min-h-64 flex-col justify-center bg-white p-6"
      role="status"
      aria-live="polite"
    >
      <p class="font-mono text-xs tracking-wider text-[#1b44e8] uppercase">
        {{ phase === "handoff" ? "Individuální kontrola" : "Nahrání modelu" }}
      </p>
      <h2 class="mt-4 text-2xl font-semibold">
        {{
          phase === "handoff"
            ? "Tento soubor potřebuje ruční posouzení."
            : phase === "cancelled"
              ? "Nahrání bylo zrušeno."
              : "Soubor se nepodařilo připravit."
        }}
      </h2>
      <p class="mt-3 text-[#54554c]">
        {{ handoffMessage ?? errorMessage }}
      </p>
      <div class="mt-7 flex flex-wrap gap-5">
        <NuxtLink
          v-if="phase === 'handoff'"
          class="font-semibold underline decoration-[#1b44e8] decoration-2 underline-offset-4"
          :to="{
            path: '/poptavka',
            query: {
              source:
                metadata?.format === '3MF' ? 'blocked-3mf' : 'individual-file',
            },
          }"
          no-prefetch
        >
          Přejít na individuální poptávku
        </NuxtLink>
        <button
          v-if="(phase === 'error' || phase === 'cancelled') && metadata"
          class="font-semibold underline decoration-[#1b44e8] decoration-2 underline-offset-4"
          type="button"
          @click="retry"
        >
          Zkusit nahrání znovu
        </button>
        <button
          class="font-semibold underline decoration-[#1b44e8] decoration-2 underline-offset-4"
          type="button"
          @click="chooseAnotherFile"
        >
          Vybrat jiný soubor
        </button>
      </div>
    </div>

    <p class="mt-6 text-sm leading-6 text-[#54554c]">
      Výběrem souboru spustíš jeho místní kontrolu. Bezpečné nahrání potvrdíš po
      ověření formátu a rozměrů.
    </p>
    <p class="mt-2 text-sm leading-6 text-[#54554c]">
      Automatickou kalkulaci i hrubý odhad zveřejníme až ze schválených cenových
      vstupů. Soubor zatím můžeš bezpečně zkontrolovat jen v prohlížeči.
    </p>
    <NuxtLink
      class="mt-4 inline-block font-semibold text-[#1a1a16] underline decoration-[#1b44e8] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
      :to="{ path: '/poptavka', query: { source: 'no-file' } }"
      no-prefetch
    >
      Nemám soubor nebo potřebuji poradit
    </NuxtLink>
  </div>
</template>
