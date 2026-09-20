<script setup lang="ts">
import {
  normalizeDeploymentEnvironment,
  type DeploymentEnvironment,
} from "../utils/deployment-environment";

const config = useRuntimeConfig();
const deploymentEnvironment = normalizeDeploymentEnvironment(
  config.public.deploymentEnvironment,
);
const bannerText: Record<DeploymentEnvironment, string> = {
  development: "DEVELOPMENT — testovací prostředí, ne produkce",
  production: "",
  staging: "STAGING — testovací prostředí, ne produkce",
  unknown: "NON-PRODUCTION — deployment identity is missing or invalid",
};
</script>

<template>
  <aside
    v-if="deploymentEnvironment !== 'production'"
    class="bg-[#1b44e8] px-4 py-2 text-center text-sm font-semibold text-white"
    role="status"
  >
    {{ bannerText[deploymentEnvironment] }}
  </aside>
</template>
