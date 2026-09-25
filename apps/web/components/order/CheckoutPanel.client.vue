<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import { legalDocuments } from "../../content/public-site";
import {
  approvedCheckoutDocuments,
  checkoutErrorMessage,
  paymentStatusPath,
} from "../../utils/checkout-flow";
import {
  checkoutRequestFingerprint,
  finalizeCapturedCheckoutStorage,
  loadCheckoutSession,
  recoverableCheckoutDraft,
  saveCheckoutSession,
  type CheckoutCommandHandoff,
  type CheckoutCustomerDraft,
} from "../../utils/checkout-session-storage";
import {
  formatMoney,
  priceLabel,
  visiblePriceComponents,
  type QuoteSession,
} from "../../utils/automatic-quote-configurator";
import {
  getSessionStorage,
  loadPaymentReturnSession,
  type StoredQuoteSession,
} from "../../utils/quote-session-storage";
import {
  paymentRestartMode,
  paymentReturnPresentation,
} from "../../utils/payment-return";
import { useLegalAvailability } from "../../composables/useLegalAvailability";
import { usePublicLegalDocument } from "../../composables/usePublicLegalDocument";

type CheckoutPayment = components["schemas"]["CheckoutPaymentDto"];
type CreateCheckoutPayment = components["schemas"]["CreateCheckoutPaymentDto"];
type PaymentCapabilities = components["schemas"]["PaymentCapabilitiesDto"];
type CheckoutRetryContext = components["schemas"]["CheckoutRetryContextDto"];
const CHECKOUT_OBSERVATION_TIMEOUT_MS = 1_000;

const props = defineProps<{
  quote: QuoteSession;
  onRefresh: () => Promise<void>;
  onRestart: () => void;
}>();
const { $api } = useNuxtApp();
const { availability, refresh: refreshAvailability } = useLegalAvailability();
const form = ref<HTMLFormElement>();
const credentials = shallowRef<StoredQuoteSession>();
const capabilities = shallowRef<PaymentCapabilities>();
const payment = shallowRef<CheckoutPayment>();
const retryContext = shallowRef<CheckoutRetryContext>();
const command = shallowRef<CheckoutCommandHandoff>();
const loading = ref(true);
const submitting = ref(false);
const cancelling = ref(false);
const redirecting = ref(false);
const errorMessage = ref<string>();
const initialized = ref(false);
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});

const draft = reactive<CheckoutCustomerDraft>({
  email: "",
  fullName: "",
  billing: {
    name: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    postalCode: "",
    countryCode: "CZ",
    companyName: "",
    companyId: "",
    vatId: "",
  },
  method: "CARD",
  acceptTerms: false,
  acceptClaimPolicy: false,
  acknowledgeWithdrawalException: false,
  photoPublicationConsent: false,
});

const localDocumentIds = {
  terms: legalDocuments.terms,
  claims: legalDocuments.claims,
  privacy: legalDocuments.privacy,
  prohibitedContent: legalDocuments.prohibitedContent,
  retention: legalDocuments.retention,
  photoConsent: legalDocuments.photoConsent,
};
const presentedLegalDocuments = {
  terms: usePublicLegalDocument("terms"),
  claims: usePublicLegalDocument("claims"),
  privacy: usePublicLegalDocument("privacy"),
  prohibitedContent: usePublicLegalDocument("prohibitedContent"),
  retention: usePublicLegalDocument("retention"),
  photoConsent: usePublicLegalDocument("photoConsent"),
};
const verifiedLegalDocuments = computed(() => ({
  terms: presentedLegalDocuments.terms.effective.value,
  claims: presentedLegalDocuments.claims.effective.value,
  privacy: presentedLegalDocuments.privacy.effective.value,
  prohibitedContent: presentedLegalDocuments.prohibitedContent.effective.value,
  retention: presentedLegalDocuments.retention.effective.value,
  photoConsent: presentedLegalDocuments.photoConsent.effective.value,
}));
async function refreshLegalAvailability(): Promise<void> {
  if (disposed) return;
  const selected = await refreshAvailability();
  if (disposed) return;
  for (const { refresh } of Object.values(presentedLegalDocuments)) {
    if (disposed) return;
    await refresh(selected);
  }
}
const approvedDocuments = computed(() =>
  approvedCheckoutDocuments(
    capabilities.value,
    localDocumentIds,
    availability.value,
    verifiedLegalDocuments.value,
  ),
);
const retryEvidence = computed(
  () => retryContext.value?.acceptedEvidence ?? null,
);
// Historical evidence controls the read-only retry presentation. Whether a
// new payment attempt may actually be submitted is a separate server decision
// exposed by retryAllowed.
const acceptedCheckoutMode = computed(
  () => props.quote.checkoutEvidenceAccepted === true,
);
const retryMode = computed(
  () => acceptedCheckoutMode.value || retryEvidence.value !== null,
);
type LegalEvidenceFingerprint = Readonly<{
  contentHash: string | null | undefined;
  revision: string | undefined;
}>;

