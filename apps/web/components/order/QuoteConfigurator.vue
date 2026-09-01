<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import {
  canAddBodyGroup,
  configurationValues,
  formatMoney,
  groupsFromAssignments,
  initialBodyAssignments,
  initialBodyGroups,
  isExpressVisible,
  priceLabel,
  quantityComparison,
  selectConfigurationOption,
  visiblePriceComponents,
  type ConfigurationField,
  type ConfigurationOption,
  type QuoteSession,
} from "../../utils/automatic-quote-configurator";

type ConfigureItem = components["schemas"]["ConfigureAutomaticQuoteItemDto"];
type RiskDecision = components["schemas"]["AutomaticQuoteRiskDecisionDto"];
type DeliveryDestination =
  components["schemas"]["SelectAutomaticQuoteDestinationDto"];

const props = defineProps<{
  commandError?: string;
  pending: boolean;
  quote: QuoteSession;
  onReplaceConfiguration: (
    items: Array<ConfigureItem & { ordinal: number }>,
  ) => Promise<boolean>;
  onDecideRisk: (decision: RiskDecision) => Promise<boolean>;
  onPrepare: () => Promise<boolean>;
  onSelectDestination: (destination: DeliveryDestination) => Promise<boolean>;
  onSetExpress: (requested: boolean) => Promise<boolean>;
}>();

type ItemDraft = {
  fitSensitive: boolean;
  option: ConfigurationOption;
  quantity: number;
};

const assignments = ref<Record<string, number>>({});
const draftByOrdinal = ref<Record<number, ItemDraft>>({});
const groupCount = ref(1);
const acknowledgement = ref<Record<string, boolean>>({});
const selectedDestination = ref("");
const expressRequested = ref(false);
const localError = ref<string>();
const saving = ref(false);

const modelFile = computed(() => props.quote.modelFiles[0]);
const bodyIds = computed(() => modelFile.value?.discoveredBodyIds ?? []);
const configuredBodyIds = computed(
  () => new Set(props.quote.items.flatMap((item) => item.bodyIds)),
);
const hasUnconfiguredBodies = computed(() =>
  bodyIds.value.some((bodyId) => !configuredBodyIds.value.has(bodyId)),
);
const needsConfiguration = computed(
  () =>
    props.quote.configurationEditable &&
    (props.quote.phase === "CONFIGURATION_REQUIRED" ||
      props.quote.items.length > 0 ||
      hasUnconfiguredBodies.value),
);
const groups = computed(() =>
  groupsFromAssignments(bodyIds.value, assignments.value),
);
const currentPrice = computed(
  () => props.quote.bindingQuote ?? props.quote.roughEstimate,
);
const priceComponents = computed(() =>
  visiblePriceComponents(currentPrice.value?.components ?? []),
);
const warnings = computed(() =>
  props.quote.items.flatMap((item) =>
    item.findings
      .filter((finding) => finding.severity === "WARNING")
      .map((finding) => ({ finding, item })),
  ),
);
const blockingFindings = computed(() =>
  props.quote.items.flatMap((item) =>
    item.findings.filter((finding) => finding.severity === "BLOCKING"),
  ),
);
const allWarningsAcknowledged = computed(
  () =>
    warnings.value.length > 0 &&
    warnings.value.every(
      ({ finding }) =>
        finding.decision === "ACKNOWLEDGED" ||
        acknowledgement.value[finding.id],
    ),
);
const selectedDeliveryOption = computed(() =>
  props.quote.deliveryOptions.find(
    (option) => deliveryIdentity(option) === selectedDestination.value,
  ),
);

watch(
  () =>
    JSON.stringify({
      configurationRevision: props.quote.configurationRevision,
      itemCount: props.quote.items.length,
      modelBodies: props.quote.modelFiles.map((file) => file.discoveredBodyIds),
      optionCount: props.quote.configurationOptions.length,
      sessionId: props.quote.sessionId,
    }),
  () => {
    if (!saving.value) initializeDrafts();
  },
  { immediate: true },
);

