<script setup lang="ts">
import { publicSite } from "../content/public-site";

definePageMeta({ layout: "public" });

usePublicPageMeta({
  path: "/",
  description:
    "Nahraj hotový 3D model pro kontrolu a nacenění, nebo pošli samostatnou individuální poptávku přes " +
    publicSite.brand.name +
    ".",
});
</script>

<template>
  <div>
    <section class="border-b border-[#d9d9d2] bg-white">
      <div
        class="mx-auto grid max-w-6xl items-center gap-10 px-5 py-12 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,0.85fr)_minmax(28rem,1.15fr)] lg:gap-14"
      >
        <PublicHeroUpload class="lg:order-2" />
        <div class="lg:order-1">
          <p class="font-mono text-xs tracking-wider text-[#66675f] uppercase">
            Zakázkový 3D tisk
          </p>
          <h1
            class="mt-4 text-4xl leading-tight font-semibold tracking-tight sm:text-[38px]"
          >
            Nahraj model. Cenu spočítáme ze skutečných tiskových dat.
          </h1>
          <p class="mt-6 text-lg leading-8 text-[#54554c]">
            Hotový <span class="font-mono">STL</span> nebo
            <span class="font-mono">3MF</span> projde kontrolou geometrie a
            referenčním slicingem. Bez e-mailového kolečka a bez ručně
            odhadované výrobní ceny.
          </p>
        </div>
      </div>
    </section>

    <section class="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
      <div class="max-w-2xl">
        <h2 class="text-3xl font-semibold tracking-tight sm:text-4xl">
          Od souboru k objednávce ve třech krocích
        </h2>
      </div>
      <div class="mt-10 max-w-3xl border-l-4 border-[#1b44e8] pl-6 sm:pl-8">
        <article class="pb-8">
          <h3 class="text-xl font-semibold">Nahraješ model</h3>
          <p class="mt-3 leading-7 text-[#54554c]">
            Přijímáme <span class="font-mono">STL</span> a podporované
            <span class="font-mono">3MF</span>. Před nahráním uvidíš rozměry a
            základní kontrolu souboru.
          </p>
        </article>
        <article class="border-t border-[#d9d9d2] py-8">
          <h3 class="text-xl font-semibold">Zvolíš parametry</h3>
          <p class="mt-3 leading-7 text-[#54554c]">
            Vybereš materiál, dostupnou barvu, kvalitu, výplň a počet kusů.
          </p>
        </article>
        <article class="border-t border-[#d9d9d2] pt-8">
          <h3 class="text-xl font-semibold">Potvrdíš aktuální cenu</h3>
          <p class="mt-3 leading-7 text-[#54554c]">
            Výrobní cenu určí slicing. Závazný celkový součet vznikne až po
            volbě doručení a nové kontrole dostupnosti.
          </p>
        </article>
      </div>
      <NuxtLink
        class="mt-7 inline-block font-semibold text-[#1a1a16] underline decoration-[#1b44e8] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
        to="/jak-to-funguje"
      >
        Podrobný popis procesu
      </NuxtLink>
    </section>

    <section class="border-y border-[#d9d9d2] bg-white">
      <div class="mx-auto grid max-w-6xl gap-px bg-[#d9d9d2] md:grid-cols-2">
        <article class="bg-white px-5 py-12 sm:px-8">
          <h2 class="text-2xl font-semibold">Máš tisknutelný soubor</h2>
          <p class="mt-4 max-w-lg leading-7 text-[#54554c]">
            Konfigurátor je určený pro modely, které můžeme automaticky
            zkontrolovat a ocenit. Pokud kontrola najde problém, nabídne
            bezpečný přechod do individuální poptávky.
          </p>
          <NuxtLink
            v-if="publicSite.commercial.automaticQuotePubliclyEnabled"
            class="mt-6 inline-flex min-h-11 items-center bg-[#1b44e8] px-5 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a16]"
            to="/objednavka"
            no-prefetch
          >
            Nahrát model
          </NuxtLink>
          <span
            v-else
            class="mt-6 inline-flex min-h-11 cursor-not-allowed items-center border border-[#9b9c93] px-5 font-semibold text-[#66675f]"
            aria-disabled="true"
          >
            Kalkulace čeká na schválení
          </span>
        </article>
        <article class="bg-[#efefea] px-5 py-12 sm:px-8">
          <h2 class="text-2xl font-semibold">
            Máš díl, nápad nebo nestandardní zadání
          </h2>
          <p class="mt-4 max-w-lg leading-7 text-[#54554c]">
            Pošli popis, účel, rozměry a případné fotografie. Poptávka vznikne
            jako samostatný záznam a neslibuje automatickou cenu.
          </p>
          <NuxtLink
            class="mt-6 inline-block font-semibold text-[#1a1a16] underline decoration-[#1b44e8] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
            to="/poptavka"
            no-prefetch
          >
            Popsat zadání
          </NuxtLink>
        </article>
      </div>
    </section>

    <section
      class="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 sm:py-20 md:grid-cols-2"
    >
      <div>
        <h2 class="text-3xl font-semibold tracking-tight">
          Čísla ukážeme až po jejich schválení
        </h2>
        <p class="mt-5 leading-7 text-[#54554c]">
          Veřejná cena „od“ ani standardní dodací lhůta zatím nejsou schválené.
          Hrubý odhad doplníme až ze schválených cenových vstupů. Přesnou
          výrobní cenu určí až aktuální slice.
        </p>
        <NuxtLink
          class="mt-6 inline-block font-semibold text-[#1a1a16] underline decoration-[#1b44e8] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
          to="/cenik"
        >
          Jak cenu počítáme
        </NuxtLink>
      </div>
      <div>
        <h2 class="text-3xl font-semibold tracking-tight">
          Jen vlastní a schválené výtisky
        </h2>
        <p class="mt-5 leading-7 text-[#54554c]">
          Portfolio je zatím prázdné. Fotografie doplníme až po schválení
          konkrétních vlastních podkladů a souhlasu s jejich zveřejněním.
        </p>
        <NuxtLink
          class="mt-6 inline-block font-semibold text-[#1a1a16] underline decoration-[#1b44e8] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
          to="/ukazky"
        >
          Stav portfolia
        </NuxtLink>
      </div>
    </section>

    <section class="border-t border-[#d9d9d2] bg-white">
      <div class="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
        <h2 class="max-w-2xl text-3xl font-semibold tracking-tight">
          Za zakázku ručí {{ publicSite.brand.name }}
        </h2>
        <p class="mt-5 max-w-2xl leading-7 text-[#54554c]">
          Prodávajícím a odpovědným provozovatelem je
          <span class="font-mono">{{ publicSite.seller.legalName }}</span
          >. Závaznou cenu uvidíš před platbou. Každý výtisk zkontrolujeme a
          před odesláním uvidíš fotografii hotového dílu. Výroba, kontrola i
          předání jsou součástí jedné služby; neobjednáváš u anonymního výrobce.
        </p>
      </div>
    </section>
  </div>
</template>
