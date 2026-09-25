<script setup lang="ts">
import { publicSite } from "../../content/public-site";

const props = withDefaults(
  defineProps<{
    compact?: boolean;
    inverse?: boolean;
  }>(),
  {
    compact: false,
    inverse: false,
  },
);

const mark = computed(() =>
  props.compact ? publicSite.brand.compactMark : publicSite.brand.wordmark,
);
const letters = computed(() => mark.value.slice(0, -1));
const punctuation = computed(() => mark.value.slice(-1));
</script>

<template>
  <span class="brand-mark" :data-inverse="inverse">
    <span>{{ letters }}</span>
    <span class="brand-mark__period">{{ punctuation }}</span>
  </span>
</template>