function initializeDrafts(): void {
  const sourceGroups = initialBodyGroups(bodyIds.value, props.quote.items);
  assignments.value = initialBodyAssignments(bodyIds.value, sourceGroups);
  groupCount.value = Math.max(1, sourceGroups.length);
  const firstOption = props.quote.configurationOptions[0];
  if (!firstOption) return;
  const nextDrafts: Record<number, ItemDraft> = {};
  for (const group of sourceGroups) {
    const serverItem = props.quote.items.find(
      (item) => item.ordinal === group.ordinal,
    );
    const serverOption = serverItem
      ? props.quote.configurationOptions.find(
          (option) =>
            option.printConfigRevisionId === serverItem.printConfigRevisionId &&
            option.material === serverItem.material &&
            option.color === serverItem.color &&
            option.infillPreset === serverItem.infillPreset,
        )
      : undefined;
    nextDrafts[group.ordinal] = {
      fitSensitive: serverItem?.fitSensitive ?? false,
      option:
        serverOption ??
        (serverItem
          ? {
              color: serverItem.color,
              infillPreset: serverItem.infillPreset as
                "DECORATIVE" | "STANDARD" | "STRONG",
              material: serverItem.material,
              printConfigRevisionId: serverItem.printConfigRevisionId,
              quality: serverItem.quality,
            }
          : firstOption),
      quantity: serverItem?.quantity ?? 1,
    };
  }
  draftByOrdinal.value = nextDrafts;
  expressRequested.value = props.quote.express.requested;
  selectedDestination.value = props.quote.deliveryOptions[0]
    ? deliveryIdentity(props.quote.deliveryOptions[0])
    : "";
}

function addGroup(): void {
  if (canAddBodyGroup(bodyIds.value.length, groupCount.value)) {
    groupCount.value += 1;
  }
}

function assignBody(bodyId: string, event: Event): void {
  assignments.value = {
    ...assignments.value,
    [bodyId]: Number((event.currentTarget as HTMLSelectElement).value),
  };
}

function draftFor(ordinal: number): ItemDraft | undefined {
  const existing = draftByOrdinal.value[ordinal];
  if (existing) return existing;
  const option = props.quote.configurationOptions[0];
  if (!option) return undefined;
  const created = { fitSensitive: false, option, quantity: 1 };
  draftByOrdinal.value = { ...draftByOrdinal.value, [ordinal]: created };
  return created;
}

function optionValues(
  ordinal: number,
  field: ConfigurationField,
): Array<string | null> {
  const draft = draftFor(ordinal);
  return draft
    ? configurationValues(optionsFor(draft), draft.option, field)
    : [];
}

function optionsFor(draft: ItemDraft): ConfigurationOption[] {
  return props.quote.configurationOptions.some(
    (option) =>
      option.printConfigRevisionId === draft.option.printConfigRevisionId &&
      option.material === draft.option.material &&
      option.color === draft.option.color &&
      option.infillPreset === draft.option.infillPreset,
  )
    ? props.quote.configurationOptions
    : [draft.option, ...props.quote.configurationOptions];
}

function changeOption(
  ordinal: number,
  field: ConfigurationField,
  event: Event,
): void {
  const draft = draftFor(ordinal);
  if (!draft) return;
  const raw = (event.currentTarget as HTMLSelectElement).value;
  const value = field === "color" && raw === "__none__" ? null : raw;
  const option = selectConfigurationOption(
    optionsFor(draft),
    draft.option,
    field,
    value,
  );
  if (option) draft.option = option;
}

function setQuantity(ordinal: number, quantity: number): void {
  const draft = draftFor(ordinal);
  if (!draft) return;
  draft.quantity = Math.min(1_000, Math.max(1, Math.round(quantity)));
}

async function saveConfiguration(): Promise<void> {
  localError.value = undefined;
  const modelFileId = modelFile.value?.modelFileId;
  if (!modelFileId) return;
  if (groups.value.length === 0) {
    localError.value = "Vyberte alespoň jedno těleso, které chcete vytisknout.";
    return;
  }
  if (Object.keys(assignments.value).length !== bodyIds.value.length) {
    localError.value = "Každé těleso musí být přiřazené právě k jedné položce.";
    return;
  }
  const commands = groups.value.map((group) => {
    const draft = draftFor(group.ordinal);
    return draft
      ? {
          ordinal: group.ordinal,
          bodyIds: [...group.bodyIds],
          color: draft.option.color ?? undefined,
          fitSensitive: draft.fitSensitive,
          infillPreset: draft.option.infillPreset,
          material: draft.option.material,
          modelFileId,
          printConfigRevisionId: draft.option.printConfigRevisionId,
          quantity: draft.quantity,
        }
      : undefined;
  });
  if (commands.some((command) => !command)) {
    localError.value = "Pro každou položku vyberte dostupnou konfiguraci.";
    return;
  }
  saving.value = true;
  try {
    const configuration = commands.filter((command) => command !== undefined);
    if (!(await props.onReplaceConfiguration(configuration))) return;
    await props.onPrepare();
  } finally {
    saving.value = false;
    initializeDrafts();
  }
}

