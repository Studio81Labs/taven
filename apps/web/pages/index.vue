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
</script>

<template>
  <div>
    <section class="landing-hero" aria-labelledby="landing-title">
      <div class="landing-hero__inner">
        <div class="landing-hero__text">
          <p class="public-page__index">Zakázkový 3D tisk / 01</p>
          <h1 id="landing-title">
            Nahraj model. Cenu spočítáme ze skutečných tiskových dat.
          </h1>
          <p class="landing-hero__copy">
            Hotový <span class="font-mono">STL</span> nebo
            <span class="font-mono">3MF</span> projde kontrolou geometrie a
            referenčním slicingem. Bez e-mailového kolečka a bez ručně
            odhadované výrobní ceny.
          </p>
          <NuxtLink class="public-link mt-5" to="/jak-to-funguje">
            Jak objednávka funguje <span aria-hidden="true">↗</span>
          </NuxtLink>
        </div>
        <PublicHeroUpload class="landing-hero__upload" />
      </div>
    </section>

    <div class="public-page">
      <section class="public-section !mt-0" aria-labelledby="process-title">
        <div class="public-section__header">
          <div>
            <p class="public-section__index">Proces / 02</p>
            <h2 id="process-title">Od souboru k objednávce ve třech krocích</h2>
          </div>
          <NuxtLink class="public-link" to="/jak-to-funguje">
            Podrobný popis procesu <span aria-hidden="true">↗</span>
          </NuxtLink>
        </div>
        <ol class="public-process">
          <li>
            <span class="public-process__number" aria-hidden="true">01</span>
            <div>
              <h3>Nahraješ model</h3>
              <p>
                Přijímáme <span class="font-mono">STL</span> a podporované
                <span class="font-mono">3MF</span>. Před nahráním uvidíš rozměry
                a základní kontrolu souboru.
              </p>
            </div>
            <p class="public-process__detail">Soubor a geometrie</p>
          </li>
          <li>
            <span class="public-process__number" aria-hidden="true">02</span>
            <div>
              <h3>Zvolíš parametry</h3>
              <p>
                Vybereš materiál, dostupnou barvu, kvalitu, výplň a počet kusů.
              </p>
            </div>
            <p class="public-process__detail">Konfigurace a slicing</p>
          </li>
          <li>
            <span class="public-process__number" aria-hidden="true">03</span>
            <div>
              <h3>Potvrdíš aktuální cenu</h3>
              <p>
                Výrobní cenu určí slicing. Závazný celkový součet vznikne až po
                volbě doručení a nové kontrole dostupnosti.
              </p>
            </div>
            <p class="public-process__detail">Doručení a platba</p>
          </li>
        </ol>
      </section>

      <section class="public-section" aria-labelledby="route-title">
        <div class="public-section__header">
          <div>
            <p class="public-section__index">Dvě cesty / 03</p>
            <h2 id="route-title">Vyber cestu podle zadání</h2>
          </div>
        </div>
        <div class="public-card-grid">
          <article>
            <p class="public-section__index">01 / Hotový soubor</p>
            <h3>Máš tisknutelný soubor</h3>
            <p>
              Konfigurátor je určený pro modely, které můžeme automaticky
              zkontrolovat a ocenit. Pokud kontrola najde problém, nabídne
              bezpečný přechod do individuální poptávky.
            </p>
            <NuxtLink
              v-if="automaticQuoteEnabled"
              class="public-action"
              to="/objednavka"
              no-prefetch
            >
              Nahrát model
            </NuxtLink>
            <span v-else class="public-action" aria-disabled="true">
              Kalkulace čeká na schválení
            </span>
          </article>
          <article>
            <p class="public-section__index">02 / Individuální zadání</p>
            <h3>Máš díl, nápad nebo nestandardní zadání</h3>
            <p>
              Pošli popis, účel, rozměry a případné fotografie. Poptávka vznikne
              jako samostatný záznam a neslibuje automatickou cenu.
            </p>
            <NuxtLink
              class="public-action public-action--secondary"
              to="/poptavka"
              no-prefetch
            >
              Popsat zadání
            </NuxtLink>
          </article>
        </div>
      </section>

      <section class="public-section" aria-labelledby="evidence-title">
        <div class="public-section__header">
          <div>
            <p class="public-section__index">Transparentně / 04</p>
            <h2 id="evidence-title">Zveřejňujeme jen ověřené údaje</h2>
          </div>
        </div>
        <div class="public-card-grid">
          <article>
            <h3>Čísla ukážeme až po jejich schválení</h3>
            <p>
              Veřejná cena „od“ ani standardní dodací lhůta zatím nejsou
              schválené. Hrubý odhad doplníme až ze schválených cenových vstupů.
              Přesnou výrobní cenu určí až aktuální slice.
            </p>
            <NuxtLink class="public-link" to="/cenik"
              >Jak cenu počítáme</NuxtLink
            >
          </article>
          <article>
            <h3>Jen vlastní a schválené výtisky</h3>
            <p>
              Portfolio je zatím prázdné. Fotografie doplníme až po schválení
              konkrétních vlastních podkladů a souhlasu s jejich zveřejněním.
            </p>
            <NuxtLink class="public-link" to="/ukazky">Stav portfolia</NuxtLink>
          </article>
        </div>
      </section>

      <section
        class="public-section public-note"
        aria-labelledby="responsibility-title"
      >
        <p class="public-note__label">Jeden odpovědný provozovatel</p>
        <h2 id="responsibility-title">
          Za zakázku ručí {{ publicSite.brand.name }}
        </h2>
        <p>
          Prodávajícím a odpovědným provozovatelem je
          <span class="font-mono">{{ publicSite.seller.legalName }}</span>
          Závaznou cenu uvidíš před platbou. Každý výtisk zkontrolujeme a před
          odesláním uvidíš fotografii hotového dílu. Výroba, kontrola i předání
          jsou součástí jedné služby; neobjednáváš u anonymního výrobce.
        </p>
      </section>
    </div>
  </div>
</template>
