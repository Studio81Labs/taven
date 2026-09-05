<script setup lang="ts">
import { formatFileSize } from "../../utils/model-file";
import {
  sanitizeAssistedQuoteHandoff,
  saveAssistedQuoteHandoff,
  type AssistedQuoteEntrySource,
} from "../../utils/assisted-quote-context";
import { getSessionStorage } from "../../utils/quote-session-storage";

definePageMeta({ middleware: "automatic-pricing-gate" });

usePublicPageMeta({
  path: "/objednavka",
  title: "Nahrát model",
  description:
    "Bezpečné nahrání STL nebo 3MF pro kontrolu a nacenění 3D tisku.",
  noindex: true,
});

const {
  addingModel,
  canUpload,
  cancelAdditionalModel,
  cancelUpload,
  commandError,
  commandPending,
  decideRisk,
  errorMessage,
  filename,
  geometry,
  handoffMessage,
  metadata,
  phase,
  previewMessage,
  prepareQuote,
  quote,
  refreshQuote,
  replaceConfiguration,
  resetState,
  retry,
  selectAdditionalFile,
  selectDestination,
  selectFile,
  setExpress,
  startUpload,
  uploadProgress,
} = useModelUploadQuote();
const fileInput = ref<HTMLInputElement>();
const additionalFileInput = ref<HTMLInputElement>();
const isDragging = ref(false);
const showConfigurator = computed(
  () =>
    Boolean(quote.value) &&
    (phase.value === "complete" ||
      (phase.value === "inspecting" && quote.value!.items.length > 0)),
);
const activeProcessStep = computed(() => {
  if (!quote.value) return 1;
  if (quote.value.phase === "CHECKOUT_READY") return 4;
  if (
    quote.value.phase === "DESTINATION_REQUIRED" ||
    quote.value.phase === "ELIGIBILITY_PENDING"
  )
    return 3;
  return 2;
});

const pipeline = computed(() => {
  const quotePhase = quote.value?.phase;
  let doneBefore = 0;
  let active = -1;
  if (phase.value === "preparing" || phase.value === "uploading") active = 0;
  else if (phase.value === "ready") doneBefore = 1;
  else if (quotePhase === "INSPECTION_PENDING") {
    doneBefore = 1;
    active = 1;
  } else if (quotePhase === "REFERENCE_SLICES_PENDING") {
    doneBefore = 2;
    active = 2;
  } else if (quotePhase === "ELIGIBILITY_PENDING") {
    doneBefore = 3;
    active = 3;
  } else if (quotePhase === "CHECKOUT_READY") doneBefore = 4;
  else if (quotePhase === "CONFIGURATION_REQUIRED") doneBefore = 2;
  else if (quotePhase) doneBefore = 3;

  return [
    "Načtení souboru",
    "Kontrola geometrie",
    "Slicing a dráhy",
    "Výpočet ceny",
  ].map((label, index) => ({
    label,
    status:
      index < doneBefore ? "done" : index === active ? "active" : "pending",
  }));
});

const progressCopy = computed(() => {
  if (quote.value?.phase === "REFERENCE_SLICES_PENDING") {
    return {
      detail:
        "Geometrie je zkontrolovaná. Připravujeme referenční tiskové dráhy.",
      title: "Připravujeme slicing a dráhy",
    };
  }
  if (quote.value?.phase === "ELIGIBILITY_PENDING") {
    return {
      detail: "Ověřujeme poslední podklady pro závaznou cenu.",
      title: "Dokončujeme výpočet ceny",
    };
  }
  return {
    detail:
      "Soubor je bezpečně nahraný. Kontrolujeme geometrii a připravujeme podklady pro konfiguraci.",
    title: inspectionLabel(quote.value?.modelFiles[0]?.inspectionStatus),
  };
});

const previewDescription = computed(() => {
  if (!geometry.value) return "Náhled modelu není k dispozici.";
  const dimensions = geometry.value.dimensions;
  return `Model má rozměry ${millimeters(dimensions.width)} × ${millimeters(dimensions.depth)} × ${millimeters(dimensions.height)} a obsahuje ${geometry.value.objectCount} ${geometry.value.objectCount === 1 ? "těleso" : "tělesa"}.`;
});

function millimeters(value: number): string {
  return `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 }).format(value)} mm`;
}

