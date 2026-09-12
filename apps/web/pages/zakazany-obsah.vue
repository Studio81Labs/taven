<script setup lang="ts">
import { legalDocuments } from "../content/public-site";
import { isServerVerifiedLegalDocument } from "../utils/legal-availability";
import { useLegalAvailability } from "../composables/useLegalAvailability";

definePageMeta({ layout: "public" });

const document = legalDocuments.prohibitedContent;
const contacts = usePublicContacts();
const { availability, refresh } = useLegalAvailability();
if (import.meta.server) await refresh();
else onMounted(() => void refresh());
const effective = computed(() =>
  isServerVerifiedLegalDocument(
    "prohibitedContent",
    document,
    availability.value,
  ),
);

usePublicPageMeta({
  path: document.path,
  title: document.title,
  description: document.summary,
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
