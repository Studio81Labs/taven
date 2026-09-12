<script setup lang="ts">
import { legalDocuments } from "../content/public-site";
import { isEffectiveApprovedLegalDocument } from "../content/launch-manifest";

definePageMeta({ layout: "public" });

const document = legalDocuments.terms;
const contacts = usePublicContacts();

usePublicPageMeta({
  path: document.path,
  title: document.title,
  description: document.summary,
  noindex: !isEffectiveApprovedLegalDocument(document),
});
</script>

<template>
  <PublicLegalPlaceholderPage
    :document="document"
    :contact="{
      label: 'Zákaznický kontakt',
      email: contacts.customer.email,
      href: contacts.customer.href,
    }"
  />
</template>
