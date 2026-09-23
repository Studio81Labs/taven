<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const title = computed(() => String(route.meta.label ?? "Přehled"));
</script>

<template>
  <section aria-labelledby="section-title">
    <p class="eyebrow">Interní provoz</p>
    <h1 id="section-title">{{ title }}</h1>
    <p>Pracovní plocha se připravuje.</p>
  </section>
</template>
