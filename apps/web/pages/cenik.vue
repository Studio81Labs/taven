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
  <article class="public-page">
    <header class="public-page__intro">
      <div>
        <p class="public-page__index">Ceník / 01</p>
        <h1>Cena podle skutečného tisku</h1>
      </div>
      <p>
        Veřejná cena „od“ ani vstupy pro hrubý cenový odhad ještě nebyly
        schváleny. Přesnou výrobní cenu určí referenční slicing konkrétní
        konfigurace.
      </p>
    </header>
    <p
      v-if="redirectedFromAutomaticQuote"
      class="public-note public-note--warning mt-6"
      role="status"
    >
      Automatická kalkulace zatím není veřejně dostupná. Čeká na schválené
      cenové vstupy.
    </p>

    <dl class="public-rule-list public-section">
      <div>
        <dt class="font-semibold">Model a konfigurace</dt>
        <dd class="leading-7 text-[#54554c]">
          Geometrie, materiál, kvalita, výplň a počet kusů určují referenční
          tisková data.
        </dd>
      </div>
      <div>
        <dt class="font-semibold">Výrobní náklady</dt>
        <dd class="leading-7 text-[#54554c]">
          Cena vychází ze spotřeby materiálu, času stroje, práce, přípravy a
          souvisejících nákladů podle aktuálního ceníku.
        </dd>
      </div>
      <div>
        <dt class="font-semibold">Doručení a dostupnost</dt>
        <dd class="leading-7 text-[#54554c]">
          Doprava a celkový součet jsou konečné až po volbě podporovaného místa
          doručení a opětovném ověření dostupnosti před platbou.
        </dd>
      </div>
    </dl>

    <aside class="public-note public-section">
      <h2 class="text-xl font-semibold">Hodnoty čekající na schválení</h2>
      <p class="mt-3 leading-7 text-[#54554c]">
        Cena „od“ a standardní dodací lhůta budou doplněny z jednoho
        konfigurovatelného zdroje. Stejná schvalovací hranice platí pro vstupy
        hrubého odhadu.
      </p>
    </aside>

    <NuxtLink
      v-if="automaticQuoteEnabled"
      class="public-action mt-8"
      to="/objednavka"
      no-prefetch
    >
      Nahrát model a zjistit cenu
    </NuxtLink>
    <span v-else class="public-action mt-8" aria-disabled="true">
      Kalkulace čeká na schválení
    </span>
  </article>
</template>
