<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { apiClient } from "../api";
import { router } from "../router";
import { login, session, startGithubLogin } from "../session";

const methods = ref<readonly string[]>([]);
const email = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");
const retryUntil = ref(0);
let retryTimer: ReturnType<typeof setTimeout> | null = null;

onUnmounted(() => {
  if (retryTimer) clearTimeout(retryTimer);
});

onMounted(async () => {
  try {
    const { data } = await apiClient.GET("/admin/auth/methods");
    if (!data) throw new Error();
    methods.value = data.methods;
  } catch {
    error.value = "Způsoby přihlášení nejsou dostupné.";
  }
});

async function submitPassword(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await login(email.value, password.value);
    if (!result.ok) {
      error.value = result.feedback.message;
      if (result.feedback.retryAfterSeconds) {
        retryUntil.value =
          Date.now() + result.feedback.retryAfterSeconds * 1000;
        retryTimer = setTimeout(() => {
          retryUntil.value = 0;
        }, result.feedback.retryAfterSeconds * 1000);
      }
      return;
    }
    password.value = "";
    await router.replace("/");
  } catch {
    error.value = "Přihlášení nyní není dostupné.";
  } finally {
    busy.value = false;
  }
}

async function submitGithub(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const url = await startGithubLogin();
    if (!url) throw new Error();
    window.location.assign(url);
  } catch {
    error.value = "Přihlášení přes GitHub nyní není dostupné.";
    busy.value = false;
  }
}
</script>

<template>
  <section class="login-card" aria-labelledby="login-title">
    <p class="eyebrow">Interní přístup</p>
    <h1 id="login-title">Přihlášení operátora</h1>
    <p v-if="session.scopeDenied" role="alert">
      Účet nemá platný provozní přístup. Přihlaste se jiným účtem nebo
      kontaktujte správce.
    </p>
    <p v-if="$route.query.auth === 'failed'" role="alert">
      Přihlášení přes GitHub se nezdařilo.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <form
      v-if="methods.includes('EMAIL_PASSWORD')"
      @submit.prevent="submitPassword"
    >
      <label for="operator-email">E-mail</label>
      <input
        id="operator-email"
        v-model="email"
        type="email"
        autocomplete="username"
        required
      />
      <label for="operator-password">Heslo</label>
      <input
        id="operator-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
      />
      <button type="submit" :disabled="busy || retryUntil > Date.now()">
        Přihlásit se
      </button>
    </form>
    <button
      v-if="methods.includes('GITHUB')"
      type="button"
      :disabled="busy"
      @click="submitGithub"
    >
      Pokračovat přes GitHub
    </button>
  </section>
</template>