const acknowledgedLegalEvidence = reactive<{
  claims?: LegalEvidenceFingerprint;
  photoConsent?: LegalEvidenceFingerprint;
  terms?: LegalEvidenceFingerprint;
}>({});

function currentLegalEvidence(
  key: "terms" | "claims" | "photoConsent",
): LegalEvidenceFingerprint | undefined {
  const document = availability.value?.documents[key];
  if (!document) return undefined;
  return {
    revision: document.revision,
    contentHash: document.contentHash,
  };
}

function matchesLegalEvidence(
  acknowledged: LegalEvidenceFingerprint | undefined,
  current: LegalEvidenceFingerprint | undefined,
): boolean {
  return Boolean(
    acknowledged &&
    current &&
    acknowledged.revision === current.revision &&
    acknowledged.contentHash === current.contentHash,
  );
}

function legalRevisionLink(
  key: "terms" | "claims" | "photoConsent",
  revision: string | null | undefined,
  contentHash: string | undefined | null,
) {
  return {
    path: legalDocuments[key].path,
    query: revision && contentHash ? { revision, contentHash } : undefined,
  };
}

function hasHistoricalRevision(
  contentHash: string | null | undefined,
): boolean {
  return Boolean(contentHash);
}
const paymentMethods = computed(() =>
  retryMode.value && retryContext.value
    ? retryContext.value.methods
    : retryMode.value
      ? []
      : (capabilities.value?.methods ?? []),
);
watch(approvedDocuments, (documents) => {
  if (!documents?.photoConsentRevision) draft.photoPublicationConsent = false;
});
watch(
  [
    () => draft.acceptTerms,
    () => draft.acceptClaimPolicy,
    () => draft.acknowledgeWithdrawalException,
    () => draft.photoPublicationConsent,
    () => availability.value?.documents.terms.revision,
    () => availability.value?.documents.terms.contentHash,
    () => availability.value?.documents.claims.revision,
    () => availability.value?.documents.claims.contentHash,
    () => availability.value?.documents.photoConsent.revision,
    () => availability.value?.documents.photoConsent.contentHash,
  ],
  () => {
    const terms = currentLegalEvidence("terms");
    const claims = currentLegalEvidence("claims");
    const photoConsent = currentLegalEvidence("photoConsent");

    if (draft.acceptTerms || draft.acknowledgeWithdrawalException) {
      if (
        acknowledgedLegalEvidence.terms &&
        !matchesLegalEvidence(acknowledgedLegalEvidence.terms, terms)
      ) {
        draft.acceptTerms = false;
        draft.acknowledgeWithdrawalException = false;
        acknowledgedLegalEvidence.terms = undefined;
      } else if (terms) {
        acknowledgedLegalEvidence.terms ??= terms;
      }
    } else {
      acknowledgedLegalEvidence.terms = undefined;
    }

    if (draft.acceptClaimPolicy) {
      if (
        acknowledgedLegalEvidence.claims &&
        !matchesLegalEvidence(acknowledgedLegalEvidence.claims, claims)
      ) {
        draft.acceptClaimPolicy = false;
        acknowledgedLegalEvidence.claims = undefined;
      } else if (claims) {
        acknowledgedLegalEvidence.claims ??= claims;
      }
    } else {
      acknowledgedLegalEvidence.claims = undefined;
    }

    if (draft.photoPublicationConsent) {
      if (
        acknowledgedLegalEvidence.photoConsent &&
        !matchesLegalEvidence(
          acknowledgedLegalEvidence.photoConsent,
          photoConsent,
        )
      ) {
        draft.photoPublicationConsent = false;
        acknowledgedLegalEvidence.photoConsent = undefined;
      } else if (photoConsent) {
        acknowledgedLegalEvidence.photoConsent ??= photoConsent;
      }
    } else {
      acknowledgedLegalEvidence.photoConsent = undefined;
    }
  },
);
const bindingPrice = computed(() => props.quote.bindingQuote ?? null);
const priceComponents = computed(() =>
  visiblePriceComponents(bindingPrice.value?.components ?? []),
);
function itemDescription(modelFileId: string): string {
  const index = props.quote.modelFiles.findIndex(
    (file) => file.modelFileId === modelFileId,
  );
  const format = props.quote.modelFiles[index]?.format;
  return `Soubor ${index + 1} · ${format === "THREE_MF" ? "3MF" : (format ?? "model")}`;
}
function colorLabel(value: string | null | undefined): string {
  if (!value) return "Bez určení barvy";
  return (
    {
      BLACK: "Černá",
      GRAPHITE: "Grafitová",
      ORANGE: "Oranžová",
      WHITE: "Bílá",
    }[value.toUpperCase()] ?? value
  );
}
function qualityLabel(value: string): string {
  return (
    { DRAFT: "Rychlá", FINE: "Jemná", STANDARD: "Standardní" }[value] ?? value
  );
}
function infillLabel(value: string): string {
  return (
    { DECORATIVE: "Dekorativní", STANDARD: "Standardní", STRONG: "Pevná" }[
      value
    ] ?? value
  );
}
const selectedDestination = computed(
  () => props.quote.selectedDeliveryDestination ?? null,
);
const paymentPresentation = computed(() =>
  payment.value ? paymentReturnPresentation(payment.value.status) : undefined,
);
const restartMode = computed(() =>
  payment.value ? paymentRestartMode(payment.value.status) : null,
);
const canSubmit = computed(
  () =>
    Boolean(
      (approvedDocuments.value || retryMode.value) &&
      bindingPrice.value?.kind === "BINDING" &&
      selectedDestination.value &&
      (!retryMode.value || retryContext.value?.retryAllowed === true) &&
      (retryMode.value ||
        (draft.acceptTerms &&
          draft.acceptClaimPolicy &&
          draft.acknowledgeWithdrawalException)) &&
      paymentMethods.value.includes(draft.method),
    ) &&
    !submitting.value &&
    !redirecting.value,
);
const openPayment = computed(
  () =>
    payment.value?.status === "CREATED" || payment.value?.status === "PENDING",
);

