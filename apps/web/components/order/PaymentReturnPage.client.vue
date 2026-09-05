<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import {
  getSessionStorage,
  loadQuoteSession,
  type StoredQuoteSession,
} from "../../utils/quote-session-storage";
import {
  initialPaymentReturnPresentation,
  paymentReturnPresentation,
  type PaymentReturnKind,
} from "../../utils/payment-return";

type CheckoutPayment = components["schemas"]["CheckoutPaymentDto"];

const props = defineProps<{ returnKind: PaymentReturnKind }>();
const route = useRoute();
const { $api } = useNuxtApp();
const contacts = usePublicContacts();
const payment = shallowRef<CheckoutPayment>();
const session = shallowRef<StoredQuoteSession>();
const loading = ref(true);
const errorMessage = ref<string>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

const presentation = computed(() =>
  payment.value
    ? paymentReturnPresentation(payment.value.status)
    : initialPaymentReturnPresentation(props.returnKind),
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

onMounted(() => void refreshPayment());
onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer);
});

async function refreshPayment(): Promise<void> {
  if (refreshTimer) clearTimeout(refreshTimer);
  loading.value = true;
  errorMessage.value = undefined;
  try {
    const storage = getSessionStorage(window);
    const stored = storage ? loadQuoteSession(storage) : undefined;
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
    session.value = stored;
    const response = await $api.GET(
      "/automatic-quote-sessions/{sessionId}/checkout/payment",
      {
        params: {
          path: { sessionId: stored.sessionId },
          query: { paymentId: requestedPaymentId },
        },
        headers: { Authorization: `Bearer ${stored.sessionToken}` },
      },
    );
    if (!response.data) {
      throw new Error("Ověřený stav platby se nepodařilo načíst.");
    }
    payment.value = response.data;
    if (
      payment.value.status === "CREATED" ||
      payment.value.status === "PENDING"
    ) {
      refreshTimer = setTimeout(() => void refreshPayment(), 4_000);
    }
  } catch (error) {
    errorMessage.value =
      error instanceof Error
        ? error.message
        : "Ověřený stav platby se nepodařilo načíst.";
  } finally {
    loading.value = false;
  }
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
        <NuxtLink
          v-if="presentation.restartable"
          class="inline-flex min-h-12 items-center border border-[#1a1a16] px-6 font-semibold"
          to="/objednavka"
          no-prefetch
        >
          Zpět ke kalkulaci
        </NuxtLink>
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
