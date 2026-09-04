<script setup lang="ts">
definePageMeta({ layout: "public" });

usePublicPageMeta({
  path: "/ukazky",
  title: "Ukázky",
  description:
    "Portfolio vlastních a schválených ukázek zakázkového 3D tisku Taven.",
});
</script>

<template>
  <article class="mx-auto max-w-4xl px-5 py-14 sm:px-8 sm:py-20">
    <p class="font-mono text-xs tracking-wider text-[#66675f] uppercase">
      Portfolio
    </p>
    <h1 class="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
      Ukázky vlastních výtisků
    </h1>
    <p class="mt-6 max-w-2xl text-lg leading-8 text-[#54554c]">
      Zde budou jen skutečné fotografie výtisků, které můžeme zveřejnit. Obecné
      ilustrační fotografie ani cizí výrobky nepoužíváme.
    </p>
    <div
      class="mt-12 border border-dashed border-[#9b9c93] bg-white p-8 sm:p-12"
    >
      <p class="font-mono text-sm text-[#66675f]">ČEKÁ NA SCHVÁLENÉ PODKLADY</p>
      <h2 class="mt-4 text-2xl font-semibold">Portfolio je zatím prázdné</h2>
      <p class="mt-3 max-w-xl leading-7 text-[#54554c]">
        Obsah doplníme po výběru vlastních referenčních výtisků a ověření
        souhlasů s publikací. Rozvržení stránky se kvůli tomu měnit nemusí.
      </p>
    </div>
  </article>
</template>
