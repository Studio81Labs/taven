<script setup lang="ts">
import { publicSite } from "../content/public-site";

definePageMeta({ layout: "public" });
const automaticQuoteEnabled = useAutomaticQuoteEnabled();

usePublicPageMeta({
  path: "/",
  description:
    "Nahraj hotový 3D model pro kontrolu a nacenění, nebo pošli samostatnou individuální poptávku přes " +
    publicSite.brand.name +
    ".",
});

const processSteps = [
  {
    index: "01",
    tag: "SOUBOR",
    title: "Nahraješ model",
    description:
      "Vybereš STL nebo podporované 3MF. Ještě před nahráním zkontrolujeme rozměry a základní geometrii.",
    detail: "KONTROLA V PROHLÍŽEČI",
  },
  {
    index: "02",
    tag: "SLICING",
    title: "Zvolíš parametry",
    description:
      "Nastavíš materiál, dostupnou barvu, kvalitu, výplň a počet kusů. Referenční řez spočítá spotřebu a čas.",
    detail: "SKUTEČNÁ TISKOVÁ DATA",
  },
  {
    index: "03",
    tag: "ZÁVAZNÁ CENA",
    title: "Potvrdíš celkový součet",
    description:
      "Po volbě doručení znovu ověříme dostupnost a ukážeme závazný součet před platbou.",
    detail: "DORUČENÍ + PLATBA",
  },
] as const;

const responsibility = [
  {
    index: "01",
    title: "Závazná cena před platbou",
    description:
      "Nejdřív uvidíš aktuální cenu tisku a doručení; teprve pak můžeš objednávku zaplatit.",
  },
  {
    index: "02",
    title: "Kontrola každého kusu",
    description: "Hotový výtisk prochází kontrolou před předáním k doručení.",
  },
  {
    index: "03",
    title: "Jedna služba",
    description:
      "Výrobu, kontrolu i předání řešíme jako součást jedné zakázky.",
  },
  {
    index: "04",
    title: "Odpovědný prodávající",
    description: `Prodávajícím a provozovatelem je ${publicSite.seller.legalName}`,
  },
] as const;
</script>

