<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import { legalDocuments } from "../../content/public-site";
import { isEffectiveApprovedLegalDocument } from "../../content/launch-approvals";
import {
  assistedQuotePrefill,
  clearAssistedQuoteHandoff,
  loadAssistedQuoteHandoff,
  normalizeAssistedQuoteSource,
  type AssistedQuoteHandoffContext,
} from "../../utils/assisted-quote-context";
import { formatFileSize } from "../../utils/model-file";
import {
  QuotePhotoValidationError,
  validateQuotePhoto,
} from "../../utils/quote-photo";
import { getSessionStorage } from "../../utils/quote-session-storage";

type CreateQuoteRequest = components["schemas"]["CreateQuoteRequestDto"];

usePublicPageMeta({
  path: "/poptavka",
  title: "Individuální poptávka",
  description:
    "Poptávka individuálního 3D tisku s bezpečnými referenčními fotografiemi a odpovědí do 24 pracovních hodin.",
  noindex: true,
});

const route = useRoute();
const automaticQuoteEnabled = useAutomaticQuoteEnabled();
const source = normalizeAssistedQuoteSource(route.query.source);
const initialPrefill = assistedQuotePrefill(source);
const handoffContext = shallowRef<AssistedQuoteHandoffContext>();
const selectedPhotos = shallowRef<File[]>([]);
const selectionError = ref<string>();
const description = ref(initialPrefill.description);
const purpose = ref("");
const widthMm = ref<number | "">("");
const depthMm = ref<number | "">("");
const heightMm = ref<number | "">("");
const requestedDate = ref("");
const contactName = ref("");
const contactEmail = ref("");
const contactPhone = ref("");
const privacyAcknowledged = ref(false);
const photoPublicationConsent = ref(false);
const photoInput = ref<HTMLInputElement>();

const {
  activePhotoName,
  attachmentsEditable,
  cancel,
  created,
  createFailureStatus,
  errorMessage,
  pending,
  phase,
  retry,
  rejectedPhoto,
  submit,
  submitted,
  uploadProgress,
} = useAssistedQuoteRequest();

const prefill = computed(() =>
  assistedQuotePrefill(source, handoffContext.value),
);
const requestFieldsLocked = computed(() => submitted.value);
const photoFieldsLocked = computed(
  () => submitted.value && !attachmentsEditable.value,
);
const hasDimensions = computed(() =>
  [widthMm.value, depthMm.value, heightMm.value].some(isPositiveDimension),
);
const canSubmit = computed(
  () =>
    !requestFieldsLocked.value &&
    description.value.trim().length >= 10 &&
    contactName.value.trim().length > 0 &&
    contactEmail.value.trim().length > 0 &&
    !selectionError.value &&
    privacyAcknowledged.value,
);
const minimumDate = localDateValue(new Date());
const formattedSla = computed(() =>
  created.value
    ? new Intl.DateTimeFormat("cs-CZ", {
        dateStyle: "long",
        timeStyle: "short",
      }).format(new Date(created.value.slaDueAt))
    : "",
);

onMounted(() => {
  if (source !== "automatic-quote") return;
  const storage = getSessionStorage(window);
  if (!storage) return;
  const context = loadAssistedQuoteHandoff(storage);
  handoffContext.value = context;
  if (description.value === initialPrefill.description) {
    description.value = assistedQuotePrefill(source, context).description;
  }
});

function onPhotoChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  addPhotos(input.files);
  input.value = "";
}

function addPhotos(files: FileList | null): void {
  if (!files || photoFieldsLocked.value) return;
  selectionError.value = undefined;
  const next = attachmentsEditable.value
    ? selectedPhotos.value.filter((photo) => photo !== rejectedPhoto.value)
    : [...selectedPhotos.value];
  try {
    for (const file of Array.from(files)) {
      validateQuotePhoto(file);
      const duplicate = next.some(
        (candidate) =>
          candidate.name === file.name &&
          candidate.size === file.size &&
          candidate.lastModified === file.lastModified,
      );
      if (!duplicate) next.push(file);
    }
    selectedPhotos.value = next;
  } catch (error) {
    selectionError.value =
      error instanceof QuotePhotoValidationError || error instanceof Error
        ? error.message
        : "Fotografii se nepodařilo přidat.";
  }
}

