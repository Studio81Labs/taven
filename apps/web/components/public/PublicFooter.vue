<script setup lang="ts">
import {
  legalDocuments,
  publicFooterNavigation,
  publicSite,
} from "../../content/public-site";

const contacts = usePublicContacts();
</script>

<template>
  <footer class="border-t border-[#d9d9d2] bg-[#efefea] text-[#1a1a16]">
    <div class="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <div
        class="grid border-2 border-[#1a1a16] font-mono text-sm md:grid-cols-6"
      >
        <section class="p-5 md:col-span-3 md:p-6">
          <p class="text-[10px] tracking-[0.1em] text-[#66675f] uppercase">
            Projekt
          </p>
          <NuxtLink
            class="mt-4 inline-block text-xl text-[#1a1a16] outline-offset-4 focus-visible:outline-2 focus-visible:outline-[#1b44e8]"
            to="/"
            :aria-label="`${publicSite.brand.name}, úvodní stránka`"
          >
            <PublicBrandMark />
          </NuxtLink>
          <p class="mt-3 max-w-md font-sans leading-6 text-[#54554c]">
            Zakázkový <span class="font-mono">3D</span> tisk s přímou cestou pro
            hotový model a samostatnou cestou pro individuální zadání.
          </p>
        </section>

        <section
          class="border-t-2 border-[#1a1a16] p-5 md:col-span-2 md:border-t-0 md:border-l-2 md:p-6"
        >
          <h2 class="text-[10px] tracking-[0.1em] text-[#66675f] uppercase">
            Provozovatel
          </h2>
          <address class="mt-3 leading-6 not-italic">
            <strong class="font-semibold">{{
              publicSite.seller.legalName
            }}</strong
            ><br />
            <template v-for="line in publicSite.seller.address" :key="line">
              {{ line }}<br />
            </template>
            IČ {{ publicSite.seller.companyId }}<br />
            DIČ {{ publicSite.seller.vatId }}<br />
            <a
              class="underline decoration-[#6e6f66] underline-offset-4 hover:decoration-[#1b44e8] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
              :href="contacts.customer.href"
              >{{ contacts.customer.email }}</a
            >
          </address>
        </section>

        <section
          class="grid grid-cols-2 border-t-2 border-[#1a1a16] md:col-span-1 md:block md:border-t-0 md:border-l-2"
        >
          <div class="p-4">
            <h2 class="text-[10px] tracking-[0.1em] text-[#66675f] uppercase">
              List
            </h2>
            <p class="mt-2 font-semibold">VEŘEJNÝ WEB</p>
          </div>
          <div class="border-l border-[#1a1a16] p-4 md:border-t md:border-l-0">
            <h2 class="text-[10px] tracking-[0.1em] text-[#66675f] uppercase">
              Revize
            </h2>
            <p class="mt-2 break-words">{{ publicSite.contentRevision }}</p>
          </div>
        </section>

        <nav
          aria-label="Právní informace"
          class="border-t-2 border-[#1a1a16] p-5 md:col-span-6 md:p-6"
        >
          <h2 class="text-[10px] tracking-[0.1em] text-[#66675f] uppercase">
            Informace
          </h2>
          <ul class="mt-3 flex flex-wrap gap-x-6 gap-y-3 font-sans">
            <li v-for="item in publicFooterNavigation" :key="item.to">
              <NuxtLink
                class="underline decoration-[#6e6f66] underline-offset-4 hover:decoration-[#1b44e8] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
                :to="item.to"
              >
                {{ item.label }}
              </NuxtLink>
            </li>
            <li v-for="document in legalDocuments" :key="document.id">
              <NuxtLink
                class="underline decoration-[#6e6f66] underline-offset-4 hover:decoration-[#1b44e8] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
                :to="document.path"
              >
                {{ document.title }}
              </NuxtLink>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  </footer>
</template>
