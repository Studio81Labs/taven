<script setup lang="ts">
import { legalDrafts } from "../content/legal-drafts";
import { legalDocuments } from "../content/public-site";

definePageMeta({ layout: "public" });

const document = legalDocuments.privacy;
const draft = legalDrafts.privacy;
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
      label: 'Kontakt správce osobních údajů',
      email: contacts.dataController.email,
      href: contacts.dataController.href,
    }"
  />
</template>
