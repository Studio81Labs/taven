<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import {
  clearQuoteSession,
  getSessionStorage,
  loadPaymentReturnSession,
  type StoredQuoteSession,
} from "../../utils/quote-session-storage";
import {
  clearCheckoutSession,
  loadCheckoutSession,
  redactCheckoutCustomerInput,
} from "../../utils/checkout-session-storage";
import {
  initialPaymentReturnPresentation,
  paymentRestartMode,
  paymentReturnPresentation,
  type PaymentReturnKind,
} from "../../utils/payment-return";
import { paymentReturnMatchesHandoff } from "../../utils/checkout-flow";

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
const restartMode = computed(() =>
  payment.value ? paymentRestartMode(payment.value.status) : null,
);
const toneClass = computed(() => {
  switch (presentation.value.tone) {
    case "success":
      return "border-[#1b44e8]";
    case "failure":
      return "border-[#b4441a]";
    case "refund":
      return "border-[#6e6f66]";
    default:
      return "border-[#925b10]";
  }
});

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
      redactCheckoutCustomerInput(storage, stored.sessionId);
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
  <article class="mx-auto max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
    <section
      class="border-l-4 bg-white px-6 py-8 sm:px-10 sm:py-12"
      :class="toneClass"
      :aria-busy="loading"
      :role="errorMessage ? 'alert' : 'status'"
    >
      <p class="font-mono text-xs tracking-wider text-[#66675f] uppercase">
        {{ presentation.label }}
      </p>
      <h1 class="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
        {{ presentation.title }}
      </h1>
      <p class="mt-5 max-w-xl text-lg leading-8 text-[#54554c]">
        {{ errorMessage || presentation.description }}
      </p>
      <p
        v-if="session?.publicReference"
        class="mt-5 font-mono text-sm text-[#54554c]"
      >
        Reference {{ session.publicReference }}
      </p>

      <div class="mt-8 flex flex-wrap gap-4">
        <button
          v-if="errorMessage || presentation.refreshable"
          class="inline-flex min-h-12 items-center bg-[#1b44e8] px-6 font-semibold text-white disabled:cursor-wait disabled:opacity-60"
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
          class="inline-flex min-h-12 items-center border border-[#1a1a16] px-6 font-semibold disabled:cursor-wait disabled:opacity-60"
          type="button"
          :disabled="cancelling"
          @click="cancelPayment"
        >
          {{ cancelling ? "Rušíme…" : "Opravdu zrušit platební pokus" }}
        </button>
        <NuxtLink
          v-if="restartMode === 'PAYMENT'"
          class="inline-flex min-h-12 items-center border border-[#1a1a16] px-6 font-semibold"
          to="/objednavka"
          no-prefetch
        >
          Zpět ke kalkulaci
        </NuxtLink>
        <button
          v-if="restartMode === 'QUOTE'"
          class="inline-flex min-h-12 items-center border border-[#1a1a16] px-6 font-semibold"
          type="button"
          @click="startFreshQuote"
        >
          Začít novou kalkulaci
        </button>
        <NuxtLink
          class="inline-flex min-h-12 items-center px-2 font-semibold underline decoration-[#1b44e8] decoration-2 underline-offset-4"
          to="/"
        >
          Na hlavní stránku
        </NuxtLink>
      </div>
    </section>

    <div class="mt-6 text-sm leading-6 text-[#66675f]">
      <p>Pokud stav neodpovídá očekávání, napište nám:</p>
      <a
        class="mt-1 inline-block underline decoration-[#6e6f66] underline-offset-4 hover:decoration-[#1b44e8]"
        :href="contacts.customer.href"
      >
        {{ contacts.customer.email }}
      </a>
      <p class="mt-3">
        Stav platby nikdy neurčujeme jen podle návratové adresy poskytovatele.
      </p>
    </div>
  </article>
</template>
