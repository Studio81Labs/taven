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

type CheckoutPayment = components["schemas"]["CheckoutPaymentDto"];
type CreateCheckoutPayment = components["schemas"]["CreateCheckoutPaymentDto"];
type PaymentCapabilities = components["schemas"]["PaymentCapabilitiesDto"];
const CHECKOUT_OBSERVATION_TIMEOUT_MS = 1_000;

const props = defineProps<{
  quote: QuoteSession;
  onRefresh: () => Promise<void>;
  onRestart: () => void;
}>();
const { $api } = useNuxtApp();
const { availability, refresh: refreshLegalAvailability } =
  useLegalAvailability();
const form = ref<HTMLFormElement>();
const credentials = shallowRef<StoredQuoteSession>();
const capabilities = shallowRef<PaymentCapabilities>();
const payment = shallowRef<CheckoutPayment>();
const command = shallowRef<CheckoutCommandHandoff>();
const loading = ref(true);
const submitting = ref(false);
const cancelling = ref(false);
const redirecting = ref(false);
const errorMessage = ref<string>();
const initialized = ref(false);

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
const approvedDocuments = computed(() =>
  approvedCheckoutDocuments(
    capabilities.value,
    localDocumentIds,
    availability.value,
  ),
);
watch(approvedDocuments, (documents) => {
  if (!documents?.photoConsentRevision) draft.photoPublicationConsent = false;
});
const bindingPrice = computed(() => props.quote.bindingQuote ?? null);
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
      approvedDocuments.value &&
      bindingPrice.value?.kind === "BINDING" &&
      selectedDestination.value &&
      draft.acceptTerms &&
      draft.acceptClaimPolicy &&
      draft.acknowledgeWithdrawalException &&
      capabilities.value?.methods.includes(draft.method),
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
  await loadCapabilities();
  await refreshLegalAvailability();
  if (command.value?.paymentId) await refreshPayment();
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
    if (!response.data.methods.includes(draft.method)) {
      draft.method = response.data.methods[0] ?? "CARD";
    }
  } catch {
    errorMessage.value =
      "Dostupné platební metody se nepodařilo bezpečně ověřit.";
  }
}