function cubicCentimeters(value: number): string {
  return `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 }).format(value / 1_000)} cm³`;
}

function selectFromList(files: FileList | null): void {
  const file = files?.item(0);
  if (file) void selectFile(file);
}

function onFileChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  selectFromList(input.files);
  input.value = "";
}

function onAdditionalFileChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.item(0);
  if (file) void selectAdditionalFile(file);
  input.value = "";
}

function onDrop(event: DragEvent): void {
  isDragging.value = false;
  selectFromList(event.dataTransfer?.files ?? null);
}

function chooseAnotherFile(): void {
  resetState();
  nextTick(() => fileInput.value?.click());
}

function chooseAdditionalFile(): void {
  additionalFileInput.value?.click();
}

function openAssistedQuote(): void {
  let source: AssistedQuoteEntrySource = "individual-file";
  const activeQuote = quote.value;
  if (activeQuote?.handoff && import.meta.client) {
    const storage = getSessionStorage(window);
    const context = sanitizeAssistedQuoteHandoff(
      activeQuote.handoff,
      activeQuote.expiresAt,
    );
    if (storage && context && saveAssistedQuoteHandoff(storage, context)) {
      source = "automatic-quote";
    }
  } else if (metadata.value?.format === "3MF") {
    source = "blocked-3mf";
  }
  void navigateTo({ path: "/poptavka", query: { source } });
}

function inspectionLabel(status: string | undefined): string {
  const labels: Record<string, string> = {
    FAILED: "Kontrola se nezdařila",
    PENDING: "Kontrola probíhá",
    SUCCEEDED: "Geometrie zkontrolována",
    UNSUPPORTED: "Model vyžaduje individuální kontrolu",
  };
  return labels[status ?? ""] ?? "Čekáme na kontrolu";
}
</script>

