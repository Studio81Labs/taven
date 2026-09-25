<script setup lang="ts">
import { computed, ref } from "vue";
import {
  portfolioCategories,
  visiblePortfolioItems,
  type PortfolioItem,
} from "../../utils/portfolio-display";

const props = defineProps<{
  items: readonly PortfolioItem[];
  error?: string | null;
}>();

const selectedCategory = ref<string | null>(null);
const selectedItemId = ref<string | null>(null);
const failedImageKeys = ref<Set<string>>(new Set());
const categories = computed(() => portfolioCategories(props.items));
const visibleItems = computed(() =>
  visiblePortfolioItems(props.items, selectedCategory.value),
);
const selectedItem = computed(
  () => props.items.find((item) => item.id === selectedItemId.value) ?? null,
);

function selectCategory(category: string | null): void {
  selectedCategory.value = category;
  selectedItemId.value = null;
}

function imageKey(item: PortfolioItem): string {
  return `${item.id}:${item.image.src}`;
}

function imageUnavailable(item: PortfolioItem): boolean {
  return !item.image.src.trim() || failedImageKeys.value.has(imageKey(item));
}

function markImageUnavailable(item: PortfolioItem): void {
  failedImageKeys.value = new Set([...failedImageKeys.value, imageKey(item)]);
}
</script>

<template>
  <div v-if="error" class="portfolio-state portfolio-state--error" role="alert">
    <p class="public-page__index">Ukázky nejsou dostupné</p>
    <h2>Portfolio se nepodařilo načíst</h2>
    <p>{{ error }}</p>
  </div>
  <div v-else-if="items.length === 0" class="portfolio-state">
    <p class="public-page__index">Čeká na schválené podklady</p>
    <h2>Portfolio je zatím prázdné</h2>
    <p>
      Obsah doplníme po výběru vlastních referenčních výtisků a ověření souhlasů
      s publikací. Rozvržení stránky se kvůli tomu měnit nemusí.
    </p>
  </div>
  <div v-else>
    <div class="portfolio-filters" role="group" aria-label="Filtrovat ukázky">
      <button
        type="button"
        :aria-pressed="selectedCategory === null"
        @click="selectCategory(null)"
      >
        Všechny <span>{{ items.length }}</span>
      </button>
      <button
        v-for="category in categories"
        :key="category"
        type="button"
        :aria-pressed="selectedCategory === category"
        @click="selectCategory(category)"
      >
        {{ category }}
        <span>{{
          items.filter((item) => item.category === category).length
        }}</span>
      </button>
    </div>

    <div class="portfolio-grid">
      <article
        v-for="item in visibleItems"
        :key="item.id"
        class="portfolio-card"
      >
        <div
          v-if="imageUnavailable(item)"
          class="portfolio-image-fallback"
          role="img"
          :aria-label="`Fotografie ukázky ${item.title} není dostupná`"
        >
          Fotografie není dostupná
        </div>
        <img
          v-else
          :src="item.image.src"
          :alt="item.image.alt"
          :width="item.image.width"
          :height="item.image.height"
          loading="lazy"
          @error="markImageUnavailable(item)"
        />
        <div class="portfolio-card__body">
          <p class="public-page__index">
            {{ item.category }} / {{ item.material }}
          </p>
          <h2>{{ item.title }}</h2>
          <p>{{ item.description }}</p>
          <button
            type="button"
            class="public-link"
            :aria-expanded="selectedItemId === item.id"
            @click="
              selectedItemId = selectedItemId === item.id ? null : item.id
            "
          >
            {{
              selectedItemId === item.id ? "Skrýt detail" : "Zobrazit detail"
            }}
          </button>
        </div>
      </article>
    </div>

    <section
      v-if="selectedItem"
      class="portfolio-detail"
      aria-label="Detail ukázky"
    >
      <div
        v-if="imageUnavailable(selectedItem)"
        class="portfolio-image-fallback"
        role="img"
        :aria-label="`Fotografie ukázky ${selectedItem.title} není dostupná`"
      >
        Fotografie není dostupná
      </div>
      <img
        v-else
        :src="selectedItem.image.src"
        :alt="selectedItem.image.alt"
        :width="selectedItem.image.width"
        :height="selectedItem.image.height"
        @error="markImageUnavailable(selectedItem)"
      />
      <div>
        <p class="public-page__index">
          {{ selectedItem.category }} / {{ selectedItem.material }}
        </p>
        <h2>{{ selectedItem.title }}</h2>
        <p>{{ selectedItem.description }}</p>
        <button
          class="public-link"
          type="button"
          @click="selectedItemId = null"
        >
          Zavřít detail
        </button>
      </div>
    </section>
  </div>
</template>