async function submitCheckout(): Promise<void> {
  if (!form.value?.reportValidity() || !canSubmit.value) return;
  await refreshLegalAvailability();
  const session = credentials.value;
  const documents = approvedDocuments.value;
  if (!session || !documents) return;
  if (draft.photoPublicationConsent && !documents.photoConsentRevision) {
    errorMessage.value =
      "Dobrovolný souhlas s fotografiemi zatím nemá schválené znění.";
    return;
  }

  const body: CreateCheckoutPayment = {
    email: draft.email,
    fullName: draft.fullName,
    billing: compactBilling(draft.billing),
    method: draft.method,
    acceptTerms: draft.acceptTerms,
    acceptClaimPolicy: draft.acceptClaimPolicy,
    acknowledgeWithdrawalException: draft.acknowledgeWithdrawalException,
    termsRevision: documents.termsRevision,
    claimPolicyRevision: documents.claimPolicyRevision,
    photoPublicationConsent: draft.photoPublicationConsent,
    photoConsentRevision: draft.photoPublicationConsent
      ? documents.photoConsentRevision
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
  submitting.value = true;
  errorMessage.value = undefined;
  await recordCheckoutStartedBeforePayment();
  try {
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
    await continueFromPayment(result.data);
  } catch {
    errorMessage.value = checkoutErrorMessage(0);
  } finally {
    submitting.value = false;
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

function startNewAttempt(): void {
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
    class="mt-8 border border-[#d9d9d2] bg-white p-5 sm:p-8"
    aria-labelledby="checkout-title"
  >
    <p class="font-mono text-xs tracking-wider text-[#66675f] uppercase">
      04 — objednání a platba
    </p>
    <h3 id="checkout-title" class="mt-2 text-2xl font-semibold">
      Dokončení objednávky
    </h3>

    <div class="mt-6 grid gap-3 bg-[#efefea] p-4 text-sm sm:grid-cols-3">
      <div>
        <p class="text-[#66675f]">Reference</p>
        <p class="mt-1 font-mono font-semibold">{{ quote.publicReference }}</p>
      </div>
      <div>
        <p class="text-[#66675f]">Doručení</p>
        <p class="mt-1 font-semibold">
          {{ selectedDestination?.label || "Chybí výběr" }}
        </p>
      </div>
      <div>
        <p class="text-[#66675f]">Konečná cena</p>
        <p class="mt-1 font-mono font-semibold">
          {{
            bindingPrice?.totalMinor == null
              ? "Chybí"
              : formatMoney(bindingPrice.totalMinor, bindingPrice.currency)
          }}
        </p>
      </div>
    </div>

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
      v-else-if="!approvedDocuments"
      class="mt-6 border-l-4 border-[#925b10] bg-[#fff8eb] p-5"
      role="status"
    >
      <h4 class="font-semibold">Objednávku zatím nelze zaplatit.</h4>
      <p class="mt-2 text-sm leading-6 text-[#54554c]">
        Platební krok zůstává vypnutý, dokud nejsou na serveru i webu zveřejněna
        stejná schválená znění obchodních podmínek a reklamačního řádu. Aktuální
        návrhy jsou pouze podklady k dokončení systému.
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
      ref="form"
      class="mt-7 grid gap-7"
      @submit.prevent="submitCheckout"
    >
      <fieldset class="grid gap-4">
        <legend class="text-lg font-semibold">
          Kontakt a fakturační údaje
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

      <fieldset class="grid gap-3">
        <legend class="text-lg font-semibold">Způsob platby</legend>
        <label
          v-for="method in capabilities?.methods"
          :key="method"
          class="flex min-h-11 items-center gap-3 border border-[#d9d9d2] px-4"
        >
          <input v-model="draft.method" type="radio" :value="method" />
          {{
            method === "CARD" ? "Platební karta" : "Bankovní tlačítko / převod"
          }}
        </label>
      </fieldset>

      <fieldset class="grid gap-4">
        <legend class="text-lg font-semibold">Potvrzení</legend>
        <label class="flex items-start gap-3 text-sm leading-6"
          ><input
            v-model="draft.acceptTerms"
            class="mt-1"
            required
            type="checkbox"
          /><span
            >Souhlasím s
            <NuxtLink class="underline" :to="legalDocuments.terms.path"
              >VOP</NuxtLink
            >
            ve znění {{ approvedDocuments.termsRevision }}.</span
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
            <NuxtLink class="underline" :to="legalDocuments.claims.path"
              >reklamačním řádem</NuxtLink
            >
            ve znění {{ approvedDocuments.claimPolicyRevision }}.</span
          ></label
        >
        <label class="flex items-start gap-3 text-sm leading-6"
          ><input
            v-model="draft.acknowledgeWithdrawalException"
            class="mt-1"
            required
            type="checkbox"
          /><span
            >Beru na vědomí, že výrobek je zhotoven podle mých požadavků a může
            se na něj vztahovat zákonná výjimka z práva odstoupit do 14 dnů.
            Práva z vadného plnění tím nejsou dotčena.</span
          ></label
        >
        <label
          class="flex items-start gap-3 text-sm leading-6"
          :class="!approvedDocuments.photoConsentRevision && 'text-[#777870]'"
          ><input
            v-model="draft.photoPublicationConsent"
            class="mt-1"
            type="checkbox"
            :disabled="!approvedDocuments.photoConsentRevision"
          /><span
            >Dobrovolně souhlasím s pořízením a zveřejněním fotografií výsledku
            podle
            <NuxtLink class="underline" :to="legalDocuments.photoConsent.path"
              >pravidel fotografování</NuxtLink
            >.
            <span v-if="!approvedDocuments.photoConsentRevision"
              >Tato volba čeká na schválené znění.</span
            ></span
          ></label
        >
      </fieldset>

      <p
        v-if="errorMessage"
        class="border-l-4 border-[#b4441a] bg-[#fff4ef] p-4 text-sm"
        role="alert"
      >
        {{ errorMessage }}
      </p>
      <button
        class="min-h-12 bg-[#1b44e8] px-6 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
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
      <p class="text-xs leading-5 text-[#66675f]">
        Úspěch zobrazíme až po ověřeném potvrzení platby backendem. Samotný
        návrat od poskytovatele objednávku nepotvrzuje.
      </p>
    </form>

    <p
      v-if="errorMessage && (!approvedDocuments || payment)"
      class="mt-4 border-l-4 border-[#b4441a] bg-[#fff4ef] p-4 text-sm"
      role="alert"
    >
      {{ errorMessage }}
    </p>
  </section>
</template>
