<script setup lang="ts">
import {
  legalDocuments,
  publicFooterNavigation,
  publicSite,
} from "../../content/public-site";
</script>

<template>
  <footer class="border-t border-[#d9d9d2] bg-[#1a1a16] text-[#efefea]">
    <div
      class="mx-auto grid max-w-6xl gap-10 px-5 py-10 sm:px-8 md:grid-cols-3"
    >
      <div>
        <NuxtLink
          class="text-xl text-[#efefea] outline-offset-4 focus-visible:outline-2 focus-visible:outline-[#5c7cff]"
          to="/"
          :aria-label="`${publicSite.brand.name}, úvodní stránka`"
        >
          <PublicBrandMark inverse />
        </NuxtLink>
        <p class="mt-4 max-w-xs text-sm leading-6 text-[#c9c9c1]">
          Zakázkový <span class="font-mono">3D</span> tisk s přímou cestou pro
          hotový model a samostatnou cestou pro individuální zadání.
        </p>
      </div>

      <div class="text-sm leading-6">
        <h2 class="font-mono text-xs tracking-wider text-[#a9aaa1] uppercase">
          Provozovatel
        </h2>
        <address class="mt-3 font-mono not-italic">
          <strong class="font-semibold">{{
            publicSite.seller.legalName
          }}</strong
          ><br />
          <template v-for="line in publicSite.seller.address" :key="line">
            {{ line }}<br />
          </template>
          IČ {{ publicSite.seller.companyId }}
        </address>
      </div>

      <nav aria-label="Právní informace" class="text-sm">
        <h2 class="font-mono text-xs tracking-wider text-[#a9aaa1] uppercase">
          Informace
        </h2>
        <ul class="mt-3 space-y-2">
          <li v-for="item in publicFooterNavigation" :key="item.to">
            <NuxtLink
              class="text-[#efefea] underline decoration-[#6e6f66] underline-offset-4 hover:decoration-[#5c7cff] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#5c7cff]"
              :to="item.to"
            >
              {{ item.label }}
            </NuxtLink>
          </li>
          <li v-for="document in legalDocuments" :key="document.id">
            <NuxtLink
              class="text-[#efefea] underline decoration-[#6e6f66] underline-offset-4 hover:decoration-[#5c7cff] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#5c7cff]"
              :to="document.path"
            >
              {{ document.title }}
            </NuxtLink>
          </li>
        </ul>
      </nav>
    </div>
  </footer>
</template>
