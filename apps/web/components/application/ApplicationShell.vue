<script setup lang="ts">
import { publicSite } from "../../content/public-site";

interface ProcessStep {
  index: string;
  label: string;
}

const props = defineProps<{
  steps: readonly ProcessStep[];
  activeStep: number;
  navigationLabel: string;
  summary?: string;
}>();

const activeStepLabel = computed(() => {
  const step = props.steps[props.activeStep - 1];
  return step
    ? `${step.index} ${step.label} / ${String(props.steps.length).padStart(2, "0")}`
    : "";
});
</script>

<template>
  <div class="application-shell application-page">
    <PublicDeploymentBanner />
    <a class="skip-link" href="#hlavni-obsah">Přeskočit na obsah</a>
    <PublicNetworkStatus />
    <header class="application-shell__header site-sheet">
      <NuxtLink
        class="public-header__brand"
        to="/"
        :aria-label="`${publicSite.brand.name}, úvodní stránka`"
      >
        <PublicBrandMark />
      </NuxtLink>
      <nav :aria-label="navigationLabel">
        <ol class="application-shell__steps">
          <li
            v-for="(step, index) in steps"
            :key="step.index"
            :aria-current="activeStep === index + 1 ? 'step' : undefined"
          >
            {{ step.index }} {{ step.label }}
          </li>
        </ol>
      </nav>
      <p v-if="summary" class="application-shell__summary">{{ summary }}</p>
      <p class="application-shell__mobile-step">{{ activeStepLabel }}</p>
    </header>
    <main
      id="hlavni-obsah"
      class="application-shell__body site-sheet"
      tabindex="-1"
    >
      <slot name="workspace" />
      <slot name="context" />
    </main>
    <PublicFooter compact />
  </div>
</template>