function removePhoto(index: number): void {
  const photo = selectedPhotos.value[index];
  if (
    photoFieldsLocked.value ||
    (requestFieldsLocked.value && photo !== rejectedPhoto.value)
  )
    return;
  selectedPhotos.value = selectedPhotos.value.filter(
    (_, candidateIndex) => candidateIndex !== index,
  );
  selectionError.value = undefined;
}

async function submitRequest(): Promise<void> {
  selectionError.value = undefined;
  const measurements: Record<string, unknown> = {};
  if (isPositiveDimension(widthMm.value)) measurements.widthMm = widthMm.value;
  if (isPositiveDimension(depthMm.value)) measurements.depthMm = depthMm.value;
  if (isPositiveDimension(heightMm.value))
    measurements.heightMm = heightMm.value;
  if (hasDimensions.value) measurements.unit = "mm";

  const context =
    handoffContext.value &&
    Date.parse(handoffContext.value.expiresAt) > Date.now()
      ? handoffContext.value
      : undefined;
  if (!context) handoffContext.value = undefined;
  const body: CreateQuoteRequest = {
    attribution: {
      channel: "direct",
      source,
    },
    contact: {
      email: contactEmail.value.trim(),
      name: contactName.value.trim(),
      ...(contactPhone.value.trim()
        ? { phone: contactPhone.value.trim() }
        : {}),
    },
    description: description.value.trim(),
    photoPublicationConsent: photoPublicationConsent.value,
    ...(context?.handoffToken
      ? { automaticQuoteHandoffToken: context.handoffToken }
      : {}),
    ...(hasDimensions.value ? { measurements } : {}),
    ...(purpose.value.trim() ? { purpose: purpose.value.trim() } : {}),
    ...(requestedDate.value ? { requestedDate: requestedDate.value } : {}),
  };
  await submit(body, selectedPhotos.value);
  if (!import.meta.client) return;
  const storage = getSessionStorage(window);
  if (phase.value === "success") {
    if (storage) clearAssistedQuoteHandoff(storage);
  } else if (createFailureStatus.value === 401 && context?.handoffToken) {
    handoffContext.value = undefined;
    if (storage) clearAssistedQuoteHandoff(storage);
  }
}

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isPositiveDimension(value: number | ""): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
</script>

