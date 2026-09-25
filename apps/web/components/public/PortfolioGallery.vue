<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from "vue";
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
const selectedPublicId = ref<string | null>(null);
const detail = shallowRef<HTMLElement | null>(null);
let activeTrigger: HTMLButtonElement | null = null;
const failedImageKeys = ref<Set<string>>(new Set());
const categories = computed(() => portfolioCategories(props.items));
const visibleItems = computed(() =>
  visiblePortfolioItems(props.items, selectedCategory.value),
);
const selectedItem = computed(
  () =>
    props.items.find((item) => item.publicId === selectedPublicId.value) ??
    null,
);

function selectCategory(category: string | null): void {
  selectedCategory.value = category;
  selectedPublicId.value = null;
  activeTrigger = null;
}

function imageKey(item: PortfolioItem): string {
  return `${item.publicId}:${item.image.src}`;
}

function imageUnavailable(item: PortfolioItem): boolean {
  return !item.image.src.trim() || failedImageKeys.value.has(imageKey(item));
}

function markImageUnavailable(item: PortfolioItem): void {
  failedImageKeys.value = new Set([...failedImageKeys.value, imageKey(item)]);
}

function manufacturingMetadata(
  item: PortfolioItem,
): { label: string; value: string }[] {
  const metadata = item.manufacturing;
  if (!metadata) return [];
  const entries: { label: string; value: string }[] = [];
  if (metadata.color) entries.push({ label: "Barva", value: metadata.color });
  if (metadata.quantity !== undefined)
    entries.push({ label: "Počet", value: String(metadata.quantity) });
  if (metadata.quality)
    entries.push({ label: "Kvalita", value: metadata.quality });
  if (metadata.revision)
    entries.push({ label: "Revize", value: metadata.revision });
  return entries;
}

async function toggleDetail(
  item: PortfolioItem,
  event: MouseEvent,
): Promise<void> {
  if (selectedPublicId.value === item.publicId) {
    selectedPublicId.value = null;
    activeTrigger = null;
    return;
  }
  activeTrigger = event.currentTarget as HTMLButtonElement;
  selectedPublicId.value = item.publicId;
  await nextTick();
  detail.value?.focus();
}

async function closeDetail(): Promise<void> {
  selectedPublicId.value = null;
  await nextTick();
  activeTrigger?.focus();
  activeTrigger = null;
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
        :key="item.publicId"
        class="portfolio-card"
      >
        <div class="portfolio-card__image">
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
          <span class="portfolio-card__public-id">{{ item.publicId }}</span>
        </div>
        <div class="portfolio-card__body">
          <p class="public-page__index">
            {{ item.category }} / {{ item.material }}
          </p>
          <h2>{{ item.title }}</h2>
          <p v-if="item.description">{{ item.description }}</p>
          <dl
            v-if="manufacturingMetadata(item).length"
            class="portfolio-metadata"
          >
            <div
              v-for="entry in manufacturingMetadata(item)"
              :key="entry.label"
            >
              <dt>{{ entry.label }}</dt>
              <dd>{{ entry.value }}</dd>
            </div>
          </dl>
          <button
            type="button"
            class="public-link"
            :aria-expanded="selectedPublicId === item.publicId"
            :aria-controls="
              selectedPublicId === item.publicId
                ? 'portfolio-detail'
                : undefined
            "
            @click="toggleDetail(item, $event)"
          >
            {{
              selectedPublicId === item.publicId
                ? "Skrýt detail"
                : "Zobrazit detail"
            }}
          </button>
        </div>
      </article>
    </div>

    <section
      v-if="selectedItem"
      id="portfolio-detail"
      ref="detail"
      class="portfolio-detail"
      aria-label="Detail ukázky"
      tabindex="-1"
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
          {{ selectedItem.publicId }} / {{ selectedItem.category }} /
          {{ selectedItem.material }}
        </p>
        <h2>{{ selectedItem.title }}</h2>
        <p v-if="selectedItem.description">{{ selectedItem.description }}</p>
        <dl
          v-if="manufacturingMetadata(selectedItem).length"
          class="portfolio-metadata"
        >
          <div
            v-for="entry in manufacturingMetadata(selectedItem)"
            :key="entry.label"
          >
            <dt>{{ entry.label }}</dt>
            <dd>{{ entry.value }}</dd>
          </div>
        </dl>
        <button class="public-link" type="button" @click="closeDetail">
          Zavřít detail
        </button>
      </div>
    </section>
  </div>
</template>
