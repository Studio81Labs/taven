<script setup lang="ts">
import { router } from "../router";
import { bootstrapSession } from "../session";

async function retry(): Promise<void> {
  await bootstrapSession();
  await router.replace("/");
}
</script>

<template>
  <section>
    <h1>Ověření není dostupné</h1>
    <p>Zkuste obnovit spojení. Žádná změna nebyla potvrzena.</p>
    <button type="button" @click="retry">Zkusit znovu</button>
  </section>
</template>
