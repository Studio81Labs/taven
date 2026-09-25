<script setup lang="ts">
import { publicSite } from "../content/public-site";

definePageMeta({ layout: "public" });

usePublicPageMeta({
  path: "/ukazky",
  title: "Ukázky",
  description:
    "Portfolio vlastních a schválených ukázek zakázkového 3D tisku " +
    publicSite.brand.name +
    ".",
});
</script>

<template>
  <article class="public-page public-page--portfolio">
    <div class="sheet-utility sheet-utility--inset">
      <span>LIST 03 / UKÁZKY</span><span>REGISTR SKUTEČNÝCH DÍLŮ</span>
    </div>
    <header class="public-page__intro">
      <div>
        <p class="public-page__index">ARCHIV / OVĚŘENÉ REALIZACE</p>
        <h1>Registr vyrobených dílů.</h1>
      </div>
      <p>
        Vlastní výtisky a fotografie zveřejníme až po ověření práv a podkladů.
        Návrhové záznamy nenahrazují skutečnou výrobu.
      </p>
    </header>
    <section class="public-section" aria-label="Ukázky výtisků">
      <div class="sheet-section-heading">
        <div>
          <span>REGISTR</span>
          <h2>VEŘEJNÉ ZÁZNAMY</h2>
        </div>
        <p>{{ publicSite.portfolio.items.length }} SCHVÁLENÝCH ZÁZNAMŮ</p>
      </div>
      <PublicPortfolioGallery :items="publicSite.portfolio.items" />
    </section>
  </article>
</template>
