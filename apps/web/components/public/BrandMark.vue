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
  <span class="inline-flex font-mono font-semibold tracking-tight">
    <span>{{ letters }}</span>
    <span :class="inverse ? 'text-[#5c7cff]' : 'text-[#1b44e8]'">
      {{ punctuation }}
    </span>
  </span>
</template>
