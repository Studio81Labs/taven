<script setup lang="ts">
import { TavenStatusPanel } from "@taven/ui-web";

const { $api } = useNuxtApp();
const { data: health } = await useAsyncData("api-health", async () => {
  const { data, error } = await $api.GET("/health");
  return error ? undefined : data;
});
</script>

<template>
  <TavenStatusPanel
    eyebrow="Local 3D printing"
    title="Taven"
    :status="health ? `API ${health.status}` : 'Foundation is ready'"
  />
</template>