<template>
  <div class="application-page">
    <header class="application-header">
      <NuxtLink class="wordmark" to="/" aria-label="Taven, úvodní stránka">
        <PublicBrandMark />
      </NuxtLink>
      <nav aria-label="Průběh objednávky" class="process-nav">
        <ol>
          <li :aria-current="activeProcessStep === 1 ? 'step' : undefined">
            <span>01</span> SOUBOR
          </li>
          <li :aria-current="activeProcessStep === 2 ? 'step' : undefined">
            <span>02</span> KONFIGURACE
          </li>
          <li :aria-current="activeProcessStep === 3 ? 'step' : undefined">
            <span>03</span> DOPRAVA
          </li>
          <li :aria-current="activeProcessStep === 4 ? 'step' : undefined">
            <span>04</span> PLATBA
          </li>
          <li><span>05</span> VÝROBA</li>
        </ol>
      </nav>
    </header>

    <main class="order-layout">
      <section
        class="order-workspace"
        :aria-labelledby="
          showConfigurator ? 'configurator-title' : 'upload-title'
        "
      >
        <div v-if="!showConfigurator" class="section-heading">
          <p class="eyebrow">
            {{ addingModel ? "DALŠÍ SOUBOR" : "01 / SOUBOR" }}
          </p>
          <h1 id="upload-title">
            {{
              addingModel ? "Přidejte další model." : "Nahrajte model pro tisk."
            }}
          </h1>
          <p>
            Přijímáme STL a jednovrstvý, nebarvený 3MF. Rozměry ověříme v
            prohlížeči a po nahrání model zkontrolujeme na serveru.
          </p>
        </div>

        <div v-if="phase === 'idle'" class="upload-card">
          <label
            class="drop-zone"
            :class="{ 'is-dragging': isDragging }"
            @dragenter.prevent="isDragging = true"
            @dragleave.prevent="isDragging = false"
            @dragover.prevent
            @drop.prevent="onDrop"
          >
            <input
              ref="fileInput"
              accept=".stl,.3mf,model/stl,model/3mf"
              class="visually-hidden"
              type="file"
              @change="onFileChange"
            />
            <span class="drop-code" aria-hidden="true">STL / 3MF</span>
            <strong>Přetáhněte soubor sem</strong>
            <span>nebo vyberte soubor z počítače</span>
            <span class="file-limit">nejvýše 100 MiB</span>
          </label>
          <div class="assisted-entry">
            <p>
              Nemáte model, potřebujete poradit nebo chcete díl vytvořit podle
              fotografie?
            </p>
            <NuxtLink
              class="text-button"
              :to="{ path: '/poptavka', query: { source: 'no-file' } }"
            >
              Přejít na individuální poptávku
            </NuxtLink>
          </div>
        </div>

        <div v-else class="model-card">
          <header v-if="filename" class="file-heading">
            <div>
              <p class="eyebrow">
                {{ addingModel ? "PŘIDÁVANÝ SOUBOR" : "VYBRANÝ SOUBOR" }}
              </p>
              <h2>{{ filename }}</h2>
            </div>
            <p v-if="metadata" class="file-meta mono">
              {{ metadata.format }} · {{ formatFileSize(metadata.sizeBytes) }}
            </p>
          </header>

          <div
            v-if="phase === 'preparing'"
            class="working-state"
            aria-live="polite"
          >
            <span class="activity-mark" aria-hidden="true" />
            <div>
              <h2>Načítáme model</h2>
              <p>Počítáme kontrolní otisk a připravujeme bezpečný náhled.</p>
            </div>
          </div>

          <template v-if="phase === 'ready' || phase === 'uploading'">
            <div v-if="geometry" class="preview-frame">
              <ClientOnly>
                <LazyOrderModelPreview :geometry="geometry" />
                <template #fallback>
                  <div class="preview-fallback">
                    Připravujeme náhled modelu.
                  </div>
                </template>
              </ClientOnly>
            </div>
            <div v-else class="preview-fallback">
              <p>{{ previewMessage }}</p>
            </div>
            <p class="visually-hidden">{{ previewDescription }}</p>

            <dl v-if="geometry" class="geometry-metrics">
              <div>
                <dt>Rozměry X × Y × Z</dt>
                <dd class="mono">
                  {{ millimeters(geometry.dimensions.width) }} ×
                  {{ millimeters(geometry.dimensions.depth) }} ×
                  {{ millimeters(geometry.dimensions.height) }}
                </dd>
              </div>
              <div>
                <dt>Objekty</dt>
                <dd class="mono">{{ geometry.objectCount }}</dd>
              </div>
              <div>
                <dt>Objem modelu</dt>
                <dd class="mono">
                  ≈ {{ cubicCentimeters(geometry.volumeMm3) }}
                </dd>
              </div>
              <div>
                <dt>Plochy</dt>
                <dd class="mono">
                  {{ geometry.triangleCount.toLocaleString("cs-CZ") }}
                </dd>
              </div>
            </dl>

            <div class="estimate-note">
              <strong>Orientační geometrický odhad</strong>
              <p>
                Rozměry a objem jsou vypočtené jen ze souboru. Nejsou závaznou
                cenou; tu určí až materiál, slicing, doprava a výsledná
                kontrola.
              </p>
            </div>

            <div
              v-if="phase === 'uploading'"
              class="upload-progress"
              aria-live="polite"
            >
              <div class="progress-copy">
                <span>Nahráváme a ověřujeme soubor</span>
                <span class="mono">{{ uploadProgress }} %</span>
              </div>
              <progress :value="uploadProgress" max="100">
                {{ uploadProgress }} %
              </progress>
              <button class="text-button" type="button" @click="cancelUpload">
                Zrušit nahrání
              </button>
            </div>

            <div v-else class="card-actions">
              <button
                class="primary-button"
                type="button"
                :disabled="!canUpload"
                @click="startUpload"
              >
                {{
                  addingModel
                    ? "Nahrát a přidat model"
                    : "Nahrát a zkontrolovat"
                }}
              </button>
              <button
                class="secondary-button"
                type="button"
                @click="
                  addingModel ? cancelAdditionalModel() : chooseAnotherFile()
                "
              >
                {{ addingModel ? "Zpět ke kalkulaci" : "Vybrat jiný soubor" }}
              </button>
            </div>
          </template>

          <div
            v-if="phase === 'inspecting' && !showConfigurator"
            class="working-state"
            aria-live="polite"
          >
            <span class="activity-mark" aria-hidden="true" />
            <div>
              <h2>{{ progressCopy.title }}</h2>
              <p>{{ progressCopy.detail }}</p>
              <p v-if="quote?.publicReference" class="reference mono">
                Reference {{ quote.publicReference }}
              </p>
            </div>
          </div>

          <OrderQuoteConfigurator
            v-if="showConfigurator && quote"
            :command-error="commandError"
            :on-decide-risk="decideRisk"
            :on-prepare="prepareQuote"
            :on-refresh="refreshQuote"
            :on-replace-configuration="replaceConfiguration"
            :on-restart="chooseAnotherFile"
            :on-select-destination="selectDestination"
            :on-set-express="setExpress"
            :pending="commandPending"
            :quote="quote"
          />

          <div
            v-if="showConfigurator && quote?.configurationEditable"
            class="card-actions"
          >
            <input
              ref="additionalFileInput"
              accept=".stl,.3mf,model/stl,model/3mf"
              class="visually-hidden"
              type="file"
              @change="onAdditionalFileChange"
            />
            <button
              class="secondary-button"
              type="button"
              :disabled="commandPending"
              @click="chooseAdditionalFile"
            >
              + Přidat další model
            </button>
          </div>

          <div
            v-if="phase === 'handoff'"
            class="result-state handoff-state"
            role="alert"
          >
            <p class="state-code mono">PŘÍMÁ KALKULACE ZASTAVENA</p>
            <h2>Tento model nelze bezpečně zpracovat automaticky.</h2>
            <p>{{ handoffMessage }}</p>
            <div class="card-actions">
              <button
                class="primary-button"
                type="button"
                @click="openAssistedQuote"
              >
                Pokračovat individuální poptávkou
              </button>
              <button
                class="secondary-button"
                type="button"
                @click="
                  addingModel ? cancelAdditionalModel() : chooseAnotherFile()
                "
              >
                {{
                  addingModel ? "Zpět ke kalkulaci" : "Začít novou kalkulaci"
                }}
              </button>
            </div>
          </div>

          <div
            v-if="phase === 'expired'"
            class="result-state error-state"
            role="alert"
          >
            <p class="state-code mono">PLATNOST VYPRŠELA</p>
            <h2>Relace už není aktivní.</h2>
            <p>
              Soubor znovu vyberte a nahrajte. V prohlížeči jeho kopii
              neuchováváme.
            </p>
            <button
              class="primary-button"
              type="button"
              @click="chooseAnotherFile"
            >
              Vybrat soubor znovu
            </button>
          </div>

          <div
            v-if="phase === 'error' || phase === 'cancelled'"
            class="result-state error-state"
            role="alert"
          >
            <p class="state-code mono">
              {{
                phase === "cancelled"
                  ? "NAHRÁNÍ ZRUŠENO"
                  : "NAHRÁNÍ SE NEZDAŘILO"
              }}
            </p>
            <h2>Soubor zatím není odeslaný.</h2>
            <p>{{ errorMessage }}</p>
            <div class="card-actions">
              <button class="primary-button" type="button" @click="retry">
                Zkusit znovu
              </button>
              <button
                class="secondary-button"
                type="button"
                @click="
                  addingModel ? cancelAdditionalModel() : chooseAnotherFile()
                "
              >
                {{ addingModel ? "Zpět ke kalkulaci" : "Vybrat jiný soubor" }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <aside class="process-context" aria-labelledby="process-title">
        <div>
          <p class="eyebrow">PRŮBĚH</p>
          <h2 id="process-title">Od modelu k výrobě</h2>
        </div>
        <ol class="pipeline-list">
          <li
            v-for="(item, index) in pipeline"
            :key="item.label"
            :class="item.status"
          >
            <span class="pipeline-index mono">{{
              String(index + 1).padStart(2, "0")
            }}</span>
            <span>{{ item.label }}</span>
            <span class="pipeline-status">
              {{
                item.status === "done"
                  ? "hotovo"
                  : item.status === "active"
                    ? "probíhá"
                    : "čeká"
              }}
            </span>
          </li>
        </ol>
        <div class="context-note">
          <p class="eyebrow">SOUKROMÍ A OBNOVA</p>
          <p>
            Prohlížeč si neponechává data modelu. Ukládá jen dočasnou referenci
            v aktuální kartě, aby šlo po obnovení stránky navázat.
          </p>
        </div>
        <div class="context-note">
          <p class="eyebrow">PODPOROVANÉ SOUBORY</p>
          <p>STL a jednovrstvý, nebarvený 3MF do 100 MiB.</p>
        </div>
      </aside>
    </main>
  </div>
</template>

<style src="../../assets/css/application.css"></style>
