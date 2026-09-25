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
  <article class="public-page">
    <header class="public-page__intro">
      <div>
        <p class="public-page__index">Proces / 01</p>
        <h1>Jak to funguje</h1>
      </div>
      <p>
        Přímá objednávka je pro hotový model. Individuální poptávka je pro
        zadání, které vyžaduje člověka. Obě cesty mají vlastní účel a vlastní
        výsledek.
      </p>
    </header>

    <ol class="public-process public-process--steps public-section">
      <li>
        <span class="public-process__number" aria-hidden="true">01</span>
        <div>
          <h2 class="text-2xl font-semibold">Soubor a kontrola</h2>
          <p class="mt-3 leading-7 text-[#54554c]">
            Vybereš <span class="font-mono">STL</span> nebo podporované
            <span class="font-mono">3MF</span>. Prohlížeč zobrazí základní
            geometrii a server ověří, zda lze model bezpečně zpracovat.
          </p>
        </div>
      </li>
      <li>
        <span class="public-process__number" aria-hidden="true">02</span>
        <div>
          <h2 class="text-2xl font-semibold">Konfigurace a slicing</h2>
          <p class="mt-3 leading-7 text-[#54554c]">
            Nastavíš materiál, dostupnou barvu, kvalitu, výplň a množství.
            Referenční slicing spočítá spotřebu a výrobní čas pro tuto volbu.
          </p>
        </div>
      </li>
      <li>
        <span class="public-process__number" aria-hidden="true">03</span>
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

    <section class="public-section public-note">
      <h2 class="text-2xl font-semibold">Kdy použít individuální poptávku</h2>
      <p class="mt-3 leading-7 text-[#54554c]">
        Když nemáš model, potřebuješ díl překreslit, řešíš lícované rozměry,
        nestandardní materiál nebo jinou konfiguraci, kterou automatická cesta
        nepodporuje.
      </p>
      <NuxtLink class="public-link mt-5" to="/poptavka" no-prefetch>
        Otevřít individuální poptávku
      </NuxtLink>
    </section>
  </article>
</template>
