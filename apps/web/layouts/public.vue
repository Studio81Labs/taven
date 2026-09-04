<script setup lang="ts">
defineOptions({ name: "PublicLayout" });
</script>

<template>
  <div class="min-h-screen bg-[#efefea] text-[#1a1a16]">
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
