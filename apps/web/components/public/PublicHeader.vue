<script setup lang="ts">
import { publicNavigation, publicSite } from "../../content/public-site";

const route = useRoute();
const automaticQuoteEnabled = useAutomaticQuoteEnabled();
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement>();
const navigation = ref<HTMLElement>();

watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false;
  },
);

async function toggleMenu(): Promise<void> {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) {
    await nextTick();
    navigation.value?.querySelector<HTMLAnchorElement>("a")?.focus();
  }
}

async function closeMenu(returnFocus = false): Promise<void> {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  if (returnFocus) {
    await nextTick();
    menuButton.value?.focus();
  }
}
</script>

<template>
  <header class="public-header" @keydown.esc="closeMenu(true)">
    <div class="site-sheet">
      <div class="public-header__top">
        <NuxtLink
          class="public-header__brand"
          to="/"
          :aria-label="`${publicSite.brand.name}, úvodní stránka`"
        >
          <PublicBrandMark />
        </NuxtLink>
        <p class="public-header__meta">ZAKÁZKOVÝ 3D TISK / ČR</p>
        <button
          ref="menuButton"
          class="public-header__menu"
          type="button"
          aria-controls="public-navigation"
          :aria-expanded="menuOpen"
          @click="toggleMenu"
        >
          01–04 MENU
        </button>
      </div>
      <div class="public-header__bottom" :data-open="menuOpen">
        <nav
          id="public-navigation"
          ref="navigation"
          class="public-header__nav"
          aria-label="Hlavní navigace"
        >
          <ul class="public-header__nav-list">
            <li v-for="item in publicNavigation" :key="item.to">
              <NuxtLink
                :to="item.to"
                :aria-current="route.path === item.to ? 'page' : undefined"
                @click="closeMenu()"
              >
                <span class="public-header__nav-index">{{ item.index }}</span>
                {{ item.label }}
              </NuxtLink>
            </li>
          </ul>
          <NuxtLink
            v-if="automaticQuoteEnabled"
            class="public-header__cta"
            to="/objednavka"
            no-prefetch
            @click="closeMenu()"
          >
            Nahrát model
          </NuxtLink>
          <span
            v-else
            class="public-header__unavailable"
            aria-disabled="true"
            title="Automatická kalkulace čeká na schválené cenové vstupy"
          >
            Kalkulace čeká
          </span>
        </nav>
      </div>
    </div>
  </header>
</template>
