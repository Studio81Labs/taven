<script setup lang="ts">
definePageMeta({ layout: "public" });

usePublicPageMeta({
  path: "/jak-to-funguje",
  title: "Jak to funguje",
  description:
    "Postup přímé objednávky 3D tisku a samostatné individuální poptávky.",
});
</script>

<template>
  <article class="mx-auto max-w-4xl px-5 py-14 sm:px-8 sm:py-20">
    <p class="font-mono text-xs tracking-wider text-[#66675f] uppercase">
      Proces
    </p>
    <h1 class="mt-3 text-4xl font-semibold tracking-tight sm:text-[38px]">
      Jak to funguje
    </h1>
    <p class="mt-6 max-w-2xl text-lg leading-8 text-[#54554c]">
      Přímá objednávka je pro hotový model. Individuální poptávka je pro zadání,
      které vyžaduje člověka. Obě cesty mají vlastní účel a vlastní výsledek.
    </p>

    <ol class="mt-12 space-y-px border border-[#d9d9d2] bg-[#d9d9d2]">
      <li class="grid gap-5 bg-white p-6 sm:grid-cols-[4rem_1fr] sm:p-8">
        <span class="font-mono text-lg text-[#1b44e8]">01</span>
        <div>
          <h2 class="text-2xl font-semibold">Soubor a kontrola</h2>
          <p class="mt-3 leading-7 text-[#54554c]">
            Vybereš <span class="font-mono">STL</span> nebo podporované
            <span class="font-mono">3MF</span>. Prohlížeč zobrazí základní
            geometrii a server ověří, zda lze model bezpečně zpracovat.
          </p>
        </div>
      </li>
      <li class="grid gap-5 bg-white p-6 sm:grid-cols-[4rem_1fr] sm:p-8">
        <span class="font-mono text-lg text-[#1b44e8]">02</span>
        <div>
          <h2 class="text-2xl font-semibold">Konfigurace a slicing</h2>
          <p class="mt-3 leading-7 text-[#54554c]">
            Nastavíš materiál, dostupnou barvu, kvalitu, výplň a množství.
            Referenční slicing spočítá spotřebu a výrobní čas pro tuto volbu.
          </p>
        </div>
      </li>
      <li class="grid gap-5 bg-white p-6 sm:grid-cols-[4rem_1fr] sm:p-8">
        <span class="font-mono text-lg text-[#1b44e8]">03</span>
        <div>
          <h2 class="text-2xl font-semibold">Doručení, kontrola a platba</h2>
          <p class="mt-3 leading-7 text-[#54554c]">
            Po volbě doručení systém znovu ověří dostupnost a ukáže závazný
            celkový součet. Objednávka vznikne až po potvrzení aktuálních údajů
            a úspěšné platbě.
          </p>
        </div>
      </li>
    </ol>

    <section class="mt-12 border-l-4 border-[#1b44e8] bg-white p-6 sm:p-8">
      <h2 class="text-2xl font-semibold">Kdy použít individuální poptávku</h2>
      <p class="mt-3 leading-7 text-[#54554c]">
        Když nemáš model, potřebuješ díl překreslit, řešíš lícované rozměry,
        nestandardní materiál nebo jinou konfiguraci, kterou automatická cesta
        nepodporuje.
      </p>
      <NuxtLink
        class="mt-6 inline-block font-semibold text-[#1a1a16] underline decoration-[#1b44e8] decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
        to="/poptavka"
        no-prefetch
      >
        Otevřít individuální poptávku
      </NuxtLink>
    </section>
  </article>
</template>
