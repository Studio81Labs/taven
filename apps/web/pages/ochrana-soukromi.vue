<script setup lang="ts">
import { legalDocuments } from "../content/public-site";
import { isEffectiveApprovedLegalDocument } from "../content/launch-approvals";

definePageMeta({ layout: "public" });

const document = legalDocuments.privacy;
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
      label: 'Kontakt správce osobních údajů',
      email: contacts.dataController.email,
      href: contacts.dataController.href,
    }"
  />
</template>
