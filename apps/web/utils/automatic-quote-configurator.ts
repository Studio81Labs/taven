import type { components } from "@taven/openapi-client";

export type QuoteSession = components["schemas"]["AutomaticQuoteSessionDto"];
export type ConfigurationOption =
  components["schemas"]["AutomaticQuoteConfigurationOptionDto"];
export type QuoteItem = components["schemas"]["AutomaticQuoteItemDto"];
export type PriceComponent =
  components["schemas"]["AutomaticQuotePriceComponentDto"];
export type QuantityComparison =
  components["schemas"]["AutomaticQuoteQuantityComparisonDto"];
export type QuoteModelFile = QuoteSession["modelFiles"][number];

export type ModelBodyGroup = Readonly<{
  modelFileId: string;
  ordinal: number;
  bodyIds: readonly string[];
}>;

export function canAddBodyGroup(
  bodyCount: number,
  groupCount: number,
): boolean {
  return bodyCount > groupCount;
}

export function bodyAssignmentKey(modelFileId: string, bodyId: string): string {
  return JSON.stringify([modelFileId, bodyId]);
}

export function initialModelBodyGroups(
  modelFiles: readonly Pick<
    QuoteModelFile,
    "discoveredBodyIds" | "modelFileId"
  >[],
  items: readonly Pick<QuoteItem, "bodyIds" | "modelFileId" | "ordinal">[],
): ModelBodyGroup[] {
  if (items.length > 0) {
    return [...items]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => ({
        ordinal: item.ordinal,
        modelFileId: item.modelFileId,
        bodyIds: [...item.bodyIds],
      }));
  }
  return modelFiles
    .filter((modelFile) => modelFile.discoveredBodyIds.length > 0)
    .map((modelFile, ordinal) => ({
      ordinal,
      modelFileId: modelFile.modelFileId,
      bodyIds: [...modelFile.discoveredBodyIds],
    }));
}

export function initialModelBodyAssignments(
  modelFiles: readonly Pick<
    QuoteModelFile,
    "discoveredBodyIds" | "modelFileId"
  >[],
  groups: readonly ModelBodyGroup[],
): Record<string, number> {
  const assignments = Object.fromEntries(
    modelFiles.flatMap((modelFile) =>
      modelFile.discoveredBodyIds.map((bodyId) => [
        bodyAssignmentKey(modelFile.modelFileId, bodyId),
        -1,
      ]),
    ),
  );
  for (const group of groups) {
    for (const bodyId of group.bodyIds) {
      assignments[bodyAssignmentKey(group.modelFileId, bodyId)] = group.ordinal;
    }
  }
  return assignments;
}

export function modelGroupsFromAssignments(
  modelFiles: readonly Pick<
    QuoteModelFile,
    "discoveredBodyIds" | "modelFileId"
  >[],
  assignments: Readonly<Record<string, number>>,
): ModelBodyGroup[] {
  const groups: ModelBodyGroup[] = [];
  for (const modelFile of modelFiles) {
    const groupsByOrdinal = new Map<number, string[]>();
    for (const bodyId of modelFile.discoveredBodyIds) {
      const assigned =
        assignments[bodyAssignmentKey(modelFile.modelFileId, bodyId)];
      if (
        typeof assigned !== "number" ||
        !Number.isSafeInteger(assigned) ||
        assigned < 0
      )
        continue;
      const group = groupsByOrdinal.get(assigned) ?? [];
      group.push(bodyId);
      groupsByOrdinal.set(assigned, group);
    }
    for (const [ordinal, bodyIds] of groupsByOrdinal) {
      groups.push({ modelFileId: modelFile.modelFileId, ordinal, bodyIds });
    }
  }
  return groups.sort((left, right) => left.ordinal - right.ordinal);
}

export type ConfigurationField =
  "material" | "color" | "quality" | "infillPreset";

export function configurationValues(
  options: readonly ConfigurationOption[],
  selected: ConfigurationOption,
  field: ConfigurationField,
): Array<string | null> {
  const candidates = options.filter((option) => {
    if (field === "material") return true;
    if (option.material !== selected.material) return false;
    if (field === "color") return true;
    if (option.color !== selected.color) return false;
    if (field === "quality") return true;
    return option.quality === selected.quality;
  });
  return [...new Set(candidates.map((option) => optionValue(option, field)))];
}