<template>
  <div class="application-page">
    <header class="application-header">
      <NuxtLink class="wordmark" to="/" aria-label="Taven, úvodní stránka">
        <PublicBrandMark />
      </NuxtLink>
      <nav aria-label="Cesta individuální poptávky" class="process-nav">
        <ol>
          <li aria-current="step"><span>01</span> POPIS</li>
          <li><span>02</span> POSOUZENÍ</li>
          <li><span>03</span> NABÍDKA</li>
        </ol>
      </nav>
    </header>

    <main class="order-layout assisted-layout">
      <section class="order-workspace" aria-labelledby="request-title">
        <div class="section-heading">
          <p class="eyebrow">INDIVIDUÁLNÍ NABÍDKA</p>
          <h1 id="request-title">Popište, co potřebujete vyrobit.</h1>
          <p>
            Odpovíme do 24 hodin v pracovní dny. Nevzniká tím automatická cena
            ani objednávka a nepotřebujete účet.
          </p>
        </div>

        <div v-if="phase === 'success' && created" class="request-card">
          <div class="result-state success-state" role="status">
            <p class="state-code mono">POPTÁVKA ULOŽENA</p>
            <h2>Děkujeme. Podklady předáme k lidskému posouzení.</h2>
            <p>
              Odpověď pošleme na uvedený e-mail nejpozději
              <strong>{{ formattedSla }}</strong
              >. Nabídka přijde jako bezpečný odkaz bez registrace.
            </p>
            <p class="reference mono">
              Reference {{ created.publicReference }}
            </p>
            <NuxtLink
              v-if="automaticQuoteEnabled"
              class="secondary-button"
              to="/objednavka"
            >
              Zpět k přímé kalkulaci
            </NuxtLink>
            <span v-else class="secondary-button" aria-disabled="true">
              Přímá kalkulace čeká na schválení
            </span>
          </div>
        </div>

        <form
          v-else
          class="request-card assisted-form"
          @submit.prevent="submitRequest"
        >
          <div class="context-banner">
            <p class="eyebrow">KONTEXT POPTÁVKY</p>
            <p>{{ prefill.note }}</p>
          </div>

          <fieldset :disabled="requestFieldsLocked">
            <legend>Zakázka</legend>
            <label class="form-field wide-form-field">
              <span>Co potřebujete vyrobit? *</span>
              <textarea
                v-model="description"
                minlength="10"
                maxlength="10000"
                rows="6"
                required
                aria-describedby="description-help"
              />
              <small id="description-help">
                Uveďte počet kusů, požadované provedení a co je pro výsledek
                důležité. Nezadávejte citlivé údaje, které k posouzení
                nepotřebujeme.
              </small>
            </label>
            <label class="form-field wide-form-field">
              <span>Účel dílu</span>
              <textarea
                v-model="purpose"
                maxlength="2000"
                rows="3"
                placeholder="Například náhradní držák do interiéru"
              />
            </label>
          </fieldset>

          <fieldset :disabled="requestFieldsLocked">
            <legend>Rozměry a termín</legend>
            <p class="field-guidance">
              Zadejte známé maximální rozměry. Neznámou hodnotu nechte prázdnou.
            </p>
            <div class="dimension-grid">
              <label class="form-field">
                <span>Šířka X (mm)</span>
                <input v-model="widthMm" min="0.01" step="0.01" type="number" />
              </label>
              <label class="form-field">
                <span>Hloubka Y (mm)</span>
                <input v-model="depthMm" min="0.01" step="0.01" type="number" />
              </label>
              <label class="form-field">
                <span>Výška Z (mm)</span>
                <input
                  v-model="heightMm"
                  min="0.01"
                  step="0.01"
                  type="number"
                />
              </label>
            </div>
            <label class="form-field date-field">
              <span>Požadovaný termín</span>
              <input v-model="requestedDate" :min="minimumDate" type="date" />
              <small>Termín potvrdíme až v individuální nabídce.</small>
            </label>
          </fieldset>

          <fieldset :disabled="photoFieldsLocked">
            <legend>Referenční fotografie</legend>
            <p class="field-guidance">
              Pokud má díl vzniknout podle předlohy, vyfoťte ji ze tří stran s
              pravítkem nebo jiným předmětem známé velikosti. Přijímáme JPG, PNG
              a WebP do 20 MiB za soubor.
            </p>
            <label class="photo-picker secondary-button">
              <input
                ref="photoInput"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                class="visually-hidden"
                multiple
                type="file"
                @change="onPhotoChange"
              />
              Přidat fotografie
            </label>
            <ul v-if="selectedPhotos.length" class="attachment-list">
              <li
                v-for="(photo, index) in selectedPhotos"
                :key="`${photo.name}:${photo.lastModified}`"
              >
                <span>
                  <strong>{{ photo.name }}</strong>
                  <small class="mono">{{ formatFileSize(photo.size) }}</small>
                </span>
                <button
                  class="text-button"
                  type="button"
                  :disabled="requestFieldsLocked && photo !== rejectedPhoto"
                  @click="removePhoto(index)"
                >
                  Odebrat
                </button>
              </li>
            </ul>
            <p v-if="selectionError" class="inline-error" role="alert">
              {{ selectionError }}
            </p>
          </fieldset>

          <fieldset :disabled="requestFieldsLocked">
            <legend>Kontakt</legend>
            <div class="contact-grid">
              <label class="form-field">
                <span>Jméno *</span>
                <input
                  v-model="contactName"
                  maxlength="200"
                  required
                  autocomplete="name"
                />
              </label>
              <label class="form-field">
                <span>E-mail *</span>
                <input
                  v-model="contactEmail"
                  maxlength="320"
                  required
                  type="email"
                  autocomplete="email"
                />
              </label>
              <label class="form-field">
                <span>Telefon</span>
                <input
                  v-model="contactPhone"
                  maxlength="50"
                  type="tel"
                  autocomplete="tel"
                />
              </label>
            </div>
          </fieldset>

          <fieldset class="privacy-fieldset" :disabled="requestFieldsLocked">
            <legend>Soukromí</legend>
            <label class="consent-row">
              <input v-model="privacyAcknowledged" required type="checkbox" />
              <span>
                Beru na vědomí, že kontaktní údaje a podklady použijeme k
                posouzení poptávky a komunikaci o nabídce podle
                <NuxtLink class="underline" :to="legalDocuments.privacy.path"
                  >zásad zpracování osobních údajů</NuxtLink
                >. Fotografie dostanou při nahrání vlastní termín smazání. *
              </span>
            </label>
            <label class="consent-row">
              <input
                v-model="photoPublicationConsent"
                type="checkbox"
                :disabled="
                  !isEffectiveApprovedLegalDocument(legalDocuments.photoConsent)
                "
              />
              <span>
                Souhlasím s případným zveřejněním výsledných fotografií jako
                ukázky práce podle
                <NuxtLink
                  class="underline"
                  :to="legalDocuments.photoConsent.path"
                  >pravidel fotografování</NuxtLink
                >. Tento souhlas je nepovinný a lze jej odmítnout.
                <template
                  v-if="
                    !isEffectiveApprovedLegalDocument(
                      legalDocuments.photoConsent,
                    )
                  "
                >
                  Čeká na schválené znění.
                </template>
              </span>
            </label>
          </fieldset>

          <div
            v-if="phase === 'creating' || phase === 'uploading'"
            class="upload-progress request-progress"
            aria-live="polite"
          >
            <div class="progress-copy">
              <span>
                {{
                  phase === "creating"
                    ? "Ukládáme poptávku"
                    : `Nahráváme ${activePhotoName ?? "přílohy"}`
                }}
              </span>
              <span v-if="phase === 'uploading'" class="mono">
                {{ uploadProgress }} %
              </span>
            </div>
            <progress
              v-if="phase === 'uploading'"
              :value="uploadProgress"
              max="100"
            >
              {{ uploadProgress }} %
            </progress>
            <button class="text-button" type="button" @click="cancel">
              Pozastavit odesílání
            </button>
          </div>

          <div v-if="phase === 'error'" class="request-error" role="alert">
            <p class="state-code mono">
              {{ created ? "PŘÍLOHY ČEKAJÍ" : "POPTÁVKA ČEKÁ" }}
            </p>
            <h2>
              {{
                created
                  ? `Poptávka ${created.publicReference} je uložená.`
                  : "Odeslání se zatím nedokončilo."
              }}
            </h2>
            <p>{{ errorMessage }}</p>
            <p v-if="attachmentsEditable && activePhotoName" class="mono">
              Opravte přílohu: {{ activePhotoName }}
            </p>
            <button
              v-if="attachmentsEditable"
              class="primary-button"
              type="submit"
              :disabled="Boolean(selectionError)"
            >
              Odeslat opravené přílohy
            </button>
            <button
              v-else-if="submitted"
              class="primary-button"
              type="button"
              @click="retry"
            >
              Zkusit stejný požadavek znovu
            </button>
            <button v-else class="primary-button" type="submit">
              Opravit a znovu odeslat
            </button>
          </div>

          <div v-else class="form-actions">
            <button
              class="primary-button"
              type="submit"
              :disabled="!canSubmit || pending"
            >
              Odeslat k lidskému posouzení
            </button>
            <p>
              Odesláním nevzniká cenový příslib. Nabídku dostanete e-mailem po
              kontrole podkladů.
            </p>
          </div>
        </form>
      </section>

      <aside class="process-context" aria-labelledby="assisted-process-title">
        <div>
          <p class="eyebrow">CO BUDE NÁSLEDOVAT</p>
          <h2 id="assisted-process-title">Jedna poptávka, lidská odpověď.</h2>
        </div>
        <ol class="pipeline-list assisted-steps">
          <li class="active">
            <span class="pipeline-index mono">01</span>
            <span>Popis a podklady</span>
            <span class="pipeline-status">teď</span>
          </li>
          <li>
            <span class="pipeline-index mono">02</span>
            <span>Technické posouzení</span>
            <span class="pipeline-status">do 24 h</span>
          </li>
          <li>
            <span class="pipeline-index mono">03</span>
            <span>Tokenizovaná nabídka</span>
            <span class="pipeline-status">e-mailem</span>
          </li>
        </ol>
        <div class="context-note">
          <p class="eyebrow">BEZ ÚČTU A CHATU</p>
          <p>
            Komunikace pokračuje e-mailem. Nabídka má bezpečný jednorázový
            odkaz; nevytváříme profil ani zprávový portál.
          </p>
        </div>
        <div class="context-note">
          <p class="eyebrow">CITLIVÉ PODKLADY</p>
          <p>
            Neposílejte obchodní tajemství, která nepotřebujeme. Požadavek na
            mlčenlivost uveďte přímo v popisu před předáním dalších podkladů.
          </p>
        </div>
      </aside>
    </main>
  </div>
</template>

<style src="../../assets/css/application.css"></style>
