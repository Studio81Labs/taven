<script setup lang="ts">
import {
  LEGAL_PLACEHOLDER_BANNER,
  publicSite,
  type LegalDocument,
} from "../../content/public-site";

defineProps<{
  document: LegalDocument;
  contact?: {
    label: string;
    email: string;
    href: string;
  };
}>();
</script>

<template>
  <article class="mx-auto max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
    <p
      class="border-2 border-[#b4441a] bg-white px-4 py-3 font-mono text-sm font-semibold text-[#8c3213]"
      role="alert"
    >
      {{ LEGAL_PLACEHOLDER_BANNER }}
    </p>
    <p class="mt-10 font-mono text-xs tracking-wider text-[#66675f] uppercase">
      {{ document.id }}
    </p>
    <h1 class="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
      {{ document.title }}
    </h1>
    <p class="mt-6 text-lg leading-8 text-[#54554c]">
      {{ document.summary }}
    </p>
    <div class="mt-10 border border-[#d9d9d2] bg-white p-6 leading-7">
      <h2 class="text-xl font-semibold">Tato stránka není právní dokument</h2>
      <p class="mt-3 text-[#54554c]">
        Neobsahuje účinné znění, datum účinnosti ani souhlas, který by bylo
        možné přijmout. Před veřejným spuštěním ji musí nahradit verzovaný text
        schválený vlastníkem služby a českým právním poradcem.
      </p>
    </div>
    <section class="mt-10 border-t border-[#d9d9d2] pt-8">
      <h2 class="text-xl font-semibold">
        Identifikace budoucího provozovatele
      </h2>
      <p class="mt-3 font-mono leading-7 text-[#54554c]">
        {{ publicSite.seller.legalName }}<br />
        <template v-for="line in publicSite.seller.address" :key="line">
          {{ line }}<br />
        </template>
        IČ {{ publicSite.seller.companyId }}<br />
        DIČ {{ publicSite.seller.vatId }}
      </p>
    </section>
    <section v-if="contact" class="mt-10 border-t border-[#d9d9d2] pt-8">
      <h2 class="text-xl font-semibold">{{ contact.label }}</h2>
      <a
        class="mt-3 inline-block font-mono underline decoration-[#6e6f66] underline-offset-4 hover:decoration-[#1b44e8] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1b44e8]"
        :href="contact.href"
        >{{ contact.email }}</a
      >
    </section>
    <section
      class="mt-12 border-t-2 border-[#1a1a16] pt-10"
      aria-labelledby="legal-draft-heading"
    >
      <div class="border border-[#d9d9d2] bg-[#efefea] p-5">
        <p class="font-mono text-xs tracking-wider text-[#66675f] uppercase">
          {{ document.draft.status }} · {{ document.draft.sourceDocumentId }}
        </p>
        <h2 id="legal-draft-heading" class="mt-3 text-2xl font-semibold">
          Pracovní návrh textu
        </h2>
        <p class="mt-3 leading-7 text-[#54554c]">
          Následující text slouží pouze k vývoji a připomínkování. Nemá datum
          účinnosti, nelze jej přijmout a nesmí být použit při produkční
          objednávce.
        </p>
      </div>

      <section
        v-for="section in document.draft.sections"
        :key="section.title"
        class="border-b border-[#d9d9d2] py-8 last:border-b-0"
      >
        <h3 class="text-xl font-semibold">{{ section.title }}</h3>
        <p
          v-for="(paragraph, index) in section.paragraphs ?? []"
          :key="`${section.title}-paragraph-${index}`"
          class="mt-4 leading-7 text-[#3f4039]"
        >
          {{ paragraph }}
        </p>
        <ul
          v-if="section.items?.length"
          class="mt-4 list-disc space-y-2 pl-6 leading-7 text-[#3f4039] marker:text-[#1b44e8]"
        >
          <li
            v-for="(item, index) in section.items"
            :key="`${section.title}-item-${index}`"
          >
            {{ item }}
          </li>
        </ul>
        <p
          v-if="section.note"
          class="mt-4 border-l-2 border-[#1b44e8] pl-4 leading-7 text-[#54554c]"
        >
          {{ section.note }}
        </p>
      </section>
    </section>
  </article>
</template>
