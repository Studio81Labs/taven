<script setup lang="ts">
import { publicSite } from "../content/public-site";

definePageMeta({ layout: "public" });

usePublicPageMeta({
  path: "/kontakt",
  title: "Kontakt",
  description:
    "Kontakt a identifikace provozovatele služby zakázkového 3D tisku Taven.",
});
</script>

<template>
  <article class="mx-auto max-w-4xl px-5 py-14 sm:px-8 sm:py-20">
    <p class="font-mono text-xs tracking-wider text-[#66675f] uppercase">
      Kontakt
    </p>
    <h1 class="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
      Popište nám svůj díl
    </h1>
    <p class="mt-6 max-w-2xl text-lg leading-8 text-[#54554c]">
      Pro dotaz k nestandardnímu tisku použijte strukturovanou individuální
      poptávku. Veřejný zákaznický e-mail a telefon zatím čekají na schválení;
      vývojové kontakty zde nezveřejňujeme.
    </p>
    <NuxtLink
      class="mt-8 inline-flex min-h-12 items-center bg-[#1b44e8] px-6 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a16]"
      to="/poptavka"
      no-prefetch
    >
      Otevřít individuální poptávku
    </NuxtLink>

    <section class="mt-14 border-t border-[#d9d9d2] pt-10">
      <h2 class="text-2xl font-semibold">Provozovatel služby</h2>
      <address class="mt-4 leading-7 text-[#54554c] not-italic">
        <strong class="font-semibold text-[#1a1a16]">
          {{ publicSite.seller.legalName }} </strong
        ><br />
        <template v-for="line in publicSite.seller.address" :key="line">
          {{ line }}<br />
        </template>
        IČ {{ publicSite.seller.companyId }}
      </address>
      <p class="mt-5 max-w-2xl text-sm leading-6 text-[#66675f]">
        Sídlo společnosti není veřejným výdejním místem ani adresou dílny.
        Osobní odběr není součástí současné služby.
      </p>
    </section>
  </article>
</template>
