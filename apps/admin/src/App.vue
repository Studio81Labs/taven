<script setup lang="ts">
import { onMounted, ref } from "vue";
import { TavenStatusPanel } from "@taven/ui-web";
import { apiClient } from "./api";
import { resolveApiHealthStatus } from "./health-status";

const apiStatus = ref("Checking API health…");

onMounted(async () => {
  apiStatus.value = await resolveApiHealthStatus(() =>
    apiClient.GET("/health"),
  );
});
</script>

<template>
  <TavenStatusPanel
    eyebrow="Internal administration"
    title="Taven Admin"
    :status="apiStatus"
  />
</template>
