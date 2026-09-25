<script setup lang="ts">
definePageMeta({ layout: "public" });

usePublicPageMeta({
  path: "/jak-to-funguje",
  title: "Jak to funguje",
  description:
    "Postup přímé objednávky 3D tisku a samostatné individuální poptávky.",
});

const automaticQuoteEnabled = useAutomaticQuoteEnabled();

const stages = [
  {
    number: "01",
    tag: "SOUBOR",
    title: "Nahraješ model",
    description:
      "Vybereš STL nebo podporované 3MF. Soubor se nejdřív zkontroluje v prohlížeči; samostatná individuální poptávka je pro zadání bez hotového modelu.",
    note: "STL · PODPOROVANÉ 3MF · MAX 100 MiB",
  },
  {
    number: "02",
    tag: "KONTROLA",
    title: "Zkontrolujeme, co jde vyrobit",
    description:
      "Prohlížeč ověří základní geometrii a formát. Server pak posoudí zpracovatelnost; blokující stav vysvětlí ještě před objednávkou.",
    note: "SOUBOR → GEOMETRIE → SLICING → CENA",
  },
  {
    number: "03",
    tag: "KONFIGURACE",
    title: "Nastavíš tisk",
    description:
      "Zvolíš materiál, dostupnou barvu, kvalitu, výplň a počet kusů. Nabídka vychází z aktuálně dostupných možností, ne z předem slíbeného katalogu.",
    note: "MATERIÁL · BARVA · KVALITA · VÝPLŇ · MNOŽSTVÍ",
  },
  {
    number: "04",
    tag: "CENA",
    title: "Uvidíš závazný součet",
    description:
      "Referenční slicing určí spotřebu a čas pro zvolenou konfiguraci. Po volbě doručení znovu ověříme dostupnost a ukážeme aktuální celkovou cenu před platbou.",
    note: "SKUTEČNÝ ŘEZ · DORUČENÍ · PŘED PLATBOU",
  },
  {
    number: "05",
    tag: "VÝROBA",
    title: "Platba, fronta, tisk",
    description:
      "Po potvrzení údajů přejdeš k platbě. Po jejím úspěšném dokončení pokračuje zakázka k výrobě; stav se řídí skutečným průběhem.",
    note: "VÝROBA NÁSLEDUJE PO ÚSPĚŠNÉ PLATBĚ",
  },
  {
    number: "06",
    tag: "KONTROLA",
    title: "Hotový kus zkontrolujeme",
    description:
      "Před předáním k doručení hotový výtisk projde kontrolou. Pokud se výroba nepovede, stav zakázky a další postup řeší operátor.",
    note: "KONTROLA PŘED PŘEDÁNÍM",
  },
  {
    number: "07",
    tag: "DORUČENÍ",
    title: "Předáme k doručení",
    description:
      "Dostupnou možnost doručení a její cenu vybereš v objednávce. Celkový součet je vždy viditelný před platbou.",
    note: "DOSTUPNOST A CENA PODLE MÍSTA DORUČENÍ",
  },
] as const;
</script>

<template>
  <article class="public-page public-page--process">
    <div class="sheet-utility sheet-utility--inset">
      <span>LIST 01 / JAK TO FUNGUJE</span><span>POSTUP ZAKÁZKOVÉHO TISKU</span>
    </div>
    <header class="public-page__intro">
      <div>
        <p class="public-page__index">DOKUMENTACE / POSTUP</p>
        <h1>Od souboru k hotovému dílu.</h1>
      </div>
      <p>
        Automatická cesta začíná hotovým modelem a končí závazným součtem před
        platbou. Zadání, které potřebuje návrh nebo ruční posouzení, patří do
        samostatné individuální poptávky.
      </p>
    </header>
    <div class="process-facts">
      <span>VSTUPNÍ FORMÁTY <strong>STL · PODPOROVANÉ 3MF</strong></span
      ><span>CENA <strong>REFERENČNÍ SLICING</strong></span
      ><span>PLATBA <strong>AŽ PO CELKOVÉM SOUČTU</strong></span>
    </div>
    <section class="public-section" aria-labelledby="stage-title">
      <div class="sheet-section-heading">
        <div>
          <span>01—07</span>
          <h2 id="stage-title">TECHNOLOGICKÝ POSTUP</h2>
        </div>
        <p>SKUTEČNÉ KROKY SLUŽBY</p>
      </div>
      <ol class="process-ledger">
        <li v-for="stage in stages" :key="stage.number">
          <div class="process-ledger__index">
            <span>FÁZE {{ stage.number }}</span
            ><strong>{{ stage.number }}</strong
            ><em>{{ stage.tag }}</em>
          </div>
          <div class="process-ledger__body">
            <h3>{{ stage.title }}</h3>
            <p>{{ stage.description }}</p>
          </div>
          <div class="process-ledger__note">{{ stage.note }}</div>
        </li>
      </ol>
    </section>
    <section class="public-section" aria-labelledby="process-price-title">
      <div class="sheet-section-heading">
        <div>
          <span>ŘEZ A–A</span>
          <h2 id="process-price-title">JAK VZNIKÁ CENA</h2>
        </div>
        <p>ORIENTAČNÍ ODHAD ≠ ZÁVAZNÝ SOUČET</p>
      </div>
      <div class="landing-comparison">
        <article>
          <p class="public-page__index">RYCHLÝ ODHAD</p>
          <h3>Předběžná kalkulace</h3>
          <p>
            Rozměry modelu dávají orientační představu. Nejsou konečnou cenou
            tisku ani doručení.
          </p>
          <p class="landing-comparison__result">VÝSLEDEK: NEZÁVAZNÝ ODHAD</p>
        </article>
        <article class="landing-comparison__primary">
          <p class="public-page__index">REFERENČNÍ SLICING</p>
          <h3>Skutečný výpočet</h3>
          <p>
            Řez určí spotřebu a výrobní čas. Po volbě doručení uvidíš závazný
            celkový součet před platbou.
          </p>
          <p class="landing-comparison__result">
            VÝSLEDEK: AKTUÁLNÍ CENA PŘED PLATBOU
          </p>
        </article>
      </div>
    </section>
    <section class="process-cta" aria-labelledby="process-cta-title">
      <div>
        <p class="public-page__index">PŘIPRAVENÝ MODEL?</p>
        <h2 id="process-cta-title">Připraveni vyrobit tvůj díl?</h2>
        <p>Začni nahráním modelu, nebo popiš nestandardní zadání.</p>
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
        ><NuxtLink
          class="public-action public-action--secondary"
          to="/poptavka"
          no-prefetch
          >Individuální poptávka</NuxtLink
        >
      </div>
    </section>
  </article>
</template>
