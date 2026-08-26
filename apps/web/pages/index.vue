<script setup lang="ts">
import { TavenStatusPanel } from "@taven/ui-web";
import { resolveWebHealthStatus } from "../utils/health-status";

const { $api } = useNuxtApp();
const { data: health, error: healthError } = await useAsyncData(
  "api-health",
  async () => {
    const { data, error } = await $api.GET("/health");
    if (error) throw new Error("API health check failed");
    return data;
  },
);

const healthStatus = computed(() =>
  resolveWebHealthStatus(health.value, Boolean(healthError.value)),
);
</script>

<template>
  <TavenStatusPanel
    eyebrow="Local 3D printing"
    title="Taven"
    :status="healthStatus"
  />
</template>
