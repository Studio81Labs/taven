<script setup lang="ts">
import { legalDocuments } from "../content/public-site";

definePageMeta({ layout: "public" });

const document = legalDocuments.claims;

usePublicPageMeta({
  path: document.path,
  title: document.title,
  description: document.summary,
  noindex: true,
});
</script>

<template>
  <PublicLegalPlaceholderPage :document="document" />
</template>