<template>
  <div>
    <div class="sheet-utility">
      <span>VEŘEJNÝ LIST 01 / ZAKÁZKOVÝ 3D TISK</span>
      <span>STL · 3MF / CENA PODLE SKUTEČNÉHO TISKU</span>
    </div>

    <section class="landing-hero" aria-labelledby="landing-title">
      <div class="landing-hero__inner">
        <div class="landing-hero__main">
          <p class="public-page__index">AUTOMATICKÁ CESTA / HOTOVÝ MODEL</p>
          <h1 id="landing-title">Nahraj model. Cenu určí skutečný tisk.</h1>
          <p class="landing-hero__copy">
            Nahraj STL nebo podporované 3MF. Soubor nejprve zkontrolujeme v
            prohlížeči a cenu spočítáme z referenčního slicingu. Závazný součet
            uvidíš před platbou po volbě doručení.
          </p>
          <PublicHeroUpload class="landing-hero__upload" />
        </div>

        <div class="landing-hero__side">
          <article class="landing-side-card">
            <p class="public-page__index">KÓTA / NESTANDARDNÍ ZADÁNÍ</p>
            <h2>Nemáš hotový 3D model?</h2>
            <p>
              Pošli popis, účel, rozměry a případné fotografie. Zadání posoudí
              člověk; individuální poptávka neslibuje automatickou cenu.
            </p>
            <NuxtLink class="public-link" to="/poptavka" no-prefetch>
              Popsat zadání <span aria-hidden="true">→</span>
            </NuxtLink>
          </article>
          <article class="landing-side-card landing-side-card--facts">
            <p class="public-page__index">SKUTEČNÝ STAV SLUŽBY</p>
            <dl class="technical-facts">
              <div>
                <dt>Podporované soubory</dt>
                <dd>STL · podporované 3MF</dd>
              </div>
              <div>
                <dt>Maximální velikost</dt>
                <dd>100 MiB</dd>
              </div>
              <div>
                <dt>Výrobní cena</dt>
                <dd>Referenční slicing</dd>
              </div>
              <div>
                <dt>Celková cena</dt>
                <dd>Po volbě doručení</dd>
              </div>
            </dl>
            <p class="landing-side-card__footnote">
              Veřejnou cenu „od“ ani dodací lhůtu nezveřejňujeme bez schválení.
            </p>
          </article>
        </div>
      </div>
    </section>

    <div class="public-page public-page--landing">
      <section class="public-section !mt-0" aria-labelledby="process-title">
        <div class="sheet-section-heading">
          <div>
            <span>01</span>
            <h2 id="process-title">JAK TO FUNGUJE</h2>
          </div>
          <NuxtLink to="/jak-to-funguje"
            >Podrobný postup <span aria-hidden="true">↗</span></NuxtLink
          >
        </div>
        <ol class="landing-step-grid">
          <li v-for="step in processSteps" :key="step.index">
            <p class="landing-step-grid__top">
              <span>{{ step.index }} / {{ step.tag }}</span
              ><span>{{ step.detail }}</span>
            </p>
            <h3>{{ step.title }}</h3>
            <p>{{ step.description }}</p>
          </li>
        </ol>
      </section>

      <section class="public-section" aria-labelledby="calculation-title">
        <div class="sheet-section-heading">
          <div>
            <span>ŘEZ A–A</span>
            <h2 id="calculation-title">JAK VZNIKÁ CENA</h2>
          </div>
          <p>SKUTEČNÝ TISK / NIKOLI SAMOTNÁ HMOTNOST</p>
        </div>
        <div class="landing-comparison">
          <article>
            <p class="public-page__index">ORIENTAČNÍ / PŘEDBĚŽNÝ</p>
            <h3>Rychlý odhad</h3>
            <p>
              Rozměry souboru mohou dát první představu. Nezahrnují všechny
              tiskové dráhy, podpěry ani aktuální doručení.
            </p>
            <p class="landing-comparison__result">VÝSLEDEK: NEZÁVAZNÝ ODHAD</p>
          </article>
          <article class="landing-comparison__primary">
            <p class="public-page__index">
              REFERENČNÍ SLICING / AKTUÁLNÍ VSTUPY
            </p>
            <h3>Výrobní cena z řezu</h3>
            <p>
              Slicer spočítá spotřebu materiálu a čas stroje pro zvolenou
              konfiguraci. Závazný celkový součet vzniká po ověření doručení.
            </p>
            <p class="landing-comparison__result">
              VÝSLEDEK: AKTUÁLNÍ CENA PŘED PLATBOU
            </p>
          </article>
        </div>
      </section>

      <section class="public-section" aria-labelledby="pricing-title">
        <div class="sheet-section-heading">
          <div>
            <span>02</span>
            <h2 id="pricing-title">PRAVIDLA VÝPOČTU CENY</h2>
          </div>
          <p>BEZ NESCHVÁLENÝCH VEŘEJNÝCH SAZEB</p>
        </div>
        <dl class="landing-pricing-table">
          <div>
            <dt>Model a parametry</dt>
            <dd>Geometrie, materiál, kvalita, výplň a množství</dd>
            <dd>VSTUPY PRO ŘEZ</dd>
          </div>
          <div>
            <dt>Výrobní náklady</dt>
            <dd>Spotřeba, čas stroje, příprava a práce</dd>
            <dd>AKTUÁLNÍ CENÍK</dd>
          </div>
          <div>
            <dt>Doručení</dt>
            <dd>Podporované místo a aktuální dostupnost</dd>
            <dd>PŘED PLATBOU</dd>
          </div>
        </dl>
        <NuxtLink class="public-link" to="/cenik"
          >Jak cenu počítáme <span aria-hidden="true">↗</span></NuxtLink
        >
      </section>

      <section class="public-section" aria-labelledby="portfolio-title">
        <div class="sheet-section-heading">
          <div>
            <span>03</span>
            <h2 id="portfolio-title">REGISTR REALIZOVANÝCH DÍLŮ</h2>
          </div>
          <NuxtLink to="/ukazky"
            >Stav portfolia <span aria-hidden="true">↗</span></NuxtLink
          >
        </div>
        <div class="portfolio-state">
          <p class="public-page__index">ČEKÁ NA SCHVÁLENÉ PODKLADY</p>
          <h3>Veřejné ukázky zatím nejsou dostupné</h3>
          <p>
            Zveřejníme jen vlastní fotografie výtisků, ke kterým máme ověřené
            oprávnění. Fiktivní záznamy ani ilustrační fotografie nenahrazují
            skutečné portfolio.
          </p>
        </div>
      </section>

      <section class="public-section" aria-labelledby="responsibility-title">
        <div class="sheet-section-heading">
          <div>
            <span>04</span>
            <h2 id="responsibility-title">ZA ZAKÁZKU RUČÍ TAVEN</h2>
          </div>
          <p>{{ publicSite.seller.legalName }}</p>
        </div>
        <ol class="landing-responsibility">
          <li v-for="item in responsibility" :key="item.index">
            <span>{{ item.index }}</span>
            <h3>{{ item.title }}</h3>
            <p>{{ item.description }}</p>
          </li>
        </ol>
      </section>

      <section class="landing-final-cta" aria-labelledby="final-cta-title">
        <p class="public-page__index">/ 3D TISK NA ZAKÁZKU</p>
        <h2 id="final-cta-title">Nahraj model a pokračuj k ceně.</h2>
        <p>
          Soubor nejdřív bezpečně zkontrolujeme; platbu potvrdíš až po závazném
          součtu.
        </p>
        <div>
          <NuxtLink
            v-if="automaticQuoteEnabled"
            class="public-action"
            to="/objednavka"
            no-prefetch
            >Nahrát model</NuxtLink
          >
          <span v-else class="public-action" aria-disabled="true"
            >Kalkulace čeká na schválení</span
          >
          <NuxtLink
            class="public-action public-action--secondary"
            to="/poptavka"
            no-prefetch
            >Nemám model</NuxtLink
          >
        </div>
      </section>
    </div>
  </div>
</template>
