<script setup lang="ts">
import { publicSite } from "../content/public-site";

definePageMeta({ layout: "public" });

const route = useRoute();
const automaticQuoteEnabled = useAutomaticQuoteEnabled();
const redirectedFromAutomaticQuote = computed(
  () => route.query.stav === "ceka-na-schvaleni-cen",
);

usePublicPageMeta({
  path: "/cenik",
  title: "Ceník",
  description:
    "Jak " +
    publicSite.brand.name +
    " počítá cenu zakázkového 3D tisku a kdy vznikne závazný celkový součet.",
});
</script>

<template>
  <article class="mx-auto max-w-4xl px-5 py-14 sm:px-8 sm:py-20">
    <p class="font-mono text-xs tracking-wider text-[#66675f] uppercase">
      Ceník
    </p>
    <h1 class="mt-3 text-4xl font-semibold tracking-tight sm:text-[38px]">
      Cena podle skutečného tisku
    </h1>
    <p class="mt-6 max-w-2xl text-lg leading-8 text-[#54554c]">
      Veřejná cena „od“ ani vstupy pro hrubý cenový odhad ještě nebyly
      schváleny. Přesnou výrobní cenu určí referenční slicing konkrétní
      konfigurace.
    </p>
    <p
      v-if="redirectedFromAutomaticQuote"
      class="mt-6 max-w-2xl border-l-4 border-[#925b10] bg-white p-4 leading-7"
      role="status"
    >
      Automatická kalkulace zatím není veřejně dostupná. Čeká na schválené
      cenové vstupy.
    </p>

    <dl
      class="mt-12 divide-y divide-[#d9d9d2] border-y border-[#d9d9d2] bg-white"
    >
      <div class="grid gap-2 p-6 sm:grid-cols-[13rem_1fr] sm:p-8">
        <dt class="font-semibold">Model a konfigurace</dt>
        <dd class="leading-7 text-[#54554c]">
          Geometrie, materiál, kvalita, výplň a počet kusů určují referenční
          tisková data.
        </dd>
      </div>
      <div class="grid gap-2 p-6 sm:grid-cols-[13rem_1fr] sm:p-8">
        <dt class="font-semibold">Výrobní náklady</dt>
        <dd class="leading-7 text-[#54554c]">
          Cena vychází ze spotřeby materiálu, času stroje, práce, přípravy a
          souvisejících nákladů podle aktuálního ceníku.
        </dd>
      </div>
      <div class="grid gap-2 p-6 sm:grid-cols-[13rem_1fr] sm:p-8">
        <dt class="font-semibold">Doručení a dostupnost</dt>
        <dd class="leading-7 text-[#54554c]">
          Doprava a celkový součet jsou konečné až po volbě podporovaného místa
          doručení a opětovném ověření dostupnosti před platbou.
        </dd>
      </div>
    </dl>

    <aside class="mt-10 border border-[#d9d9d2] bg-white p-6 sm:p-8">
      <h2 class="text-xl font-semibold">Hodnoty čekající na schválení</h2>
      <p class="mt-3 leading-7 text-[#54554c]">
        Cena „od“ a standardní dodací lhůta budou doplněny z jednoho
        konfigurovatelného zdroje. Stejná schvalovací hranice platí pro vstupy
        hrubého odhadu.
      </p>
    </aside>

    <NuxtLink
      v-if="automaticQuoteEnabled"
      class="mt-8 inline-flex min-h-12 items-center bg-[#1b44e8] px-6 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a16]"
      to="/objednavka"
      no-prefetch
    >
      Nahrát model a zjistit cenu
    </NuxtLink>
    <span
      v-else
      class="mt-8 inline-flex min-h-12 cursor-not-allowed items-center border border-[#9b9c93] px-6 font-semibold text-[#66675f]"
      aria-disabled="true"
    >
      Kalkulace čeká na schválení
    </span>
  </article>
</template>
