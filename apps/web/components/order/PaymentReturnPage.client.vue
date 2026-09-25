<script setup lang="ts">
import ApplicationShell from "../application/ApplicationShell.vue";
import type { components } from "@taven/openapi-client";
import {
  clearQuoteSession,
  getSessionStorage,
  loadPaymentReturnSession,
  type StoredQuoteSession,
} from "../../utils/quote-session-storage";
import {
  clearCheckoutSession,
  finalizeCapturedCheckoutStorage,
  loadCheckoutSession,
} from "../../utils/checkout-session-storage";
import {
  initialPaymentReturnPresentation,
  paymentRestartMode,
  paymentReturnPresentation,
  type PaymentReturnKind,
} from "../../utils/payment-return";
import { paymentReturnMatchesHandoff } from "../../utils/checkout-flow";
import { formatMoney } from "../../utils/automatic-quote-configurator";

type CheckoutPayment = components["schemas"]["CheckoutPaymentDto"];

const props = defineProps<{ returnKind: PaymentReturnKind }>();
const route = useRoute();
const { $api } = useNuxtApp();
const contacts = usePublicContacts();
const payment = shallowRef<CheckoutPayment>();
const session = shallowRef<StoredQuoteSession>();
const loading = ref(true);
const cancelling = ref(false);
const errorMessage = ref<string>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let requestController: AbortController | undefined;
let disposed = false;

const presentation = computed(() =>
  payment.value
    ? paymentReturnPresentation(payment.value.status)
    : initialPaymentReturnPresentation(props.returnKind),
);
const orderSteps = [
  { index: "01", label: "SOUBOR" },
  { index: "02", label: "KONFIGURACE" },
  { index: "03", label: "DOPRAVA" },
  { index: "04", label: "PLATBA" },
  { index: "05", label: "VÝROBA" },
] as const;
const activeStep = computed(() =>
  payment.value?.status === "CAPTURED" ? 5 : 4,
);
const orderSummary = computed(() =>
  payment.value
    ? `OBJ. / ${formatMoney(payment.value.amountMinor, payment.value.currency)}`
    : undefined,
);
const restartMode = computed(() =>
  payment.value ? paymentRestartMode(payment.value.status) : null,
);
const paymentRetryDestination = computed(() =>
  session.value?.sessionId
    ? {
        path: "/objednavka",
        query: { retry: "1", sessionId: session.value.sessionId },
      }
    : "/objednavka",
);

onMounted(() => {
  disposed = false;
  void refreshPayment();
});
onBeforeUnmount(() => {
  disposed = true;
  requestController?.abort();
  requestController = undefined;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
});

async function refreshPayment(): Promise<void> {
  if (disposed) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  loading.value = true;
  errorMessage.value = undefined;
  try {
    const storage = getSessionStorage(window);
    if (!storage) {
      throw new Error(
        "Uložená relace objednávky není v tomto prohlížeči dostupná.",
      );
    }
    const stored = loadPaymentReturnSession(storage);
    if (!stored) {
      throw new Error(
        "Uložená relace objednávky není v tomto prohlížeči dostupná.",
      );
    }
    const requestedSessionId = queryValue(route.query.sessionId);
    if (requestedSessionId && requestedSessionId !== stored.sessionId) {
      throw new Error("Návrat neodpovídá uložené relaci objednávky.");
    }
    const requestedPaymentId = queryValue(route.query.paymentId);
    if (!requestedPaymentId) {
      throw new Error("Návrat neobsahuje identifikátor platby.");
    }
    const checkout = loadCheckoutSession(storage, stored.sessionId);
    if (
      !paymentReturnMatchesHandoff(
        checkout?.command?.paymentId,
        requestedPaymentId,
      )
    ) {
      throw new Error("Návrat neodpovídá uloženému platebnímu pokusu.");
    }
    session.value = stored;
    const response = await $api.GET(
      "/automatic-quote-sessions/{sessionId}/checkout/payment",
      {
        params: {
          path: { sessionId: stored.sessionId },
          query: { paymentId: requestedPaymentId },
        },
        headers: { Authorization: `Bearer ${stored.sessionToken}` },
        signal: controller.signal,
      },
    );
    if (disposed || controller.signal.aborted) return;
    if (!response.data) {
      throw new Error("Ověřený stav platby se nepodařilo načíst.");
    }
    payment.value = response.data;
    if (payment.value.status === "CAPTURED") {
      finalizeCapturedCheckoutStorage(
        storage,
        stored.sessionId,
        payment.value.paymentId,
      );
    }
    if (
      payment.value.status === "CREATED" ||
      payment.value.status === "PENDING"
    ) {
      refreshTimer = setTimeout(() => void refreshPayment(), 4_000);
    }
  } catch (error) {
    if (disposed || controller.signal.aborted) return;
    errorMessage.value =
      error instanceof Error
        ? error.message
        : "Ověřený stav platby se nepodařilo načíst.";
  } finally {
    if (requestController === controller) requestController = undefined;
    if (!disposed && !controller.signal.aborted) loading.value = false;
  }
}

