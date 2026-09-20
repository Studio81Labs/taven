<script setup lang="ts">
defineOptions({ name: "PublicLayout" });

const config = useRuntimeConfig();
const stagingDeployment = config.public.deploymentEnvironment === "staging";
</script>

<template>
  <div class="min-h-screen bg-[#efefea] text-[#1a1a16]">
    <aside
      v-if="stagingDeployment"
      class="bg-[#1b44e8] px-4 py-2 text-center text-sm font-semibold text-white"
      role="status"
    >
      STAGING — testovací prostředí, ne produkce
    </aside>
    <a
      class="fixed top-2 left-2 z-50 -translate-y-20 bg-white px-4 py-3 font-semibold focus:translate-y-0 focus:outline-2 focus:outline-[#1b44e8]"
      href="#hlavni-obsah"
    >
      Přeskočit na obsah
    </a>
    <PublicNetworkStatus />
    <PublicHeader />
    <main id="hlavni-obsah">
      <slot />
    </main>
    <PublicFooter />
  </div>
</template>
