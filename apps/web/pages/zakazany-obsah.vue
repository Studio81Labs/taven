<script setup lang="ts">
import { usePublicLegalDocument } from "../composables/usePublicLegalDocument";

definePageMeta({ layout: "public" });

const contacts = usePublicContacts();
const { document, effective, refresh } =
  usePublicLegalDocument("prohibitedContent");
if (import.meta.server) await refresh();
else onMounted(() => void refresh());

usePublicPageMeta({
  path: "/zakazany-obsah",
  title: document.value.title,
  description: document.value.summary,
  noindex: computed(() => !effective.value),
});
</script>

<template>
  <PublicLegalPlaceholderPage
    :document="document"
    :effective="effective"
    :contact="{
      label: 'Kontakt pro oznámení problematického obsahu',
      email: contacts.dataController.email,
      href: contacts.dataController.href,
    }"
  />
</template>
