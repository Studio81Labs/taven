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
  <article class="public-page">
    <header class="public-page__intro">
      <div>
        <p class="public-page__index">Portfolio / 01</p>
        <h1>Ukázky vlastních výtisků</h1>
      </div>
      <p>
        Zde budou jen skutečné fotografie výtisků, které můžeme zveřejnit.
        Obecné ilustrační fotografie ani cizí výrobky nepoužíváme.
      </p>
    </header>
    <section class="public-section" aria-label="Ukázky výtisků">
      <PublicPortfolioGallery :items="publicSite.portfolio.items" />
    </section>
  </article>
</template>
