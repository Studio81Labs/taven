<script setup lang="ts">
definePageMeta({ layout: false });

usePublicPageMeta({
  path: "/checkout/payment/pending",
  title: "Stav platby",
  description: "Ověřený stav platby objednávky TAVEN.",
  noindex: true,
});
</script>

<template>
  <OrderPaymentReturnPage return-kind="pending" />
</template>