async function cancelPayment(): Promise<void> {
  const stored = session.value;
  const activePayment = payment.value;
  if (
    !stored ||
    !activePayment ||
    (activePayment.status !== "CREATED" && activePayment.status !== "PENDING")
  ) {
    return;
  }
  cancelling.value = true;
  errorMessage.value = undefined;
  try {
    const response = await $api.DELETE(
      "/automatic-quote-sessions/{sessionId}/checkout/payment",
      {
        params: {
          path: { sessionId: stored.sessionId },
          query: { paymentId: activePayment.paymentId },
        },
        headers: { Authorization: `Bearer ${stored.sessionToken}` },
      },
    );
    if (!response.data) {
      throw new Error("Platební pokus se nepodařilo zrušit.");
    }
    payment.value = response.data;
  } catch (error) {
    errorMessage.value =
      error instanceof Error
        ? error.message
        : "Platební pokus se nepodařilo zrušit.";
  } finally {
    cancelling.value = false;
  }
}

async function startFreshQuote(): Promise<void> {
  const storage = getSessionStorage(window);
  if (storage) {
    clearCheckoutSession(storage);
    clearQuoteSession(storage);
  }
  await navigateTo("/objednavka");
}

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
</script>

<template>
  <ApplicationShell
    :steps="orderSteps"
    :active-step="activeStep"
    :summary="orderSummary"
    navigation-label="Průběh objednávky"
  >
    <template #workspace>
      <div class="payment-return-workspace">
        <section
          class="payment-return-card"
          :class="`payment-return-card--${presentation.tone}`"
          :aria-busy="loading"
          :role="errorMessage ? 'alert' : 'status'"
          aria-labelledby="payment-return-title"
        >
          <p class="eyebrow">{{ presentation.label }}</p>
          <h1 id="payment-return-title">{{ presentation.title }}</h1>
          <p>{{ errorMessage || presentation.description }}</p>
          <p
            v-if="session?.publicReference"
            class="payment-return-card__reference mono"
          >
            Reference {{ session.publicReference }}
          </p>
          <div class="payment-return-card__actions">
            <button
              v-if="errorMessage || presentation.refreshable"
              class="primary-button"
              type="button"
              :disabled="loading"
              @click="refreshPayment"
            >
              {{ loading ? "Načítáme…" : "Načíst aktuální stav" }}
            </button>
            <button
              v-if="
                returnKind === 'cancelled' &&
                (payment?.status === 'CREATED' || payment?.status === 'PENDING')
              "
              class="secondary-button"
              type="button"
              :disabled="cancelling"
              @click="cancelPayment"
            >
              {{ cancelling ? "Rušíme…" : "Opravdu zrušit platební pokus" }}
            </button>
            <NuxtLink
              v-if="restartMode === 'PAYMENT'"
              class="secondary-button"
              :to="paymentRetryDestination"
              no-prefetch
            >
              Zpět ke kalkulaci
            </NuxtLink>
            <button
              v-if="restartMode === 'QUOTE'"
              class="secondary-button"
              type="button"
              @click="startFreshQuote"
            >
              Začít novou kalkulaci
            </button>
            <NuxtLink class="text-button" to="/">Na hlavní stránku</NuxtLink>
          </div>
        </section>
        <section
          class="payment-return-note"
          aria-labelledby="payment-return-note-title"
        >
          <p class="eyebrow">OVĚŘENÝ STAV</p>
          <h2 id="payment-return-note-title">Bezpečné potvrzení</h2>
          <p>
            Stav platby nikdy neurčujeme jen podle návratové adresy
            poskytovatele. Úspěch znamená až potvrzené přijetí platby serverem.
          </p>
          <p>
            Pokud stav neodpovídá očekávání, napište nám na
            <a :href="contacts.customer.href">{{ contacts.customer.email }}</a
            >.
          </p>
        </section>
      </div>
    </template>
    <template #context>
      <aside
        class="payment-return-context"
        aria-labelledby="payment-record-title"
      >
        <div class="payment-return-context__heading">
          <p class="eyebrow">DOKLAD O STAVU PLATBY</p>
          <h2 id="payment-record-title">
            {{ session?.publicReference || "Ověřujeme zakázku" }}
          </h2>
        </div>
        <dl v-if="payment" class="payment-return-context__facts">
          <div>
            <dt>Stav</dt>
            <dd>{{ presentation.title }}</dd>
          </div>
          <div>
            <dt>Metoda</dt>
            <dd>
              {{
                payment.method === "CARD" ? "Platební karta" : "Bankovní převod"
              }}
            </dd>
          </div>
          <div>
            <dt>Částka</dt>
            <dd class="mono">
              {{ formatMoney(payment.amountMinor, payment.currency) }}
            </dd>
          </div>
          <div>
            <dt>Identifikátor platby</dt>
            <dd class="mono">{{ payment.paymentId }}</dd>
          </div>
        </dl>
        <p v-else class="payment-return-context__pending">
          {{
            loading
              ? "Načítáme ověřený záznam platby…"
              : "Záznam platby zatím není dostupný."
          }}
        </p>
        <p class="payment-return-context__footnote">
          Tato stránka neprokazuje zahájení výroby, odeslání e-mailu ani stav
          doručení.
        </p>
      </aside>
    </template>
  </ApplicationShell>
</template>

<style src="../../assets/css/application.css"></style>
<style src="../../assets/css/order-payment-return.css"></style>
