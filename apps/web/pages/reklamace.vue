<script setup lang="ts">
import { usePublicLegalDocument } from "../composables/usePublicLegalDocument";

definePageMeta({ layout: "public" });

const contacts = usePublicContacts();
const route = useRoute();
const pinnedRevision = computed(() =>
  typeof route.query.revision === "string" ? route.query.revision : null,
);
const pinnedContentHash = computed(() =>
  typeof route.query.contentHash === "string" ? route.query.contentHash : null,
);
const { document, effective, historical, refresh } = usePublicLegalDocument(
  "claims",
  pinnedRevision,
  pinnedContentHash,
);
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
    :historical="historical"
    :contact="{
      label: 'Kontakt pro reklamace',
      email: contacts.customer.email,
      href: contacts.customer.href,
    }"
  />
</template>
