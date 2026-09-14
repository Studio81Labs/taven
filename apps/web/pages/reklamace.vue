<script setup lang="ts">
import { usePublicLegalDocument } from "../composables/usePublicLegalDocument";

definePageMeta({ layout: "public" });

const contacts = usePublicContacts();
const { document, effective, refresh } = usePublicLegalDocument("claims");
if (import.meta.server) await refresh();
else onMounted(() => void refresh());

usePublicPageMeta({
  path: "/reklamace",
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
      label: 'Kontakt pro reklamace',
      email: contacts.customer.email,
      href: contacts.customer.href,
    }"
  />
</template>
