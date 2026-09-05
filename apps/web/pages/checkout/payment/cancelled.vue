<script setup lang="ts">
definePageMeta({ layout: "public" });

usePublicPageMeta({
  path: "/checkout/payment/cancelled",
  title: "Stav platby",
  description: "Ověřený stav platby objednávky TAVEN.",
  noindex: true,
});
</script>

<template>
  <OrderPaymentReturnPage return-kind="cancelled" />
</template>