async function submitRiskDecisions(): Promise<void> {
  if (!allWarningsAcknowledged.value) return;
  saving.value = true;
  try {
    for (const { finding, item } of warnings.value) {
      if (finding.decision === "ACKNOWLEDGED" || !finding.acknowledgementKey)
        continue;
      const saved = await props.onDecideRisk({
        acknowledgementKey: finding.acknowledgementKey,
        decision: "ACKNOWLEDGED",
        findingId: finding.id,
        itemOrdinal: item.ordinal,
      });
      if (!saved) return;
    }
    await props.onPrepare();
  } finally {
    saving.value = false;
  }
}

async function declineRisk(
  itemOrdinal: number,
  finding: components["schemas"]["AutomaticQuoteFindingDto"],
): Promise<void> {
  if (!finding.acknowledgementKey) return;
  await props.onDecideRisk({
    acknowledgementKey: finding.acknowledgementKey,
    decision: "DECLINED",
    findingId: finding.id,
    itemOrdinal,
  });
}

async function submitDestination(): Promise<void> {
  const option = selectedDeliveryOption.value;
  if (!option) return;
  saving.value = true;
  try {
    if (
      !(await props.onSelectDestination({
        endpointType: option.endpointType,
        providerEndpointId: option.providerEndpointId,
      }))
    )
      return;
    if (
      isExpressVisible(props.quote) &&
      expressRequested.value !== props.quote.express.requested &&
      !(await props.onSetExpress(expressRequested.value))
    )
      return;
    await props.onPrepare();
  } finally {
    saving.value = false;
  }
}

function deliveryIdentity(option: {
  endpointType: string;
  providerEndpointId: string;
}): string {
  return `${option.endpointType}:${option.providerEndpointId}`;
}

function qualityLabel(value: string): string {
  return (
    { DRAFT: "Rychlá", FINE: "Jemná", STANDARD: "Standardní" }[value] ?? value
  );
}

function infillLabel(value: string): string {
  return (
    { DECORATIVE: "Dekorativní", STANDARD: "Standardní", STRONG: "Pevná" }[
      value
    ] ?? value
  );
}

function colorLabel(value: string | null): string {
  return value ?? "Bez určení barvy";
}

function quantityPrice(choice: {
  currency?: string;
  orderTotalMinor?: number;
}): string {
  return choice.currency && choice.orderTotalMinor != null
    ? `${formatMoney(choice.orderTotalMinor, choice.currency)} celkem`
    : "po uložení";
}
</script>

