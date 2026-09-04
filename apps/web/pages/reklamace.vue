<script setup lang="ts">
import { legalDrafts } from "../content/legal-drafts";
import { legalDocuments } from "../content/public-site";

definePageMeta({ layout: "public" });

const document = legalDocuments.claims;
const draft = legalDrafts.claims;
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
      label: 'Kontakt pro reklamace',
      email: contacts.customer.email,
      href: contacts.customer.href,
    }"
  />
</template>
