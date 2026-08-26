<script setup lang="ts">
import { onMounted, ref } from "vue";
import { TavenStatusPanel } from "@taven/ui-web";
import { apiClient } from "./api";

const apiStatus = ref("Checking API health…");

onMounted(async () => {
  const { data, error } = await apiClient.GET("/health");
  apiStatus.value = error
    ? "API unavailable"
    : `API ${data?.status ?? "unknown"}`;
});
</script>

<template>
  <TavenStatusPanel
    eyebrow="Internal administration"
    title="Taven Admin"
    :status="apiStatus"
  />
</template>
