<script setup lang="ts">
import {
  legalDocuments,
  publicFooterNavigation,
  publicSite,
} from "../../content/public-site";

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const contacts = usePublicContacts();
</script>

<template>
  <footer class="title-block-footer" :data-compact="compact">
    <div class="site-sheet">
      <div class="title-block-footer__frame">
        <section class="title-block-footer__cell">
          <span class="title-block-footer__label">Projekt / Taven</span>
          <NuxtLink
            class="title-block-footer__brand"
            to="/"
            :aria-label="`${publicSite.brand.name}, úvodní stránka`"
          >
            <PublicBrandMark />
          </NuxtLink>
          <p v-if="!compact" class="title-block-footer__note">
            Zakázkový <span class="font-mono">3D</span> tisk s přímou cestou pro
            hotový model a samostatnou cestou pro individuální zadání.
          </p>
        </section>

        <section class="title-block-footer__cell">
          <span class="title-block-footer__label">Provozovatel / kontakt</span>
          <address>
            <strong>{{ publicSite.seller.legalName }}</strong>
            <template v-if="!compact">
              <br />
              <template v-for="line in publicSite.seller.address" :key="line">
                {{ line }}<br />
              </template>
              IČ {{ publicSite.seller.companyId }} · DIČ
              {{ publicSite.seller.vatId }}<br />
            </template>
            <a :href="contacts.customer.href">{{ contacts.customer.email }}</a>
          </address>
        </section>

        <section v-if="!compact" class="title-block-footer__cell">
          <span class="title-block-footer__label">List</span>
          <p class="title-block-footer__meta">VEŘEJNÝ WEB</p>
        </section>

        <section v-if="!compact" class="title-block-footer__cell">
          <span class="title-block-footer__label">Revize</span>
          <p class="title-block-footer__meta">
            {{ publicSite.contentRevision }}
          </p>
        </section>
      </div>

      <div class="title-block-footer__bar">
        <span v-if="compact" class="title-block-footer__meta">
          APLIKACE / {{ publicSite.contentRevision }}
        </span>
        <span v-else>Studio81 Labs, s.r.o. / Zakázkový 3D tisk</span>
        <nav aria-label="Právní informace">
          <ul class="title-block-footer__links">
            <li v-for="item in publicFooterNavigation" :key="item.to">
              <NuxtLink :to="item.to">{{ item.label }}</NuxtLink>
            </li>
            <li v-for="document in legalDocuments" :key="document.id">
              <NuxtLink :to="document.path">{{ document.title }}</NuxtLink>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  </footer>
</template>