onMounted(async () => {
  const storage = getSessionStorage(window);
  const storedCredentials = storage
    ? loadPaymentReturnSession(storage)
    : undefined;
  if (
    !storedCredentials ||
    storedCredentials.sessionId !== props.quote.sessionId
  ) {
    errorMessage.value =
      "Bez uložené relace nelze bezpečně navázat na tuto objednávku.";
    loading.value = false;
    return;
  }
  credentials.value = storedCredentials;
  const storedCheckout = storage
    ? loadCheckoutSession(storage, props.quote.sessionId)
    : undefined;
  if (storedCheckout?.draft) {
    const restoredDraft = recoverableCheckoutDraft(storedCheckout.draft);
    Object.assign(draft, restoredDraft, {
      billing: { ...draft.billing, ...restoredDraft.billing },
    });
  }
  command.value = storedCheckout?.command;
  initialized.value = true;
  await loadRetryContext();
  if (disposed) return;
  await loadCapabilities();
  if (disposed) return;
  await refreshLegalAvailability();
  if (disposed) return;
  if (command.value?.paymentId) await refreshPayment();
  if (disposed) return;
  loading.value = false;
});

watch(
  draft,
  () => {
    if (initialized.value && !payment.value) persistCheckout();
  },
  { deep: true },
);

async function loadCapabilities(): Promise<void> {
  errorMessage.value = undefined;
  try {
    const response = await $api.GET("/payments/capabilities");
    capabilities.value = response.data;
    if (!response.data) {
      errorMessage.value =
        "Dostupné platební metody se nepodařilo bezpečně ověřit.";
      return;
    }
    if (!paymentMethods.value.includes(draft.method)) {
      draft.method = paymentMethods.value[0] ?? "CARD";
    }
  } catch {
    if (!retryMode.value) {
      errorMessage.value =
        "Dostupné platební metody se nepodařilo bezpečně ověřit.";
    }
  }
}

async function submitCheckout(): Promise<void> {
  if (submitting.value || !form.value?.reportValidity() || !canSubmit.value)
    return;
  submitting.value = true;
  try {
    if (retryMode.value) await loadRetryContext();
    else await refreshLegalAvailability();
    const session = credentials.value;
    const documents = approvedDocuments.value;
    const evidence = retryEvidence.value;
    if (!session || (!documents && !evidence)) return;
    if (retryMode.value && !retryContext.value?.retryAllowed) {
      errorMessage.value = "Předchozí platbu už nelze bezpečně opakovat.";
      return;
    }
    if (
      !retryMode.value &&
      draft.photoPublicationConsent &&
      !documents?.photoConsentRevision
    ) {
      errorMessage.value =
        "Dobrovolný souhlas s fotografiemi zatím nemá schválené znění.";
      return;
    }

    const body: CreateCheckoutPayment = {
      email: draft.email,
      fullName: draft.fullName,
      billing: compactBilling(draft.billing),
      method: draft.method,
      acceptTerms: retryMode.value || draft.acceptTerms,
      acceptClaimPolicy: retryMode.value || draft.acceptClaimPolicy,
      acknowledgeWithdrawalException:
        retryMode.value || draft.acknowledgeWithdrawalException,
      termsRevision: evidence?.termsRevision ?? documents!.termsRevision,
      claimPolicyRevision:
        evidence?.claimPolicyRevision ?? documents!.claimPolicyRevision,
      photoPublicationConsent:
        evidence?.photoPublicationConsent ?? draft.photoPublicationConsent,
      photoConsentRevision: evidence
        ? evidence.photoConsentRevision
        : draft.photoPublicationConsent
          ? documents!.photoConsentRevision
          : null,
    };
    const requestFingerprint = checkoutRequestFingerprint(body);
    const activeCommand =
      command.value?.requestFingerprint === requestFingerprint
        ? command.value
        : {
            idempotencyKey: `checkout-${crypto.randomUUID()}`,
            requestFingerprint,
          };
    command.value = activeCommand;
    persistCheckout();
    errorMessage.value = undefined;
    await recordCheckoutStartedBeforePayment();
    const result = await $api.POST(
      "/automatic-quote-sessions/{sessionId}/checkout/payments",
      {
        body,
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        params: {
          header: { "Idempotency-Key": activeCommand.idempotencyKey },
          path: { sessionId: props.quote.sessionId },
        },
      },
    );
    if (!result.data) {
      errorMessage.value = checkoutErrorMessage(result.response.status);
      if (result.response.status === 409 || result.response.status === 410) {
        await props.onRefresh();
      }
      return;
    }
    payment.value = result.data;
    command.value = {
      ...activeCommand,
      paymentId: result.data.paymentId,
      ...(result.data.checkoutUrl
        ? { checkoutUrl: result.data.checkoutUrl }
        : {}),
    };
    persistCheckout();
    if (result.data.status === "FAILED") await loadRetryContext();
    await continueFromPayment(result.data);
  } catch {
    errorMessage.value = checkoutErrorMessage(0);
  } finally {
    submitting.value = false;
  }
}