<template>
  <section class="configurator" aria-labelledby="configurator-title">
    <header class="configurator-heading">
      <div>
        <p class="eyebrow">02 / KONFIGURACE</p>
        <h2 id="configurator-title">Nastavte výrobu.</h2>
      </div>
      <p class="quote-version mono">
        Revize {{ quote.configurationRevision }} · platí do
        {{ new Date(quote.expiresAt).toLocaleString("cs-CZ") }}
      </p>
    </header>

    <div
      v-if="quote.configurationOptions.length === 0"
      class="notice error-state"
    >
      <strong>Pro tento model teď není dostupná výrobní kombinace.</strong>
      <p>Zakázku převezmeme individuálně, bez neověřeného odhadu ceny.</p>
    </div>

    <template v-else-if="needsConfiguration">
      <section class="configurator-section" aria-labelledby="grouping-title">
        <div class="configurator-section-heading">
          <div>
            <p class="eyebrow">TĚLESA A POLOŽKY</p>
            <h3 id="grouping-title">Co se má tisknout společně?</h3>
          </div>
          <button
            v-if="canAddBodyGroup(bodyIds.length, groupCount)"
            class="secondary-button compact-button"
            type="button"
            @click="addGroup"
          >
            Přidat položku
          </button>
        </div>
        <p>
          Tělesa v jedné položce mají stejný materiál, barvu a množství.
          Rozdělte je jen tehdy, když potřebují jiné nastavení; tělesa, která
          tisknout nechcete, výslovně vyřaďte.
        </p>
        <ul class="body-list">
          <li v-for="bodyId in bodyIds" :key="bodyId">
            <span class="mono">{{ bodyId }}</span>
            <label>
              <span class="visually-hidden">Položka pro {{ bodyId }}</span>
              <select
                :value="assignments[bodyId]"
                @change="assignBody(bodyId, $event)"
              >
                <option :value="-1">Netisknout</option>
                <option
                  v-for="index in groupCount"
                  :key="index"
                  :value="index - 1"
                >
                  Položka {{ index }}
                </option>
              </select>
            </label>
          </li>
        </ul>
      </section>

      <section
        v-for="group in groups"
        :key="group.ordinal"
        class="configurator-section item-configuration"
        :aria-labelledby="`item-${group.ordinal}-title`"
      >
        <div class="configurator-section-heading">
          <div>
            <p class="eyebrow">POLOŽKA {{ group.ordinal + 1 }}</p>
            <h3 :id="`item-${group.ordinal}-title`">
              {{ group.bodyIds.length }}
              {{ group.bodyIds.length === 1 ? "těleso" : "tělesa" }}
            </h3>
          </div>
          <span class="mono">{{ group.bodyIds.join(", ") }}</span>
        </div>

        <div v-if="draftFor(group.ordinal)" class="option-grid">
          <label>
            <span>Materiál</span>
            <select
              :value="draftFor(group.ordinal)!.option.material"
              @change="changeOption(group.ordinal, 'material', $event)"
            >
              <option
                v-for="value in optionValues(group.ordinal, 'material')"
                :key="value ?? '__none__'"
                :value="value ?? '__none__'"
              >
                {{ value }}
              </option>
            </select>
          </label>
          <label>
            <span>Barva</span>
            <select
              :value="draftFor(group.ordinal)!.option.color ?? '__none__'"
              @change="changeOption(group.ordinal, 'color', $event)"
            >
              <option
                v-for="value in optionValues(group.ordinal, 'color')"
                :key="value ?? '__none__'"
                :value="value ?? '__none__'"
              >
                {{ colorLabel(value) }}
              </option>
            </select>
          </label>
          <label>
            <span>Kvalita</span>
            <select
              :value="draftFor(group.ordinal)!.option.quality"
              @change="changeOption(group.ordinal, 'quality', $event)"
            >
              <option
                v-for="value in optionValues(group.ordinal, 'quality')"
                :key="value ?? '__none__'"
                :value="value ?? '__none__'"
              >
                {{ qualityLabel(value ?? "") }}
              </option>
            </select>
          </label>
          <label>
            <span>Výplň</span>
            <select
              :value="draftFor(group.ordinal)!.option.infillPreset"
              @change="changeOption(group.ordinal, 'infillPreset', $event)"
            >
              <option
                v-for="value in optionValues(group.ordinal, 'infillPreset')"
                :key="value ?? '__none__'"
                :value="value ?? '__none__'"
              >
                {{ infillLabel(value ?? "") }}
              </option>
            </select>
          </label>
        </div>

        <fieldset v-if="draftFor(group.ordinal)" class="quantity-fieldset">
          <legend>Množství této položky</legend>
          <div class="quantity-options">
            <button
              v-for="choice in quantityComparison(
                group.ordinal,
                {
                  [group.ordinal]: draftFor(group.ordinal)!.quantity,
                },
                quote.quantityComparisons,
              )"
              :key="choice.value"
              :class="{ selected: choice.active }"
              type="button"
              @click="setQuantity(group.ordinal, choice.value)"
            >
              <span>{{ choice.value }} ks</span>
              <small v-if="choice.orderTotalMinor != null && choice.currency">
                {{ quantityPrice(choice) }}
              </small>
              <small v-else>po uložení</small>
            </button>
            <label>
              <span>Jiné</span>
              <input
                max="1000"
                min="1"
                type="number"
                :value="draftFor(group.ordinal)!.quantity"
                @input="
                  setQuantity(
                    group.ordinal,
                    Number(($event.currentTarget as HTMLInputElement).value),
                  )
                "
              />
            </label>
          </div>
        </fieldset>

        <label v-if="draftFor(group.ordinal)" class="fit-sensitive">
          <input
            v-model="draftFor(group.ordinal)!.fitSensitive"
            type="checkbox"
          />
          <span>
            Díl musí přesně lícovat.<br />u dílů, které do sebe musí zapadnout,
            se běžně ladí rozměr v setinách milimetru podle konkrétní tiskárny —
            počítejte s jedním kolem úprav.
          </span>
        </label>
      </section>

      <div class="configurator-actions">
        <button
          class="primary-button"
          type="button"
          :disabled="pending || saving"
          @click="saveConfiguration"
        >
          Uložit a přepočítat
        </button>
        <p>
          Výpočet může chvíli trvat. Zobrazená cena zůstává orientační do
          ověření dopravy.
        </p>
      </div>
    </template>

    <div
      v-if="
        quote.phase === 'REFERENCE_SLICES_PENDING' ||
        quote.phase === 'ELIGIBILITY_PENDING'
      "
      class="notice working-notice"
      aria-live="polite"
    >
      <span class="activity-mark" aria-hidden="true" />
      <div>
        <strong>Přepočítáváme aktuální revizi.</strong>
        <p>Starší výsledek tuto konfiguraci nepřepíše.</p>
        <button
          v-if="quote.phase === 'REFERENCE_SLICES_PENDING'"
          class="text-button"
          type="button"
          :disabled="pending"
          @click="onPrepare"
        >
          Obnovit výpočet
        </button>
      </div>
    </div>

    <section
      v-if="quote.phase === 'ACTION_REQUIRED'"
      class="configurator-section"
    >
      <p class="eyebrow">KONTROLA MODELU</p>
      <h3>Potvrďte zjištěná rizika.</h3>
      <div v-if="blockingFindings.length" class="notice error-state">
        <strong>Blokující nález nelze potvrzením obejít.</strong>
        <p v-for="finding in blockingFindings" :key="finding.id">
          {{ finding.message }}
        </p>
      </div>
      <div v-for="entry in warnings" :key="entry.finding.id" class="risk-row">
        <label>
          <input
            v-model="acknowledgement[entry.finding.id]"
            :disabled="entry.finding.decision === 'ACKNOWLEDGED'"
            type="checkbox"
          />
          <span>{{ entry.finding.message }}</span>
        </label>
        <button
          class="text-button"
          type="button"
          @click="declineRisk(entry.item.ordinal, entry.finding)"
        >
          Nepřijmout a požádat o individuální nabídku
        </button>
      </div>
      <button
        class="primary-button"
        type="button"
        :disabled="!allWarningsAcknowledged || pending || saving"
        @click="submitRiskDecisions"
      >
        Potvrdit a pokračovat
      </button>
    </section>

    <section
      v-if="quote.phase === 'DESTINATION_REQUIRED'"
      class="configurator-section"
    >
      <p class="eyebrow">03 / DOPRAVA</p>
      <h3>Vyberte ověřené místo doručení.</h3>
      <label class="wide-field">
        <span>Způsob a místo</span>
        <select v-model="selectedDestination">
          <option
            v-for="option in quote.deliveryOptions"
            :key="deliveryIdentity(option)"
            :value="deliveryIdentity(option)"
          >
            {{ option.label }}
          </option>
        </select>
      </label>
      <label v-if="isExpressVisible(quote)" class="fit-sensitive">
        <input v-model="expressRequested" type="checkbox" />
        <span>Expresní výroba pro celou objednávku</span>
      </label>
      <button
        class="primary-button"
        type="button"
        :disabled="!selectedDeliveryOption || pending || saving"
        @click="submitDestination"
      >
        Ověřit dopravu a závaznou cenu
      </button>
    </section>

    <section v-if="quote.phase === 'CHECKOUT_READY'" class="binding-ready">
      <p class="eyebrow">ZÁVAZNÁ CENA</p>
      <h3>Objednávka je připravená k platbě.</h3>
      <p>Platební krok navazuje v další části objednávky.</p>
    </section>

    <section
      v-if="currentPrice"
      class="price-summary"
      aria-labelledby="price-title"
    >
      <header>
        <div>
          <p class="eyebrow">
            {{
              currentPrice.kind === "BINDING"
                ? "ZÁVAZNÁ CENA"
                : "ORIENTAČNÍ CENA OD"
            }}
          </p>
          <h3 id="price-title">Celkem za objednávku</h3>
        </div>
        <strong class="total-price mono">
          {{
            currentPrice.totalMinor == null
              ? "Po výpočtu"
              : formatMoney(currentPrice.totalMinor, currentPrice.currency)
          }}
        </strong>
      </header>
      <details>
        <summary>Rozpis ceny</summary>
        <ul class="price-list">
          <li v-for="component in priceComponents" :key="component.id">
            <span>
              {{ priceLabel(component) }}
              <small v-if="component.itemOrdinal != null">
                · položka {{ component.itemOrdinal + 1 }}
              </small>
            </span>
            <span class="mono">
              {{
                component.kind === "SHIPMENT" && component.amountMinor === 0
                  ? "Zdarma"
                  : formatMoney(component.amountMinor, currentPrice.currency)
              }}
            </span>
          </li>
        </ul>
        <p
          v-if="
            priceComponents.some(
              (component) => component.kind === 'ORDER_SMALL_SURCHARGE',
            )
          "
        >
          Příplatek se počítá jednou z celkové tiskové hmotnosti objednávky pod
          100 g.
        </p>
      </details>
    </section>

    <p v-if="localError || commandError" class="form-error" role="alert">
      {{ localError || commandError }}
    </p>
  </section>
</template>
