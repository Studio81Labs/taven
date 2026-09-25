<script setup lang="ts">
import {
  LEGAL_PLACEHOLDER_BANNER,
  publicSite,
} from "../../content/public-site";

defineProps<{
  document: {
    id: string;
    title: string;
    summary: string;
    sections: readonly {
      title: string;
      paragraphs?: readonly string[];
      items?: readonly string[];
      note?: string;
    }[];
    effectiveAt: string | null;
  };
  effective?: boolean;
  historical?: boolean;
  contact?: {
    label: string;
    email: string;
    href: string;
  };
}>();
</script>

<template>
  <article class="legal-sheet">
    <p
      v-if="!effective && !historical"
      class="legal-sheet__banner"
      role="alert"
    >
      {{ LEGAL_PLACEHOLDER_BANNER }}
    </p>
    <header class="legal-sheet__header">
      <p class="public-page__index mt-8">{{ document.id }}</p>
      <h1>{{ document.title }}</h1>
      <p>{{ document.summary }}</p>
    </header>

    <dl class="legal-sheet__meta">
      <div>
        <dt>Dokument</dt>
        <dd>{{ document.id }}</dd>
      </div>
      <div>
        <dt>Stav</dt>
        <dd>
          {{ historical ? "Historické" : effective ? "Účinné" : "Návrh" }}
        </dd>
      </div>
      <div>
        <dt>Účinnost</dt>
        <dd>{{ document.effectiveAt ?? "Nestanovena" }}</dd>
      </div>
      <div>
        <dt>Provozovatel</dt>
        <dd>{{ publicSite.seller.legalName }}</dd>
      </div>
    </dl>

    <div class="legal-sheet__layout">
      <nav class="legal-sheet__toc" aria-label="Obsah dokumentu">
        <p class="public-page__index">Na této stránce</p>
        <ol>
          <li
            v-for="(section, index) in document.sections"
            :key="`${index}-${section.title}`"
          >
            <a :href="`#legal-section-${index + 1}`">
              <span aria-hidden="true">{{
                String(index + 1).padStart(2, "0")
              }}</span>
              {{ section.title }}
            </a>
          </li>
        </ol>
      </nav>

      <div class="legal-sheet__content">
        <section class="legal-sheet__notice">
          <h2>
            {{
              historical
                ? "Historické znění"
                : !effective
                  ? "Tato stránka není právní dokument"
                  : "Účinné znění"
            }}
          </h2>
          <p>
            <template v-if="historical">
              Toto je schválené historické znění načtené z neměnné veřejné
              databázové revize. Už nemusí být účinné pro nové objednávky.
            </template>
            <template v-else-if="!effective">
              Neobsahuje účinné znění, datum účinnosti ani souhlas, který by
              bylo možné přijmout. Před veřejným spuštěním ji musí nahradit
              verzovaný text schválený vlastníkem služby a českým právním
              poradcem.
            </template>
            <template v-else>
              Účinné od {{ document.effectiveAt }}. Zobrazená verze je načtena z
              neměnné veřejné databázové revize.
            </template>
          </p>
        </section>

        <section class="legal-sheet__operator">
          <h2>
            {{
              effective || historical
                ? "Identifikace provozovatele"
                : "Identifikace budoucího provozovatele"
            }}
          </h2>
          <p>
            {{ publicSite.seller.legalName }}<br />
            <template v-for="line in publicSite.seller.address" :key="line">
              {{ line }}<br />
            </template>
            IČ {{ publicSite.seller.companyId }}<br />
            DIČ {{ publicSite.seller.vatId }}
          </p>
        </section>

        <section v-if="contact" class="legal-sheet__contact">
          <h2>{{ contact.label }}</h2>
          <a :href="contact.href">{{ contact.email }}</a>
        </section>

        <section class="legal-sheet__text" aria-labelledby="legal-text-heading">
          <div class="legal-sheet__text-header">
            <p class="public-page__index">
              {{
                historical ? "HISTORICKÉ" : effective ? "SCHVÁLENO" : "NÁVRH"
              }}
              · {{ document.id }}
            </p>
            <h2 id="legal-text-heading">
              {{
                historical
                  ? "Historické znění dokumentu"
                  : !effective
                    ? "Pracovní návrh textu"
                    : "Text dokumentu"
              }}
            </h2>
            <p>
              {{
                historical
                  ? "Toto archivní znění zachovává přijatou evidenci, ale nelze je použít pro novou objednávku."
                  : !effective
                    ? "Následující text slouží pouze k vývoji a připomínkování. Nemá datum účinnosti, nelze jej přijmout a nesmí být použit při produkční objednávce."
                    : "Text se vykresluje jako prostý obsah manifestu; nespouští ani nevkládá neověřený HTML obsah."
              }}
            </p>
          </div>

          <section
            v-for="(section, sectionIndex) in document.sections"
            :id="`legal-section-${sectionIndex + 1}`"
            :key="`${sectionIndex}-${section.title}`"
            class="legal-sheet__section"
          >
            <h3>
              <span aria-hidden="true">{{
                String(sectionIndex + 1).padStart(2, "0")
              }}</span>
              {{ section.title }}
            </h3>
            <p
              v-for="(paragraph, index) in section.paragraphs ?? []"
              :key="`${section.title}-paragraph-${index}`"
            >
              {{ paragraph }}
            </p>
            <ul v-if="section.items?.length">
              <li
                v-for="(item, index) in section.items"
                :key="`${section.title}-item-${index}`"
              >
                {{ item }}
              </li>
            </ul>
            <p v-if="section.note" class="legal-sheet__section-note">
              {{ section.note }}
            </p>
          </section>
        </section>
      </div>
    </div>
  </article>
</template>
