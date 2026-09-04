<script setup lang="ts">
import { legalDrafts } from "../content/legal-drafts";
import { legalDocuments } from "../content/public-site";

definePageMeta({ layout: "public" });

const document = legalDocuments.prohibitedContent;
const draft = legalDrafts.prohibitedContent;
const contacts = usePublicContacts();

usePublicPageMeta({
  path: document.path,
  title: document.title,
  description: document.summary,
  noindex: true,
});
</script>

<template>
  <PublicLegalPlaceholderPage
    :document="document"
    :draft="draft"
    :contact="{
      label: 'Kontakt pro oznámení problematického obsahu',
      email: contacts.dataController.email,
      href: contacts.dataController.href,
    }"
  />
</template>
