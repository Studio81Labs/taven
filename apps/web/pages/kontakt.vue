<script setup lang="ts">
import { publicSite } from "../content/public-site";

definePageMeta({ layout: "public" });

const contacts = usePublicContacts();

usePublicPageMeta({
  path: "/kontakt",
  title: "Kontakt",
  description:
    "Kontakt a identifikace provozovatele služby zakázkového 3D tisku " +
    publicSite.brand.name +
    ".",
});
</script>

<template>
  <article class="public-page">
    <header class="public-page__intro">
      <div>
        <p class="public-page__index">Kontakt / 01</p>
        <h1>Popište nám svůj díl</h1>
      </div>
      <p>
        Pro dotaz k nestandardnímu tisku použijte strukturovanou individuální
        poptávku. Pro ostatní zákaznické dotazy napište na
        <a :href="contacts.customer.href">{{ contacts.customer.email }}</a
        >. Komunikaci vedeme elektronicky; veřejnou telefonní linku nepoužíváme.
      </p>
    </header>
    <NuxtLink class="public-action mt-8" to="/poptavka" no-prefetch>
      Otevřít individuální poptávku
    </NuxtLink>

    <section class="public-section" aria-labelledby="operator-title">
      <p class="public-section__index">Provozovatel / 02</p>
      <h2 id="operator-title">Provozovatel služby</h2>
      <div class="public-operator mt-6">
        <div>
          <address>
            <strong class="font-semibold text-[#1a1a16]">
              {{ publicSite.seller.legalName }} </strong
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
        </div>
        <div>
          <p class="mt-0 max-w-2xl text-sm leading-6 text-[#66675f]">
            Právní a privacy dotazy:
            <a
              class="underline decoration-[#6e6f66] underline-offset-4 hover:decoration-[#1b44e8] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
              :href="contacts.dataController.href"
              >{{ contacts.dataController.email }}</a
            >.
          </p>
          <p class="mt-5 max-w-2xl text-sm leading-6 text-[#66675f]">
            Sídlo společnosti není veřejným výdejním místem ani adresou dílny.
            Osobní odběr není součástí současné služby.
          </p>
        </div>
      </div>
    </section>
  </article>
</template>