export function selectConfigurationOption(
  options: readonly ConfigurationOption[],
  selected: ConfigurationOption,
  field: ConfigurationField,
  value: string | null,
): ConfigurationOption | undefined {
  const candidates = options.filter((option) => {
    if (optionValue(option, field) !== value) return false;
    if (field === "material") return true;
    if (option.material !== selected.material) return false;
    if (field === "color") return true;
    if (option.color !== selected.color) return false;
    if (field === "quality") return true;
    return option.quality === selected.quality;
  });
  return [...candidates].sort(
    (left, right) =>
      optionDistance(left, selected) - optionDistance(right, selected),
  )[0];
}

function optionValue(
  option: ConfigurationOption,
  field: ConfigurationField,
): string | null {
  return option[field] ?? null;
}

function optionDistance(
  candidate: ConfigurationOption,
  selected: ConfigurationOption,
): number {
  return (
    Number(candidate.material !== selected.material) +
    Number(candidate.color !== selected.color) +
    Number(candidate.quality !== selected.quality) +
    Number(candidate.infillPreset !== selected.infillPreset)
  );
}

export function quantityComparison(
  activeOrdinal: number,
  quantities: Readonly<Record<number, number>>,
  comparisons: readonly QuantityComparison[] = [],
) {
  const quantity = quantities[activeOrdinal] ?? 1;
  return ([1, 5, 20] as const).map((value) => {
    const comparison = comparisons.find(
      (candidate) =>
        candidate.itemOrdinal === activeOrdinal && candidate.quantity === value,
    );
    return {
      active: value === quantity,
      currency: comparison?.currency,
      orderTotalMinor: comparison?.orderTotalMinor,
      value,
    };
  });
}

const ORDER_SINGLETON_KINDS = new Set([
  "ORDER_MIN_PRINT",
  "ORDER_SMALL_SURCHARGE",
  "EXPRESS",
  "PAYMENT_FEE",
  "VAT",
]);

export function visiblePriceComponents(
  components: readonly PriceComponent[],
): PriceComponent[] {
  const seenSingletons = new Set<string>();
  return components.filter((component) => {
    if (!ORDER_SINGLETON_KINDS.has(component.kind)) return true;
    if (seenSingletons.has(component.kind)) return false;
    seenSingletons.add(component.kind);
    return true;
  });
}

export function isExpressVisible(
  quote: Pick<QuoteSession, "express" | "phase">,
): boolean {
  return (
    quote.phase !== "CHECKOUT_READY" &&
    (quote.express.eligible || quote.express.requested)
  );
}

export function canRecoverWithStandardProduction(
  quote: Pick<QuoteSession, "express" | "handoff" | "phase">,
): boolean {
  if (!quote.express.requested) return false;
  if (quote.phase === "ELIGIBILITY_PENDING") return true;
  return (
    quote.phase === "HANDOFF_REQUIRED" &&
    quote.handoff?.reasons.length === 1 &&
    quote.handoff.reasons[0] === "EXPRESS_INELIGIBLE"
  );
}

export function requiresAssistedQuote(
  quote: Pick<QuoteSession, "phase" | "handoff">,
): boolean {
  return quote.phase === "HANDOFF_REQUIRED" || Boolean(quote.handoff);
}

export function shouldShowUnavailableConfigurationWarning(
  quote: Pick<
    QuoteSession,
    "configurationEditable" | "configurationOptions" | "handoff" | "phase"
  >,
): boolean {
  return (
    quote.configurationOptions.length === 0 &&
    (quote.configurationEditable || requiresAssistedQuote(quote))
  );
}

export function requiresQuoteRestart(
  quote: Pick<QuoteSession, "phase">,
): boolean {
  return quote.phase === "EXPIRED";
}

export function priceLabel(component: PriceComponent): string {
  const labels: Record<string, string> = {
    EXPRESS: "Expresní výroba",
    ITEM_POSTPROCESSING: "Dokončení",
    ITEM_PRODUCTION: "Tisk položky",
    ITEM_QUANTITY: "Množství",
    ORDER_MIN_PRINT: "Minimální cena tisku",
    ORDER_SMALL_SURCHARGE: "Příplatek za zakázku pod 100 g",
    PAYMENT_FEE: "Platební poplatek",
    SHIPMENT: "Doprava",
    VAT: "DPH",
  };
  return labels[component.kind] ?? component.kind;
}

export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("cs-CZ", {
    currency,
    style: "currency",
  }).format(amountMinor / 100);
}
