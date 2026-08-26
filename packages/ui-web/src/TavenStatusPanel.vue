<script setup lang="ts">
defineProps<{
  eyebrow: string;
  title: string;
  status: string;
}>();
</script>

<template>
  <section class="status-panel">
    <p class="eyebrow">{{ eyebrow }}</p>
    <h1>{{ title }}</h1>
    <p class="status">{{ status }}</p>
  </section>
</template>

<style scoped>
.status-panel {
  width: min(42rem, calc(100% - 2rem));
  margin: 10vh auto;
  padding: clamp(2rem, 6vw, 4rem);
  border: 1px solid color-mix(in srgb, var(--taven-color-ink) 14%, transparent);
  border-radius: var(--taven-radius-panel);
  background: var(--taven-color-surface);
  box-shadow: 0 1.5rem 4rem rgb(60 42 28 / 10%);
}

.eyebrow {
  margin: 0 0 0.75rem;
  color: var(--taven-color-accent);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: clamp(2rem, 7vw, 4rem);
  line-height: 1;
}

.status {
  margin: 1.5rem 0 0;
  color: var(--taven-color-success);
}
</style>
