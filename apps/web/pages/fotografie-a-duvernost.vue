<script setup lang="ts">
import { legalDrafts } from "../content/legal-drafts";
import { legalDocuments } from "../content/public-site";

definePageMeta({ layout: "public" });

const document = legalDocuments.photoConsent;
const draft = legalDrafts.photoConsent;
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
      label: 'Kontakt pro souhlas a ochranu soukromí',
      email: contacts.dataController.email,
      href: contacts.dataController.href,
    }"
  />
</template>
