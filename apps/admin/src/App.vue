<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { adminTitle } from "./app-config";
import { navigation, router } from "./router";
import {
  hasOperationalNode,
  hasPermission,
  logout,
  session,
  type OperatorPermission,
} from "./session";

const route = useRoute();
const environment = import.meta.env.VITE_APP_ENV ?? import.meta.env.MODE;
const logoutError = ref("");
const visibleNavigation = computed(() =>
  navigation.filter((item) => hasPermission(item.permission)),
);
const showProtected = computed(
  () => session.phase === "authenticated" && hasOperationalNode(),
);

watch(
  () => session.phase,
  (phase) => {
    if (phase === "anonymous" && route.path !== "/prihlaseni") {
      void router.replace("/prihlaseni");
    }
    if (phase === "unavailable" && route.path !== "/nedostupne") {
      void router.replace("/nedostupne");
    }
  },
);

watch(
  () => session.value,
  (value) => {
    if (!value || session.phase !== "authenticated") return;
    if (!hasOperationalNode()) {
      void router.replace("/bez-uzlu");
      return;
    }
    const permission = route.meta.permission;
    if (
      typeof permission === "string" &&
      !hasPermission(permission as OperatorPermission)
    ) {
      void router.replace("/zakazano");
    }
  },
);

async function signOut(): Promise<void> {
  logoutError.value = "";
  try {
    await logout();
    await router.replace("/prihlaseni");
  } catch {
    logoutError.value = "Odhlášení se nezdařilo. Zkuste to znovu.";
  }
}
</script>

<template>
  <div class="admin-app">
    <header class="topbar">
      <div class="brand">Taven <span>Admin</span></div>
      <span class="environment">{{ adminTitle(environment) }}</span>
      <button
        v-if="session.phase === 'authenticated'"
        class="logout"
        type="button"
        @click="signOut"
      >
        Odhlásit se
      </button>
    </header>
    <p v-if="logoutError" class="logout-error" role="alert">
      {{ logoutError }}
    </p>
    <div v-if="session.phase === 'loading'" class="status" role="status">
      Ověřuji přihlášení…
    </div>
    <div v-else class="layout">
      <nav v-if="showProtected" class="sidebar" aria-label="Hlavní navigace">
        <RouterLink
          v-for="item in visibleNavigation"
          :key="item.path"
          :to="item.path"
          :aria-current="route.path === item.path ? 'page' : undefined"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
      <main id="main-content" class="content" tabindex="-1">
        <RouterView
          v-if="
            showProtected ||
            ['/prihlaseni', '/bez-uzlu', '/nedostupne', '/zakazano'].includes(
              route.path,
            )
          "
        />
      </main>
    </div>
  </div>
</template>