async function loadRetryContext(): Promise<void> {
  const session = credentials.value;
  if (!session) return;
  try {
    const result = await $api.GET(
      "/automatic-quote-sessions/{sessionId}/checkout/retry-context",
      {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        params: { path: { sessionId: session.sessionId } },
      },
    );
    retryContext.value = result.data;
    if (
      result.data?.retryAllowed &&
      !result.data.methods.includes(draft.method)
    ) {
      draft.method = result.data.methods[0] ?? "CARD";
    }
  } catch {
    retryContext.value = undefined;
  }
}

async function recordCheckoutStarted(): Promise<void> {
  const session = credentials.value;
  if (!session) return;
  try {
    await $api.POST("/automatic-quote-sessions/{sessionId}/observations", {
      body: { eventType: "checkout.started" },
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      params: { path: { sessionId: session.sessionId } },
    });
  } catch {
    // Observation failure must not block checkout.
  }
}

async function recordCheckoutStartedBeforePayment(): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, CHECKOUT_OBSERVATION_TIMEOUT_MS);
    void recordCheckoutStarted().finally(() => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

async function refreshPayment(): Promise<void> {
  const session = credentials.value;
  const paymentId = command.value?.paymentId;
  if (!session || !paymentId) return;
  errorMessage.value = undefined;
  try {
    const result = await $api.GET(
      "/automatic-quote-sessions/{sessionId}/checkout/payment",
      {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        params: {
          path: { sessionId: props.quote.sessionId },
          query: { paymentId },
        },
      },
    );
    if (!result.data) {
      errorMessage.value = "Ověřený stav platby se nepodařilo načíst.";
      return;
    }
    payment.value = result.data;
    if (result.data.status === "FAILED") await loadRetryContext();
    if (result.data.checkoutUrl) {
      command.value = {
        ...command.value!,
        checkoutUrl: result.data.checkoutUrl,
      };
      persistCheckout();
    }
    if (result.data.status === "CAPTURED") {
      const storage = getSessionStorage(window);
      if (storage) {
        finalizeCapturedCheckoutStorage(
          storage,
          props.quote.sessionId,
          result.data.paymentId,
        );
      }
    }
  } catch {
    errorMessage.value = "Ověřený stav platby se nepodařilo načíst.";
  }
}

async function cancelPayment(): Promise<void> {
  const session = credentials.value;
  const paymentId = payment.value?.paymentId;
  if (!session || !paymentId || !openPayment.value) return;
  cancelling.value = true;
  errorMessage.value = undefined;
  try {
    const result = await $api.DELETE(
      "/automatic-quote-sessions/{sessionId}/checkout/payment",
      {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        params: {
          path: { sessionId: props.quote.sessionId },
          query: { paymentId },
        },
      },
    );
    if (!result.data) {
      errorMessage.value = "Platební pokus se nepodařilo zrušit.";
      return;
    }
    payment.value = result.data;
  } catch {
    errorMessage.value = "Platební pokus se nepodařilo zrušit.";
  } finally {
    cancelling.value = false;
  }
}

async function continueFromPayment(value: CheckoutPayment): Promise<void> {
  if (value.status === "CAPTURED") {
    const storage = getSessionStorage(window);
    if (storage) {
      finalizeCapturedCheckoutStorage(
        storage,
        props.quote.sessionId,
        value.paymentId,
      );
    }
    await navigateTo(
      paymentStatusPath("success", props.quote.sessionId, value.paymentId),
    );
    return;
  }
  const checkoutUrl = value.checkoutUrl ?? command.value?.checkoutUrl;
  if (checkoutUrl) {
    redirecting.value = true;
    window.location.assign(checkoutUrl);
    return;
  }
  await navigateTo(
    paymentStatusPath("pending", props.quote.sessionId, value.paymentId),
  );
}

async function startNewAttempt(): Promise<void> {
  await loadRetryContext();
  if (!retryContext.value?.retryAllowed) {
    errorMessage.value = "Předchozí platbu už nelze bezpečně opakovat.";
    return;
  }
  payment.value = undefined;
  command.value = undefined;
  errorMessage.value = undefined;
  persistCheckout();
}

function persistCheckout(): void {
  const storage = import.meta.client ? getSessionStorage(window) : undefined;
  if (!storage) return;
  saveCheckoutSession(storage, {
    sessionId: props.quote.sessionId,
    draft: recoverableCheckoutDraft(toRaw(draft)),
    ...(command.value ? { command: command.value } : {}),
  });
}

function compactBilling(
  value: CheckoutCustomerDraft["billing"],
): CreateCheckoutPayment["billing"] {
  return {
    name: value.name,
    addressLine1: value.addressLine1,
    city: value.city,
    postalCode: value.postalCode,
    countryCode: value.countryCode.toUpperCase(),
    ...(value.addressLine2?.trim() ? { addressLine2: value.addressLine2 } : {}),
    ...(value.companyName?.trim() ? { companyName: value.companyName } : {}),
    ...(value.companyId?.trim() ? { companyId: value.companyId } : {}),
    ...(value.vatId?.trim() ? { vatId: value.vatId } : {}),
  };
}
</script>

<template>
  <section
    class="checkout-layout"
    aria-labelledby="checkout-title"
    :aria-busy="loading || submitting"
  >
    <div class="checkout-layout__form-column">
      <slot name="delivery" />
      <h2 id="checkout-title" class="visually-hidden">Dokončení objednávky</h2>

      <div
        v-if="payment"
        class="mt-6 border-l-4 p-5"
        :class="
          paymentPresentation?.tone === 'success'
            ? 'border-[#1b44e8] bg-[#eef1ff]'
            : paymentPresentation?.tone === 'failure'
              ? 'border-[#b4441a] bg-[#fff4ef]'
              : 'border-[#925b10] bg-[#fff8eb]'
        "
        aria-live="polite"
      >
        <p class="font-mono text-xs tracking-wider uppercase">
          {{ paymentPresentation?.label }}
        </p>
        <h4 class="mt-2 text-xl font-semibold">
          {{ paymentPresentation?.title }}
        </h4>
        <p class="mt-2 text-[#54554c]">
          {{ paymentPresentation?.description }}
        </p>
        <div class="mt-5 flex flex-wrap gap-3">
          <button
            v-if="openPayment && (payment.checkoutUrl || command?.checkoutUrl)"
            class="min-h-11 bg-[#1b44e8] px-5 font-semibold text-white"
            type="button"
            @click="continueFromPayment(payment)"
          >
            Pokračovat k platbě
          </button>
          <button
            v-if="openPayment"
            class="min-h-11 border border-[#1a1a16] px-5 font-semibold disabled:opacity-50"
            type="button"
            :disabled="cancelling"
            @click="cancelPayment"
          >
            {{ cancelling ? "Rušíme…" : "Zrušit platební pokus" }}
          </button>
          <button
            v-if="restartMode === 'PAYMENT'"
            class="min-h-11 bg-[#1b44e8] px-5 font-semibold text-white"
            type="button"
            @click="startNewAttempt"
          >
            Zvolit nový platební pokus
          </button>
          <button
            v-if="restartMode === 'QUOTE'"
            class="min-h-11 bg-[#1b44e8] px-5 font-semibold text-white"
            type="button"
            @click="onRestart"
          >
            Začít novou kalkulaci
          </button>
          <button
            class="min-h-11 px-2 font-semibold underline decoration-2 underline-offset-4"
            type="button"
            @click="refreshPayment"
          >
            Načíst ověřený stav
          </button>
        </div>
      </div>

      <div
        v-else-if="loading"
        class="mt-6 border-l-4 border-[#925b10] bg-[#fff8eb] p-5"
        role="status"
      >
        Ověřujeme dostupnost plateb a schválených dokumentů…
      </div>

      <div
        v-else-if="!approvedDocuments && !retryMode"
        class="mt-6 border-l-4 border-[#925b10] bg-[#fff8eb] p-5"
        role="status"
      >
        <h4 class="font-semibold">Objednávku zatím nelze zaplatit.</h4>
        <p class="mt-2 text-sm leading-6 text-[#54554c]">
          Platební krok zůstává vypnutý, dokud nejsou na serveru i webu
          zveřejněna stejná schválená znění obchodních podmínek a reklamačního
          řádu. Aktuální návrhy jsou pouze podklady k dokončení systému.
        </p>
        <div class="mt-3 flex flex-wrap gap-4 text-sm">
          <NuxtLink class="underline" :to="legalDocuments.terms.path">
            Návrh VOP
          </NuxtLink>
          <NuxtLink class="underline" :to="legalDocuments.claims.path">
            Návrh reklamačního řádu
          </NuxtLink>
        </div>
      </div>

      <form
        v-else
        id="checkout-payment-form"
        ref="form"
        class="checkout-form"
        @submit.prevent="submitCheckout"
      >
        <fieldset class="checkout-card checkout-form__contact">
          <legend class="checkout-card__legend">
            <span class="checkout-card__index mono">02</span>
            Kontaktní údaje
          </legend>
          <p class="text-sm text-[#66675f]">
            Účet ani telefon nevyžadujeme. Potvrzení odešleme elektronicky.
          </p>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="grid gap-1 text-sm"
              >Jméno kontaktní osoby<input
                v-model="draft.fullName"
                class="min-h-11 border border-[#b8b8b0] px-3"
                maxlength="200"
                required
            /></label>
            <label class="grid gap-1 text-sm"
              >E-mail<input
                v-model="draft.email"
                class="min-h-11 border border-[#b8b8b0] px-3"
                maxlength="320"
                required
                type="email"
            /></label>
            <label class="grid gap-1 text-sm"
              >Fakturační jméno nebo název<input
                v-model="draft.billing.name"
                class="min-h-11 border border-[#b8b8b0] px-3"
                maxlength="200"
                required
            /></label>
            <label class="grid gap-1 text-sm"
              >Ulice a číslo<input
                v-model="draft.billing.addressLine1"
                class="min-h-11 border border-[#b8b8b0] px-3"
                maxlength="200"
                required
            /></label>
            <label class="grid gap-1 text-sm"
              >Doplnění adresy (volitelné)<input
                v-model="draft.billing.addressLine2"
                class="min-h-11 border border-[#b8b8b0] px-3"
                maxlength="200"
            /></label>
            <label class="grid gap-1 text-sm"
              >Město<input
                v-model="draft.billing.city"
                class="min-h-11 border border-[#b8b8b0] px-3"
                maxlength="100"
                required
            /></label>
            <label class="grid gap-1 text-sm"
              >PSČ<input
                v-model="draft.billing.postalCode"
                class="min-h-11 border border-[#b8b8b0] px-3"
                maxlength="20"
                required
            /></label>
            <label class="grid gap-1 text-sm"
              >Země<select
                v-model="draft.billing.countryCode"
                class="min-h-11 border border-[#b8b8b0] bg-white px-3"
                required
              >
                <option value="CZ">Česká republika</option>
                <option value="SK">Slovensko</option>
              </select></label
            >
          </div>
          <details class="border border-[#d9d9d2] p-4">
            <summary class="cursor-pointer font-semibold">
              Firemní údaje (volitelné)
            </summary>
            <div class="mt-4 grid gap-4 sm:grid-cols-3">
              <label class="grid gap-1 text-sm"
                >Název firmy<input
                  v-model="draft.billing.companyName"
                  class="min-h-11 border border-[#b8b8b0] px-3"
                  maxlength="200"
              /></label>
              <label class="grid gap-1 text-sm"
                >IČ<input
                  v-model="draft.billing.companyId"
                  class="min-h-11 border border-[#b8b8b0] px-3"
                  maxlength="50"
              /></label>
              <label class="grid gap-1 text-sm"
                >DIČ<input
                  v-model="draft.billing.vatId"
                  class="min-h-11 border border-[#b8b8b0] px-3"
                  maxlength="50"
              /></label>
            </div>
          </details>
        </fieldset>

        <fieldset class="checkout-card checkout-form__methods">
          <legend class="checkout-card__legend">
            <span class="checkout-card__index mono">03</span>
            Způsob platby
          </legend>
          <label
            v-for="method in paymentMethods"
            :key="method"
            class="checkout-method"
            :class="{ 'checkout-method--selected': draft.method === method }"
          >
            <input v-model="draft.method" type="radio" :value="method" />
            {{
              method === "CARD"
                ? "Platební karta"
                : "Bankovní tlačítko / převod"
            }}
          </label>
        </fieldset>

        <fieldset class="checkout-card checkout-form__legal">
          <legend class="checkout-card__legend">
            <span class="checkout-card__index mono">04</span>
            Potvrzení a souhlasy
          </legend>
          <p
            v-if="retryMode && retryEvidence"
            class="text-sm leading-6 text-[#54554c]"
          >
            Opakujete neúspěšný platební pokus s dříve zaznamenaným zněním VOP
            ({{ retryEvidence.termsRevision }}) a reklamačního řádu ({{
              retryEvidence.claimPolicyRevision
            }}).
            <NuxtLink
              v-if="hasHistoricalRevision(retryEvidence.terms.contentHash)"
              class="underline"
              :to="
                legalRevisionLink(
                  'terms',
                  retryEvidence.terms.revision,
                  retryEvidence.terms.contentHash,
                )
              "
              >Zobrazit VOP</NuxtLink
            >
            <span v-else>Historické znění VOP už není k dispozici</span>
            a
            <NuxtLink
              v-if="hasHistoricalRevision(retryEvidence.claims.contentHash)"
              class="underline"
              :to="
                legalRevisionLink(
                  'claims',
                  retryEvidence.claims.revision,
                  retryEvidence.claims.contentHash,
                )
              "
              >reklamační řád</NuxtLink
            >
            <span v-else
              >historické znění reklamačního řádu už není k dispozici</span
            >. Reklamační lhůta je {{ retryEvidence.claimWindowDays }} dní.
            <template v-if="retryEvidence.withdrawalExceptionAcknowledged">
              Výjimku z odstoupení jste při přijetí nabídky výslovně potvrdil/a.
            </template>
            <template v-else>
              Výjimku z odstoupení jste při přijetí nabídky nepotvrdil/a.
            </template>
            <template v-if="retryEvidence.photoPublicationConsent">
              Souhlas s pořízením a zveřejněním fotografií zůstává součástí
              přijaté nabídky podle
              <NuxtLink
                v-if="
                  retryEvidence.photoConsent &&
                  hasHistoricalRevision(retryEvidence.photoConsent.contentHash)
                "
                class="underline"
                :to="
                  legalRevisionLink(
                    'photoConsent',
                    retryEvidence.photoConsent.revision,
                    retryEvidence.photoConsent.contentHash,
                  )
                "
                >pravidel fotografování ({{
                  retryEvidence.photoConsentRevision
                }})</NuxtLink
              >
              <span v-else>historické znění pravidel už není k dispozici</span>.
            </template>
            <template v-else>
              Souhlas s pořízením a zveřejněním fotografií jste neudělil/a.
            </template>
            Tento záznam neměníme ani jej znovu nepotvrzujete.
          </p>
          <p
            v-else-if="retryMode"
            class="border-l-4 border-[#925b10] bg-[#fff8eb] p-4 text-sm leading-6"
          >
            Dříve zaznamenané právní souhlasy zůstávají součástí této objednávky
            a tento krok je pouze pro opakování platby. Ověřený kontext
            opakování se momentálně nepodařilo načíst, proto nelze souhlasy
            znovu měnit ani opakovaný pokus o platbu bezpečně odeslat.
          </p>
          <template v-else>
            <label class="flex items-start gap-3 text-sm leading-6"
              ><input
                v-model="draft.acceptTerms"
                class="mt-1"
                required
                type="checkbox"
              /><span
                >Souhlasím s
                <NuxtLink
                  class="underline"
                  :to="
                    legalRevisionLink(
                      'terms',
                      approvedDocuments?.termsRevision,
                      availability?.documents.terms.contentHash,
                    )
                  "
                  >VOP</NuxtLink
                >
                ve znění {{ approvedDocuments?.termsRevision }}.</span
              ></label
            >
            <label class="flex items-start gap-3 text-sm leading-6"
              ><input
                v-model="draft.acceptClaimPolicy"
                class="mt-1"
                required
                type="checkbox"
              /><span
                >Seznámil/a jsem se s
                <NuxtLink
                  class="underline"
                  :to="
                    legalRevisionLink(
                      'claims',
                      approvedDocuments?.claimPolicyRevision,
                      availability?.documents.claims.contentHash,
                    )
                  "
                  >reklamačním řádem</NuxtLink
                >
                ve znění {{ approvedDocuments?.claimPolicyRevision }}.</span
              ></label
            >
            <label class="flex items-start gap-3 text-sm leading-6"
              ><input
                v-model="draft.acknowledgeWithdrawalException"
                class="mt-1"
                required
                type="checkbox"
              /><span
                >Beru na vědomí, že výrobek je zhotoven podle mých požadavků a
                může se na něj vztahovat zákonná výjimka z práva odstoupit do 14
                dnů. Práva z vadného plnění tím nejsou dotčena.</span
              ></label
            >
            <label
              class="flex items-start gap-3 text-sm leading-6"
              :class="
                !approvedDocuments?.photoConsentRevision && 'text-[#777870]'
              "
              ><input
                v-model="draft.photoPublicationConsent"
                class="mt-1"
                type="checkbox"
                :disabled="!approvedDocuments?.photoConsentRevision"
              /><span
                >Dobrovolně souhlasím s pořízením a zveřejněním fotografií
                výsledku podle
                <NuxtLink
                  class="underline"
                  :to="
                    legalRevisionLink(
                      'photoConsent',
                      approvedDocuments?.photoConsentRevision,
                      availability?.documents.photoConsent.contentHash,
                    )
                  "
                  >pravidel fotografování</NuxtLink
                >.
                <span v-if="!approvedDocuments?.photoConsentRevision"
                  >Tato volba čeká na schválené znění.</span
                ></span
              ></label
            >
          </template>
        </fieldset>

        <p
          v-if="errorMessage"
          class="border-l-4 border-[#b4441a] bg-[#fff4ef] p-4 text-sm"
          role="alert"
        >
          {{ errorMessage }}
        </p>
      </form>

      <p
        v-if="errorMessage && (!approvedDocuments || payment)"
        class="mt-4 border-l-4 border-[#b4441a] bg-[#fff4ef] p-4 text-sm"
        role="alert"
      >
        {{ errorMessage }}
      </p>
    </div>

    <aside class="checkout-summary" aria-labelledby="checkout-summary-title">
      <header class="checkout-summary__heading">
        <div>
          <p class="eyebrow">SPECIFIKACE DÍLŮ</p>
          <h3 id="checkout-summary-title">
            Shrnutí zakázky / {{ quote.publicReference }}
          </h3>
        </div>
        <span class="checkout-summary__count mono"
          >{{ quote.items.length }}
          {{ quote.items.length === 1 ? "položka" : "položky" }}</span
        >
      </header>
      <ul class="checkout-summary__items">
        <li v-for="item in quote.items" :key="item.id">
          <p class="eyebrow">
            POLOŽKA {{ String(item.ordinal + 1).padStart(2, "0") }}
          </p>
          <strong>{{ itemDescription(item.modelFileId) }}</strong>
          <p>
            {{ item.material }} · {{ colorLabel(item.color) }} ·
            {{ qualityLabel(item.quality) }} · {{ item.quantity }} ks
          </p>
          <p class="checkout-summary__item-details">
            Výplň: {{ infillLabel(item.infillPreset) }} ·
            {{ item.bodyIds.length === 1 ? "Těleso" : "Tělesa" }}:
            {{ item.bodyIds.join(", ") }}
          </p>
          <small v-if="item.fitSensitive">Přesně lícující díl</small>
        </li>
      </ul>
      <div class="checkout-summary__edit"><slot name="edit" /></div>
      <dl class="checkout-summary__breakdown">
        <div v-for="component in priceComponents" :key="component.id">
          <dt>
            {{ priceLabel(component)
            }}<span v-if="component.itemOrdinal != null">
              · položka {{ component.itemOrdinal + 1 }}</span
            >
          </dt>
          <dd class="mono">
            {{ formatMoney(component.amountMinor, bindingPrice!.currency) }}
          </dd>
        </div>
        <div class="checkout-summary__delivery">
          <dt>Doručení</dt>
          <dd>{{ selectedDestination?.label || "Místo není vybráno" }}</dd>
        </div>
        <template v-if="bindingPrice?.taxRegime === 'VAT_PAYER'">
          <div class="checkout-summary__tax-start">
            <dt>Cena bez DPH</dt>
            <dd class="mono">
              {{
                formatMoney(bindingPrice.netAmountMinor, bindingPrice.currency)
              }}
            </dd>
          </div>
          <div>
            <dt>DPH {{ bindingPrice.vatRateBasisPoints / 100 }} %</dt>
            <dd class="mono">
              {{
                formatMoney(bindingPrice.vatAmountMinor, bindingPrice.currency)
              }}
            </dd>
          </div>
        </template>
      </dl>
      <div class="checkout-summary__total">
        <div>
          <p class="eyebrow">KONEČNÁ ZÁVAZNÁ CENA</p>
          <small v-if="bindingPrice?.taxRegime === 'NON_VAT_PAYER'"
            >Provozovatel není plátcem DPH</small
          >
          <small v-else-if="bindingPrice?.taxRegime === 'VAT_PAYER'"
            >Včetně DPH {{ bindingPrice.vatRateBasisPoints / 100 }} %</small
          >
        </div>
        <strong class="mono">{{
          bindingPrice?.totalMinor == null
            ? "Čeká na ověření"
            : formatMoney(bindingPrice.totalMinor, bindingPrice.currency)
        }}</strong>
      </div>
      <div class="checkout-summary__action">
        <button
          v-if="!payment && !loading && (approvedDocuments || retryMode)"
          class="primary-button"
          form="checkout-payment-form"
          type="submit"
          :disabled="!canSubmit"
        >
          {{
            submitting
              ? "Zakládáme platbu…"
              : redirecting
                ? "Přesměrováváme…"
                : `Objednat a zaplatit ${bindingPrice?.totalMinor == null ? "" : formatMoney(bindingPrice.totalMinor, bindingPrice.currency)}`
          }}
        </button>
        <p>
          Úspěch zobrazíme až po potvrzení platby serverem. Samotný návrat od
          poskytovatele objednávku nepotvrzuje.
        </p>
      </div>
    </aside>
  </section>
</template>

<style src="../../assets/css/order-checkout.css"></style>
