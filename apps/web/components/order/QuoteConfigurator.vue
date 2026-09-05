<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import {
  bodyAssignmentKey,
  canRecoverWithStandardProduction,
  canAddBodyGroup,
  configurationValues,
  formatMoney,
  initialModelBodyAssignments,
  initialModelBodyGroups,
  isExpressVisible,
  modelGroupsFromAssignments,
  priceLabel,
  quantityComparison,
  selectConfigurationOption,
  shouldShowUnavailableConfigurationWarning,
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
  onRefresh: () => Promise<void>;
  onRestart: () => void;
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
const groupOrdinalsByModelFileId = ref<Record<string, number[]>>({});
const nextGroupOrdinal = ref(0);
const acknowledgement = ref<Record<string, boolean>>({});
const selectedDestination = ref("");
const expressRequested = ref(false);
const localError = ref<string>();
const saving = ref(false);
const configurationLocked = computed(() => props.pending || saving.value);

const configuredBodyIds = computed(
  () =>
    new Set(
      props.quote.items.flatMap((item) =>
        item.bodyIds.map((bodyId) =>
          bodyAssignmentKey(item.modelFileId, bodyId),
        ),
      ),
    ),
);
const hasUnconfiguredBodies = computed(() =>
  props.quote.modelFiles.some((modelFile) =>
    modelFile.discoveredBodyIds.some(
      (bodyId) =>
        !configuredBodyIds.value.has(
          bodyAssignmentKey(modelFile.modelFileId, bodyId),
        ),
    ),
  ),
);
const needsConfiguration = computed(
  () =>
    props.quote.configurationEditable &&
    (props.quote.phase === "CONFIGURATION_REQUIRED" ||
      props.quote.items.length > 0 ||
      hasUnconfiguredBodies.value),
);
const groups = computed(() =>
  modelGroupsFromAssignments(props.quote.modelFiles, assignments.value),
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
const selectedDestinationChanged = computed(
  () =>
    Boolean(selectedDeliveryOption.value) &&
    selectedDestination.value !==
      (props.quote.selectedDeliveryDestination
        ? deliveryIdentity(props.quote.selectedDeliveryDestination)
        : ""),
);

watch(
  () =>
    JSON.stringify({
      configurationRevision: props.quote.configurationRevision,
      itemCount: props.quote.items.length,
      modelBodies: props.quote.modelFiles.map((file) => ({
        bodyIds: file.discoveredBodyIds,
        modelFileId: file.modelFileId,
      })),
      optionCount: props.quote.configurationOptions.length,
      sessionId: props.quote.sessionId,
    }),
  () => {
    if (!saving.value) initializeDrafts();
  },
  { immediate: true },
);

function initializeDrafts(): void {
  const sourceGroups = initialModelBodyGroups(
    props.quote.modelFiles,
    props.quote.items,
  );
  assignments.value = initialModelBodyAssignments(
    props.quote.modelFiles,
    sourceGroups,
  );
  groupOrdinalsByModelFileId.value = Object.fromEntries(
    props.quote.modelFiles.map((modelFile) => [
      modelFile.modelFileId,
      sourceGroups
        .filter((group) => group.modelFileId === modelFile.modelFileId)
        .map((group) => group.ordinal),
    ]),
  );
  nextGroupOrdinal.value = Math.max(
    0,
    ...sourceGroups.map((group) => group.ordinal + 1),
  );
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
  selectedDestination.value = props.quote.selectedDeliveryDestination
    ? deliveryIdentity(props.quote.selectedDeliveryDestination)
    : props.quote.deliveryOptions[0]
      ? deliveryIdentity(props.quote.deliveryOptions[0])
      : "";
}

function addGroup(modelFileId: string): void {
  const modelFile = props.quote.modelFiles.find(
    (candidate) => candidate.modelFileId === modelFileId,
  );
  const current = groupOrdinals(modelFileId);
  if (
    !modelFile ||
    !canAddBodyGroup(modelFile.discoveredBodyIds.length, current.length)
  )
    return;
  groupOrdinalsByModelFileId.value = {
    ...groupOrdinalsByModelFileId.value,
    [modelFileId]: [...current, nextGroupOrdinal.value],
  };
  nextGroupOrdinal.value += 1;
}

function assignBody(modelFileId: string, bodyId: string, event: Event): void {
  assignments.value = {
    ...assignments.value,
    [bodyAssignmentKey(modelFileId, bodyId)]: Number(
      (event.currentTarget as HTMLSelectElement).value,
    ),
  };
}

function groupOrdinals(modelFileId: string): number[] {
  return groupOrdinalsByModelFileId.value[modelFileId] ?? [];
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
  if (groups.value.length === 0) {
    localError.value = "Vyberte alespoň jedno těleso, které chcete vytisknout.";
    return;
  }
  const allBodiesAssigned = props.quote.modelFiles.every((modelFile) =>
    modelFile.discoveredBodyIds.every(
      (bodyId) =>
        typeof assignments.value[
          bodyAssignmentKey(modelFile.modelFileId, bodyId)
        ] === "number",
    ),
  );
  if (!allBodiesAssigned) {
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
          modelFileId: group.modelFileId,
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
  let replaced = false;
  try {
    const configuration = commands.filter((command) => command !== undefined);
    replaced = await props.onReplaceConfiguration(configuration);
    if (!replaced) return;
    await props.onPrepare();
  } finally {
    saving.value = false;
    if (replaced) initializeDrafts();
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

async function continueWithoutExpress(): Promise<void> {
  saving.value = true;
  try {
    if (!(await props.onSetExpress(false))) return;
    expressRequested.value = false;
    await props.onPrepare();
  } finally {
    saving.value = false;
  }
}

function modelFileLabel(modelFileId: string): string {
  const index = props.quote.modelFiles.findIndex(
    (modelFile) => modelFile.modelFileId === modelFileId,
  );
  const format = props.quote.modelFiles[index]?.format ?? "MODEL";
  return `Soubor ${index + 1} · ${format === "THREE_MF" ? "3MF" : format}`;
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

function colorLabel(value: string | null | undefined): string {
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
      v-if="shouldShowUnavailableConfigurationWarning(quote)"
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
        </div>
        <p>
          Tělesa v jedné položce mají stejný materiál, barvu a množství.
          Rozdělte je jen tehdy, když potřebují jiné nastavení; tělesa, která
          tisknout nechcete, výslovně vyřaďte.
        </p>
        <article
          v-for="modelFile in quote.modelFiles"
          :key="modelFile.modelFileId"
          class="item-configuration"
        >
          <div class="configurator-section-heading">
            <strong class="eyebrow">
              {{ modelFileLabel(modelFile.modelFileId) }}
            </strong>
            <button
              v-if="
                canAddBodyGroup(
                  modelFile.discoveredBodyIds.length,
                  groupOrdinals(modelFile.modelFileId).length,
                )
              "
              class="secondary-button compact-button"
              type="button"
              :disabled="configurationLocked"
              @click="addGroup(modelFile.modelFileId)"
            >
              Přidat položku
            </button>
          </div>
          <ul class="body-list">
            <li
              v-for="bodyId in modelFile.discoveredBodyIds"
              :key="bodyAssignmentKey(modelFile.modelFileId, bodyId)"
            >
              <span class="mono">{{ bodyId }}</span>
              <label>
                <span class="visually-hidden">
                  Položka pro {{ bodyId }} v
                  {{ modelFileLabel(modelFile.modelFileId) }}
                </span>
                <select
                  :value="
                    assignments[
                      bodyAssignmentKey(modelFile.modelFileId, bodyId)
                    ]
                  "
                  :disabled="configurationLocked"
                  @change="assignBody(modelFile.modelFileId, bodyId, $event)"
                >
                  <option :value="-1">Netisknout</option>
                  <option
                    v-for="ordinal in groupOrdinals(modelFile.modelFileId)"
                    :key="ordinal"
                    :value="ordinal"
                  >
                    Položka {{ ordinal + 1 }}
                  </option>
                </select>
              </label>
            </li>
          </ul>
        </article>
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
            <small>{{ modelFileLabel(group.modelFileId) }}</small>
          </div>
          <span class="mono">{{ group.bodyIds.join(", ") }}</span>
        </div>

        <div v-if="draftFor(group.ordinal)" class="option-grid">
          <label>
            <span>Materiál</span>
            <select
              :value="draftFor(group.ordinal)!.option.material"
              :disabled="configurationLocked"
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
              :disabled="configurationLocked"
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
              :disabled="configurationLocked"
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
              :disabled="configurationLocked"
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
              :disabled="configurationLocked"
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
                :disabled="configurationLocked"
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
            :disabled="configurationLocked"
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
          :disabled="configurationLocked"
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

    <section
      v-if="!quote.configurationEditable && quote.items.length > 0"
      class="configurator-section"
      aria-labelledby="saved-configuration-title"
    >
      <p class="eyebrow">VÝROBNÍ KONFIGURACE</p>
      <h3 id="saved-configuration-title">Co závazná kalkulace obsahuje.</h3>
      <article
        v-for="item in quote.items"
        :key="item.id"
        class="item-configuration"
      >
        <div class="configurator-section-heading">
          <div>
            <p class="eyebrow">POLOŽKA {{ item.ordinal + 1 }}</p>
            <strong>{{ item.quantity }} ks</strong>
          </div>
          <span class="mono">{{ item.bodyIds.join(", ") }}</span>
        </div>
        <p>
          {{ item.material }} · {{ colorLabel(item.color) }} ·
          {{ qualityLabel(item.quality) }} ·
          {{ infillLabel(item.infillPreset) }}
        </p>
      </article>
    </section>

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
        <button
          v-if="canRecoverWithStandardProduction(quote)"
          class="secondary-button compact-button"
          type="button"
          :disabled="configurationLocked"
          @click="continueWithoutExpress"
        >
          Pokračovat bez expresu
        </button>
      </div>
    </div>

    <section
      v-if="
        quote.phase === 'HANDOFF_REQUIRED' &&
        canRecoverWithStandardProduction(quote)
      "
      class="configurator-section"
    >
      <p class="eyebrow">EXPRESNÍ VÝROBA</p>
      <h3>Expresní termín teď nemůžeme bezpečně potvrdit.</h3>
      <p>
        Ověřenou dopravu zachováme a zkusíme závaznou cenu pro standardní
        výrobu.
      </p>
      <button
        class="primary-button"
        type="button"
        :disabled="configurationLocked"
        @click="continueWithoutExpress"
      >
        Pokračovat bez expresu
      </button>
    </section>

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
            :disabled="
              entry.finding.decision === 'ACKNOWLEDGED' || configurationLocked
            "
            type="checkbox"
          />
          <span>{{ entry.finding.message }}</span>
        </label>
        <button
          class="text-button"
          type="button"
          :disabled="configurationLocked"
          @click="declineRisk(entry.item.ordinal, entry.finding)"
        >
          Nepřijmout a požádat o individuální nabídku
        </button>
      </div>
      <button
        class="primary-button"
        type="button"
        :disabled="!allWarningsAcknowledged || configurationLocked"
        @click="submitRiskDecisions"
      >
        Potvrdit a pokračovat
      </button>
    </section>

    <section
      v-if="
        quote.phase === 'DESTINATION_REQUIRED' ||
        (quote.phase === 'CHECKOUT_READY' && !quote.checkoutEvidenceAccepted)
      "
      class="configurator-section"
    >
      <p class="eyebrow">03 / DOPRAVA</p>
      <h3>
        {{
          quote.phase === "CHECKOUT_READY"
            ? "Změnit místo doručení"
            : "Vyberte ověřené místo doručení."
        }}
      </h3>
      <p v-if="quote.phase === 'CHECKOUT_READY'">
        Změna místa zruší současnou závaznou cenu a rezervaci. Novou cenu před
        platbou znovu výslovně zkontrolujete.
      </p>
      <label class="wide-field">
        <span>Způsob a místo</span>
        <select v-model="selectedDestination" :disabled="configurationLocked">
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
        <input
          v-model="expressRequested"
          :disabled="configurationLocked"
          type="checkbox"
        />
        <span>Expresní výroba pro celou objednávku</span>
      </label>
      <button
        class="primary-button"
        type="button"
        :disabled="
          !selectedDeliveryOption ||
          pending ||
          saving ||
          (quote.phase === 'CHECKOUT_READY' && !selectedDestinationChanged)
        "
        @click="submitDestination"
      >
        {{
          quote.phase === "CHECKOUT_READY"
            ? "Přepočítat s jiným místem"
            : "Ověřit dopravu a závaznou cenu"
        }}
      </button>
    </section>

    <OrderCheckoutPanel
      v-if="quote.phase === 'CHECKOUT_READY'"
      :on-refresh="onRefresh"
      :on-restart="onRestart"
      :quote="quote"
    />

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
      <dl v-if="currentPrice.taxRegime === 'VAT_PAYER'" class="my-4 grid gap-1">
        <div class="flex justify-between gap-4">
          <dt>Cena bez DPH</dt>
          <dd class="mono m-0">
            {{
              formatMoney(currentPrice.netAmountMinor, currentPrice.currency)
            }}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt>DPH {{ currentPrice.vatRateBasisPoints / 100 }} %</dt>
          <dd class="mono m-0">
            {{
              formatMoney(currentPrice.vatAmountMinor, currentPrice.currency)
            }}
          </dd>
        </div>
      </dl>
      <p v-else class="my-4 text-sm">
        Konečná cena. Provozovatel není plátcem DPH.
      </p>
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
