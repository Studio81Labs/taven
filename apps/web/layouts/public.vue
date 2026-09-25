<script setup lang="ts">
defineOptions({ name: "PublicLayout" });
</script>

<template>
  <div class="site-shell">
    <PublicDeploymentBanner />
    <a class="skip-link" href="#hlavni-obsah"> Přeskočit na obsah </a>
    <PublicNetworkStatus />
    <PublicHeader />
    <main id="hlavni-obsah" class="site-sheet site-main" tabindex="-1">
      <slot />
    </main>
    <PublicFooter />
  </div>
</template>
