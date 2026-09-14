<script setup lang="ts">
import { usePublicLegalDocument } from "../composables/usePublicLegalDocument";

definePageMeta({ layout: "public" });

const contacts = usePublicContacts();
const { document, effective, refresh } = usePublicLegalDocument("privacy");
if (import.meta.server) await refresh();
else onMounted(() => void refresh());

usePublicPageMeta({
  path: "/ochrana-soukromi",
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
      label: 'Kontakt správce osobních údajů',
      email: contacts.dataController.email,
      href: contacts.dataController.href,
    }"
  />
</template>
