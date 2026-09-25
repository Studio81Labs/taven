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

const rules = [
  {
    number: "01",
    title: "Model a konfigurace",
    description:
      "Geometrie, materiál, dostupná barva, kvalita, výplň a množství vstupují do referenčního řezu.",
    value: "VSTUPY PRO SLICING",
  },
  {
    number: "02",
    title: "Skutečné výrobní náklady",
    description:
      "Cena vychází ze spotřeby materiálu, času stroje, přípravy, práce a aktuálního ceníku.",
    value: "PODLE KONKRÉTNÍHO TISKU",
  },
  {
    number: "03",
    title: "Doručení",
    description:
      "Dostupnost a cenu dopravy ověříme podle vybraného podporovaného místa před platbou.",
    value: "SOUČÁST CELKOVÉ CENY",
  },
] as const;
const factors = [
  {
    number: "01",
    tag: "GEOMETRIE",
    title: "Dráhy trysky",
    description: "Rozměry a tvar modelu určují dráhy, nikoli samy o sobě cenu.",
  },
  {
    number: "02",
    tag: "MATERIÁL",
    title: "Spotřeba materiálu",
    description:
      "Řez zahrnuje materiál dílu a spotřebu potřebnou pro zvolenou konfiguraci.",
  },
  {
    number: "03",
    tag: "PODPĚRY",
    title: "Podpěry a práce",
    description: "Podpěrná struktura může změnit spotřebu i následnou práci.",
  },
  {
    number: "04",
    tag: "STROJ",
    title: "Výrobní čas",
    description: "Čas stroje vychází z konkrétního řezu modelu.",
  },
  {
    number: "05",
    tag: "ROZLIŠENÍ",
    title: "Kvalita tisku",
    description: "Výška vrstvy mění počet vrstev a dobu výroby.",
  },
  {
    number: "06",
    tag: "MNOŽSTVÍ",
    title: "Počet kusů",
    description:
      "Počet kusů a rozložení výroby se projeví v celkové kalkulaci.",
  },
  {
    number: "07",
    tag: "ROZVRŽENÍ",
    title: "Umístění na podložce",
    description: "Slicer určí potřebné uspořádání a spotřebu pro výrobu.",
  },
] as const;
</script>

<template>
  <article class="public-page public-page--pricing">
    <div class="sheet-utility sheet-utility--inset">
      <span>LIST 02 / CENÍK</span><span>ARCHITEKTURA VÝPOČTU CENY</span>
    </div>
    <header class="public-page__intro">
      <div>
        <p class="public-page__index">PRAVIDLA CENY</p>
        <h1>Cena vzniká ze slicingu.</h1>
      </div>
      <p>
        Žádná univerzální sazba za gram. Konečná výrobní cena vychází z
        konkrétního modelu a konfigurace; závazný celkový součet zahrne i
        aktuální doručení.
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
    <section class="public-section" aria-labelledby="rules-title">
      <div class="sheet-section-heading">
        <div>
          <span>SEKCE 01</span>
          <h2 id="rules-title">PRAVIDLA A VSTUPY</h2>
        </div>
        <p>BEZ NESCHVÁLENÝCH SAZEB</p>
      </div>
      <div class="pricing-rule-layout">
        <ol class="pricing-rule-list">
          <li v-for="rule in rules" :key="rule.number">
            <span>{{ rule.number }}</span>
            <div>
              <h3>{{ rule.title }}</h3>
              <p>{{ rule.description }}</p>
            </div>
            <strong>{{ rule.value }}</strong>
          </li>
        </ol>
        <div class="pricing-algorithm">
          <p class="public-page__index">STRUKTURA VÝPOČTU</p>
          <h3>Skutečný řez, skutečná cena</h3>
          <dl>
            <div>
              <dt>Příprava a práce</dt>
              <dd>Podle aktuálního ceníku</dd>
            </div>
            <div>
              <dt>Spotřeba materiálu</dt>
              <dd>Referenční slicing</dd>
            </div>
            <div>
              <dt>Čas stroje</dt>
              <dd>Referenční slicing</dd>
            </div>
            <div>
              <dt>Doručení</dt>
              <dd>Po volbě místa</dd>
            </div>
          </dl>
          <p class="pricing-algorithm__formula">
            CELKOVÁ CENA = VÝROBA + AKTUÁLNÍ DORUČENÍ
          </p>
          <p>
            Veřejné pevné sazby nebo cenu „od“ zveřejníme až po schválení jejich
            zdroje.
          </p>
        </div>
      </div>
    </section>
    <section class="public-section" aria-labelledby="factors-title">
      <div class="sheet-section-heading">
        <div>
          <span>SEKCE 02</span>
          <h2 id="factors-title">CO S CENOU HÝBE?</h2>
        </div>
        <p>SEDM FAKTORŮ KONKRÉTNÍHO TISKU</p>
      </div>
      <p class="pricing-intro">
        Cena není odhadovaná z vnějších rozměrů krabice. Výpočet vychází z
        reálného řezu a aktuálních vstupů.
      </p>
      <ol class="pricing-factors">
        <li v-for="factor in factors" :key="factor.number">
          <div>
            <strong>{{ factor.number }}</strong
            ><span>{{ factor.tag }}</span>
          </div>
          <h3>{{ factor.title }}</h3>
          <p>{{ factor.description }}</p>
        </li>
      </ol>
    </section>
    <section class="public-section" aria-labelledby="pricing-register-title">
      <div class="sheet-section-heading">
        <div>
          <span>ARCHIV</span>
          <h2 id="pricing-register-title">SKUTEČNÉ ZAKÁZKY</h2>
        </div>
        <p>JEN OVĚŘENÉ A SCHVÁLENÉ PODKLADY</p>
      </div>
      <div class="portfolio-state">
        <p class="public-page__index">REGISTR ČEKÁ NA OBSAH</p>
        <h3>Veřejné příklady zatím nejsou schválené.</h3>
        <p>
          Ukázkové ceny ani zakázky z návrhu nevydáváme za skutečné realizace.
          Jakmile budou podklady ověřené, zobrazíme je zde a v registru ukázek.
        </p>
        <NuxtLink class="public-link" to="/ukazky"
          >Stav registru ukázek ↗</NuxtLink
        >
      </div>
    </section>
    <section class="process-cta" aria-labelledby="pricing-cta-title">
      <div>
        <p class="public-page__index">REFERENČNÍ VÝPOČET</p>
        <h2 id="pricing-cta-title">Zjisti cenu svého modelu.</h2>
        <p>
          Přesnou výrobní cenu určí konkrétní řez. Celkový součet uvidíš před
          platbou.
        </p>
      </div>
      <div>
        <NuxtLink
          v-if="automaticQuoteEnabled"
          class="public-action"
          to="/objednavka"
          no-prefetch
          >Nahrát model</NuxtLink
        ><span v-else class="public-action" aria-disabled="true"
          >Kalkulace čeká na schválení</span
        >
      </div>
    </section>
  </article>
</template>
