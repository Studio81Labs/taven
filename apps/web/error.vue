<script setup lang="ts">
defineOptions({ name: "ApplicationError" });

const props = defineProps<{
  error: {
    statusCode?: number;
  };
}>();

const statusCode = computed(() => props.error.statusCode ?? 500);
const isNotFound = computed(() => statusCode.value === 404);

useSeoMeta({
  title: "Stránku se nepodařilo otevřít · Taven",
  robots: "noindex, nofollow",
});
</script>

<template>
  <div class="min-h-screen bg-[#efefea] text-[#1a1a16]">
    <PublicHeader />
    <main class="mx-auto max-w-3xl px-5 py-20 sm:px-8 sm:py-28">
      <p class="font-mono text-sm text-[#1b44e8]">{{ statusCode }}</p>
      <h1 class="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
        {{ isNotFound ? "Tato stránka neexistuje." : "Něco se nepodařilo." }}
      </h1>
      <p class="mt-5 max-w-xl text-lg leading-8 text-[#54554c]">
        {{
          isNotFound
            ? "Zkontrolujte adresu nebo se vraťte na úvodní stránku."
            : "Zkuste stránku načíst znovu. Pokud jste offline, připojte se před nahráním souboru nebo odesláním formuláře."
        }}
      </p>
      <button
        class="mt-8 min-h-12 bg-[#1b44e8] px-6 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a16]"
        type="button"
        @click="clearError({ redirect: '/' })"
      >
        Zpět na úvod
      </button>
    </main>
    <PublicFooter />
  </div>
</template>
