<script setup lang="ts">
import { publicNavigation, publicSite } from "../../content/public-site";

const route = useRoute();
const automaticQuoteEnabled = useAutomaticQuoteEnabled();
</script>

<template>
  <header class="border-b border-[#d9d9d2] bg-white">
    <div
      class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8"
    >
      <NuxtLink
        class="text-xl text-[#1a1a16] no-underline outline-offset-4 focus-visible:outline-2 focus-visible:outline-[#1b44e8]"
        to="/"
        :aria-label="`${publicSite.brand.name}, úvodní stránka`"
      >
        <PublicBrandMark />
      </NuxtLink>

      <nav class="w-full min-w-0 sm:w-auto" aria-label="Hlavní navigace">
        <ul class="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <li v-for="item in publicNavigation" :key="item.to">
            <NuxtLink
              class="text-[#54554c] underline-offset-4 hover:text-[#1a1a16] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
              :to="item.to"
              :aria-current="route.path === item.to ? 'page' : undefined"
            >
              <span class="font-mono text-xs">{{ item.index }}</span>
              {{ item.label }}
            </NuxtLink>
          </li>
          <li>
            <NuxtLink
              v-if="automaticQuoteEnabled"
              class="inline-flex min-h-11 items-center bg-[#1b44e8] px-4 font-semibold text-white hover:bg-[#1536b8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a16]"
              to="/objednavka"
              no-prefetch
            >
              Nahrát model
            </NuxtLink>
            <span
              v-else
              class="inline-flex min-h-11 cursor-not-allowed items-center border border-[#9b9c93] px-4 font-semibold text-[#66675f]"
              aria-disabled="true"
              title="Automatická kalkulace čeká na schválené cenové vstupy"
            >
              Kalkulace čeká
            </span>
          </li>
        </ul>
      </nav>
    </div>
  </header>
</template>
