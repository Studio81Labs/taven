import type { components } from "@taven/openapi-client";

export type QuoteSession = components["schemas"]["AutomaticQuoteSessionDto"];
export type ConfigurationOption =
  components["schemas"]["AutomaticQuoteConfigurationOptionDto"];
export type QuoteItem = components["schemas"]["AutomaticQuoteItemDto"];
export type PriceComponent =
  components["schemas"]["AutomaticQuotePriceComponentDto"];
export type QuantityComparison =
  components["schemas"]["AutomaticQuoteQuantityComparisonDto"];

export type BodyGroup = Readonly<{
  ordinal: number;
  bodyIds: readonly string[];
}>;

export function initialBodyGroups(
  bodyIds: readonly string[],
  items: readonly Pick<QuoteItem, "bodyIds" | "ordinal">[],
): BodyGroup[] {
  if (items.length > 0) {
    const groups = [...items]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => ({ ordinal: item.ordinal, bodyIds: [...item.bodyIds] }));
    const configured = new Set(groups.flatMap((group) => group.bodyIds));
    const unconfigured = bodyIds.filter((bodyId) => !configured.has(bodyId));
    if (unconfigured.length > 0) {
      groups.push({ ordinal: groups.length, bodyIds: unconfigured });
    }
    return groups;
  }
  return bodyIds.length > 0 ? [{ ordinal: 0, bodyIds: [...bodyIds] }] : [];
}

export function groupsFromAssignments(
  bodyIds: readonly string[],
  assignments: Readonly<Record<string, number>>,
): BodyGroup[] {
  const groups = new Map<number, string[]>();
  for (const bodyId of bodyIds) {
    const assigned = assignments[bodyId];
    if (
      typeof assigned !== "number" ||
      !Number.isSafeInteger(assigned) ||
      assigned < 0
    )
      continue;
    const group = groups.get(assigned) ?? [];
    group.push(bodyId);
    groups.set(assigned, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, groupedBodyIds], ordinal) => ({
      ordinal,
      bodyIds: groupedBodyIds,
    }));
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
  quote: Pick<QuoteSession, "express">,
): boolean {
  return quote.express.eligible || quote.express.requested;
}

export function requiresAssistedQuote(
  quote: Pick<QuoteSession, "phase" | "handoff">,
): boolean {
  return quote.phase === "HANDOFF_REQUIRED" || Boolean(quote.handoff);
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
  };
  return labels[component.kind] ?? component.kind;
}

export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("cs-CZ", {
    currency,
    style: "currency",
  }).format(amountMinor / 100);
}
