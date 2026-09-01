import type { Material, Prisma } from "@prisma/client";
import type { PreparedOrderQuote } from "@taven/core" with {
  "resolution-mode": "import",
};

type JsonRecord = Record<string, unknown>;

export type AutomaticQuotePricingParameters = Readonly<{
  machineRateMinorPerSecond: RationalValue;
  laborRateMinorPerSecond: RationalValue;
  amortizationRateMinorPerSecond: RationalValue;
  reprintRate: RationalValue;
  marginRate: RationalValue;
  materialRateMinorPerMilligram: Readonly<Record<Material, RationalValue>>;
  roughMaterialDensityMilligramsPerCubicMillimeter: Readonly<
    Record<Material, RationalValue>
  >;
  roughMaterialVolumeRatioByInfillPreset: Readonly<
    Record<"DECORATIVE" | "STANDARD" | "STRONG", RationalValue>
  >;
  roughExtrusionMilligramsPerSecond: RationalValue;
  handlingOrderFixedSeconds: bigint;
  handlingPlateSeconds: bigint;
  handlingPieceSeconds: bigint;
  handlingPackSeconds: bigint;
  shippingTripSeconds: bigint;
  shippingTripPricingDivisor: bigint;
  minimumPrintPriceMinor: bigint;
  smallOrderWeightThresholdMilligrams: bigint;
  smallOrderSurchargeMinor: bigint;
  freeShippingPrintThresholdMinor: bigint;
  expressMultiplier: RationalValue;
  expressMaximumPlateCount: bigint;
  expressAvailableProductionWindowSeconds: bigint;
  expressPackagingBufferSeconds: bigint;
  maximumAutomaticQuantity: bigint;
  maximumAutomaticAmountMinor: bigint;
  packingPaddingMicrometers: bigint;
  fillCoefficient: RationalValue;
  packagingWeightMilligrams: bigint;
  paymentFeeRateBasisPoints: number;
  paymentFeeFixedMinor: bigint;
  paymentProviderConfig: Prisma.InputJsonObject;
  shipmentCategories: readonly ShipmentCategoryParameters[];
}>;

type RationalValue = Readonly<{ numerator: bigint; denominator: bigint }>;

type ShipmentCategoryParameters = Readonly<{
  id: string;
  maxXMicrometers: bigint;
  maxYMicrometers: bigint;
  maxZMicrometers: bigint;
  maxDimensionSumMicrometers: bigint;
  maxWeightMilligrams: bigint;
  maxParcelVolumeCubicMicrometers: bigint;
  carrierCostMinor: bigint;
  customerShippingRateMinor: bigint;
  packagingCostMinor: bigint;
}>;

export type AutomaticQuotePricingItem = Readonly<{
  id: string;
  referenceProfileId: string;
  material: Material;
  quantity: number;
  referencePartsPerPlate: number;
  primary: SliceMetrics;
  tail: SliceMetrics | null;
  boundsXMicrometers: bigint;
  boundsYMicrometers: bigint;
  boundsZMicrometers: bigint;
  fulfilmentSlots: readonly { packingUnitKey: string }[];
}>;

type SliceMetrics = Readonly<{
  estimatedPrintSeconds: bigint;
  estimatedMaterialMilligrams: bigint;
}>;

export type AutomaticQuotePreparationInput = Readonly<{
  priceList: {
    id: string;
    revision: string;
    termsRevision: string;
    currency: string;
    parameters: Prisma.JsonValue;
  };
  items: readonly AutomaticQuotePricingItem[];
  expressRequested: boolean;
  materialAndColorAvailable: boolean;
  withinBuildLimits: boolean;
  riskAcknowledgementsComplete: boolean;
  hasBlockingPreflightFinding: boolean;
  deliveryDestination?: {
    id: string;
    capabilitySnapshot: Prisma.JsonValue;
  };
  shipmentPlanIdForOrdinal?: (ordinal: number) => string;
}>;

export type AutomaticBindingQuote = Extract<
  PreparedOrderQuote,
  { kind: "binding_quote" }
>;

export async function prepareAutomaticQuote(
  input: AutomaticQuotePreparationInput,
): Promise<{
  prepared: PreparedOrderQuote;
  parameters: AutomaticQuotePricingParameters;
}> {
  const { Money, planShipment, prepareOrderQuote } =
    await import("@taven/core");
  const parameters = parseAutomaticQuotePricingParameters(
    input.priceList.parameters,
  );
  const requiredPlateCount = input.items.reduce(
    (total, item) => total + productionMetrics(item, parameters).plateCount,
    0n,
  );
  const requiredProductionSeconds = input.items.reduce(
    (total, item) =>
      total +
      productionMetrics(item, parameters).base.machineSeconds +
      productionMetrics(item, parameters).quantityEffect.machineSeconds,
    0n,
  );
  const totalQuantity = input.items.reduce(
    (total, item) => total + BigInt(item.quantity),
    0n,
  );
  const provisionalPricing = {
    priceList: {
      revision: input.priceList.revision,
      termsRevision: input.priceList.termsRevision,
      currency: input.priceList.currency,
      machineRateMinorPerSecond: parameters.machineRateMinorPerSecond,
      laborRateMinorPerSecond: parameters.laborRateMinorPerSecond,
      amortizationRateMinorPerSecond: parameters.amortizationRateMinorPerSecond,
      reprintRate: parameters.reprintRate,
      marginRate: parameters.marginRate,
      handlingOrderFixedSeconds: parameters.handlingOrderFixedSeconds,
      handlingPlateSeconds: parameters.handlingPlateSeconds,
      handlingPackSeconds: parameters.handlingPackSeconds,
      shippingTripSeconds: parameters.shippingTripSeconds,
      shippingTripPricingDivisor: parameters.shippingTripPricingDivisor,
      minimumPrintPrice: Money.of(
        parameters.minimumPrintPriceMinor,
        input.priceList.currency,
      ),
      smallOrderWeightThresholdMilligrams:
        parameters.smallOrderWeightThresholdMilligrams,
      smallOrderSurcharge: Money.of(
        parameters.smallOrderSurchargeMinor,
        input.priceList.currency,
      ),
      freeShippingPrintThreshold: Money.of(
        parameters.freeShippingPrintThresholdMinor,
        input.priceList.currency,
      ),
      expressMultiplier: parameters.expressMultiplier,
    },
    profileRevisionIds: [
      ...new Set(
        input.items.map(({ referenceProfileId }) => referenceProfileId),
      ),
    ].sort(),
    items: input.items.map((item) => {
      const metrics = productionMetrics(item, parameters);
      return {
        itemId: item.id,
        quantity: BigInt(item.quantity),
        materialRateMinorPerMilligram:
          parameters.materialRateMinorPerMilligram[item.material],
        base: metrics.base,
        quantityEffect: metrics.quantityEffect,
        postprocessingSeconds: 0n,
        packingUnits: item.fulfilmentSlots.map((slot) => ({
          id: slot.packingUnitKey,
          basis: perUnitBasis(item),
        })),
      };
    }),
    expressRequested: input.expressRequested,
    paymentSchedule: [
      {
        id: "automatic-full-payment",
        sequence: 0,
        role: "FULL" as const,
        shareBasisPoints: 10_000,
        feeRateBasisPoints: parameters.paymentFeeRateBasisPoints,
        feeFixed: Money.of(
          parameters.paymentFeeFixedMinor,
          input.priceList.currency,
        ),
      },
    ],
  };
  const provisional = prepareOrderQuote({
    pricing: provisionalPricing,
    automaticQuoteFacts: {
      referenceSlicingComplete: true,
      supportedFormat: true,
      hasBlockingPreflightFinding: input.hasBlockingPreflightFinding,
      riskAcknowledgementsComplete: input.riskAcknowledgementsComplete,
      withinAutomaticQuantityLimit:
        totalQuantity <= parameters.maximumAutomaticQuantity,
      withinAutomaticAmountLimit: true,
      withinBuildLimits: input.withinBuildLimits,
    },
    expressEligibility: {
      phaseKind: "SINGLE",
      requiredPlateCount,
      materialAndColorAvailable: input.materialAndColorAvailable,
      hasNonstandardPostprocessing: false,
      requiredProductionSeconds,
      availableProductionWindowSeconds:
        parameters.expressAvailableProductionWindowSeconds,
      packagingBufferSeconds: parameters.expressPackagingBufferSeconds,
    },
  });
  const provisionalAmount = provisional.price.breakdown.subtotal.minorUnits;
  const common = {
    pricing: provisionalPricing,
    automaticQuoteFacts: {
      referenceSlicingComplete: true,
      supportedFormat: true,
      hasBlockingPreflightFinding: input.hasBlockingPreflightFinding,
      riskAcknowledgementsComplete: input.riskAcknowledgementsComplete,
      withinAutomaticQuantityLimit:
        totalQuantity <= parameters.maximumAutomaticQuantity,
      withinAutomaticAmountLimit:
        provisionalAmount <= parameters.maximumAutomaticAmountMinor,
      withinBuildLimits: input.withinBuildLimits,
    },
    expressEligibility: {
      phaseKind: "SINGLE" as const,
      requiredPlateCount,
      materialAndColorAvailable: input.materialAndColorAvailable,
      hasNonstandardPostprocessing: false,
      requiredProductionSeconds,
      availableProductionWindowSeconds:
        parameters.expressAvailableProductionWindowSeconds,
      packagingBufferSeconds: parameters.expressPackagingBufferSeconds,
    },
  };
  if (!input.deliveryDestination || !input.shipmentPlanIdForOrdinal) {
    return { prepared: prepareOrderQuote(common), parameters };
  }
  const supportedCategoryIds = stringArray(
    record(input.deliveryDestination.capabilitySnapshot, "capabilitySnapshot")
      .supportedCategoryIds,
    "capabilitySnapshot.supportedCategoryIds",
  );
  const plannerInput = {
    units: input.items.flatMap((item) =>
      item.fulfilmentSlots.map((slot) => ({
        packingUnitKey: slot.packingUnitKey,
        box: {
          xMicrometers:
            item.boundsXMicrometers + parameters.packingPaddingMicrometers * 2n,
          yMicrometers:
            item.boundsYMicrometers + parameters.packingPaddingMicrometers * 2n,
          zMicrometers:
            item.boundsZMicrometers + parameters.packingPaddingMicrometers * 2n,
        },
        weightMilligrams: perUnitWeight(item),
      })),
    ),
    categories: parameters.shipmentCategories.map((category) => ({
      id: category.id,
      maxXMicrometers: category.maxXMicrometers,
      maxYMicrometers: category.maxYMicrometers,
      maxZMicrometers: category.maxZMicrometers,
      maxDimensionSumMicrometers: category.maxDimensionSumMicrometers,
      maxWeightMilligrams: category.maxWeightMilligrams,
      maxParcelVolumeCubicMicrometers: category.maxParcelVolumeCubicMicrometers,
    })),
    supportedCategoryIds: new Set(supportedCategoryIds),
    fillCoefficientNumerator: parameters.fillCoefficient.numerator,
    fillCoefficientDenominator: parameters.fillCoefficient.denominator,
    packagingWeightMilligrams: parameters.packagingWeightMilligrams,
  };
  const planned = planShipment(plannerInput);
  const shipmentPlanIdsByOrdinal = new Map<number, string>();
  if (planned.status === "planned") {
    for (const parcel of planned.parcels) {
      shipmentPlanIdsByOrdinal.set(
        parcel.ordinal,
        input.shipmentPlanIdForOrdinal(parcel.ordinal),
      );
    }
  }
  return {
    prepared: prepareOrderQuote({
      ...common,
      destinationShipment: {
        deliveryDestinationId: input.deliveryDestination.id,
        deliveryCapabilitySnapshotId: capabilitySnapshotIdentity(
          input.deliveryDestination.capabilitySnapshot,
        ),
        shipmentPlanIdsByOrdinal,
        plannerInput,
        categoryPricing: parameters.shipmentCategories.map((category) => ({
          categoryId: category.id,
          carrierCost: Money.of(
            category.carrierCostMinor,
            input.priceList.currency,
          ),
          customerShippingRate: Money.of(
            category.customerShippingRateMinor,
            input.priceList.currency,
          ),
          packagingCost: Money.of(
            category.packagingCostMinor,
            input.priceList.currency,
          ),
        })),
      },
    }),
    parameters,
  };
}

function productionMetrics(
  item: AutomaticQuotePricingItem,
  parameters: AutomaticQuotePricingParameters,
) {
  const fullPlateCount = Math.floor(
    item.quantity / item.referencePartsPerPlate,
  );
  const remainder = item.quantity % item.referencePartsPerPlate;
  const primaryMultiplier = Math.max(1, fullPlateCount);
  const totalPrintSeconds =
    item.primary.estimatedPrintSeconds * BigInt(primaryMultiplier) +
    (remainder > 0 && item.quantity > item.referencePartsPerPlate
      ? (item.tail?.estimatedPrintSeconds ?? 0n)
      : 0n);
  const totalMaterial =
    item.primary.estimatedMaterialMilligrams * BigInt(primaryMultiplier) +
    (remainder > 0 && item.quantity > item.referencePartsPerPlate
      ? (item.tail?.estimatedMaterialMilligrams ?? 0n)
      : 0n);
  const plateCount =
    BigInt(primaryMultiplier) +
    (remainder > 0 && item.quantity > item.referencePartsPerPlate ? 1n : 0n);
  const base = {
    materialWeightMilligrams: item.primary.estimatedMaterialMilligrams,
    machineSeconds: item.primary.estimatedPrintSeconds,
    plateCount: 1n,
    pieceHandlingSeconds:
      BigInt(Math.min(item.quantity, item.referencePartsPerPlate)) *
      parameters.handlingPieceSeconds,
  };
  return {
    plateCount,
    base,
    quantityEffect: {
      materialWeightMilligrams: totalMaterial - base.materialWeightMilligrams,
      machineSeconds: totalPrintSeconds - base.machineSeconds,
      plateCount: plateCount - 1n,
      pieceHandlingSeconds:
        BigInt(
          item.quantity - Math.min(item.quantity, item.referencePartsPerPlate),
        ) * parameters.handlingPieceSeconds,
    },
  };
}

function perUnitWeight(item: AutomaticQuotePricingItem): bigint {
  const fullPlateCount = Math.floor(
    item.quantity / item.referencePartsPerPlate,
  );
  const remainder = item.quantity % item.referencePartsPerPlate;
  const total =
    item.primary.estimatedMaterialMilligrams *
      BigInt(Math.max(1, fullPlateCount)) +
    (remainder > 0 && item.quantity > item.referencePartsPerPlate
      ? (item.tail?.estimatedMaterialMilligrams ?? 0n)
      : 0n);
  return (total + BigInt(item.quantity) - 1n) / BigInt(item.quantity);
}

function perUnitBasis(item: AutomaticQuotePricingItem): bigint {
  return perUnitWeight(item) + 1n;
}

function capabilitySnapshotIdentity(value: Prisma.JsonValue): string {
  const serialized = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `delivery-capability-${(hash >>> 0).toString(16)}`;
}

export function parseAutomaticQuotePricingParameters(
  value: Prisma.JsonValue,
): AutomaticQuotePricingParameters {
  const root = record(value, "priceList.parameters");
  const automatic = record(root.automaticQuote, "parameters.automaticQuote");
  const materialRates = record(
    automatic.materialRateMinorPerMilligram,
    "materialRateMinorPerMilligram",
  );
  const categories = array(
    automatic.shipmentCategories,
    "shipmentCategories",
  ).map((entry, index) => {
    const category = record(entry, `shipmentCategories[${index}]`);
    return {
      id: text(category.id, `shipmentCategories[${index}].id`),
      maxXMicrometers: integer(category.maxXMicrometers, "maxXMicrometers"),
      maxYMicrometers: integer(category.maxYMicrometers, "maxYMicrometers"),
      maxZMicrometers: integer(category.maxZMicrometers, "maxZMicrometers"),
      maxDimensionSumMicrometers: integer(
        category.maxDimensionSumMicrometers,
        "maxDimensionSumMicrometers",
      ),
      maxWeightMilligrams: integer(
        category.maxWeightMilligrams,
        "maxWeightMilligrams",
      ),
      maxParcelVolumeCubicMicrometers: integer(
        category.maxParcelVolumeCubicMicrometers,
        "maxParcelVolumeCubicMicrometers",
      ),
      carrierCostMinor: integer(category.carrierCostMinor, "carrierCostMinor"),
      customerShippingRateMinor: integer(
        category.customerShippingRateMinor,
        "customerShippingRateMinor",
      ),
      packagingCostMinor: integer(
        category.packagingCostMinor,
        "packagingCostMinor",
      ),
    };
  });
  if (categories.length === 0) throw new Error("shipmentCategories is empty");
  return {
    machineRateMinorPerSecond: rational(
      automatic.machineRateMinorPerSecond,
      "machineRateMinorPerSecond",
    ),
    laborRateMinorPerSecond: rational(
      automatic.laborRateMinorPerSecond,
      "laborRateMinorPerSecond",
    ),
    amortizationRateMinorPerSecond: rational(
      automatic.amortizationRateMinorPerSecond,
      "amortizationRateMinorPerSecond",
    ),
    reprintRate: rational(automatic.reprintRate, "reprintRate"),
    marginRate: rational(automatic.marginRate, "marginRate"),
    materialRateMinorPerMilligram: {
      PLA: rational(materialRates.PLA, "materialRate.PLA"),
      PETG: rational(materialRates.PETG, "materialRate.PETG"),
    },
    roughMaterialDensityMilligramsPerCubicMillimeter: materialRationals(
      automatic.roughMaterialDensityMilligramsPerCubicMillimeter,
      "roughMaterialDensityMilligramsPerCubicMillimeter",
    ),
    roughMaterialVolumeRatioByInfillPreset: infillRationals(
      automatic.roughMaterialVolumeRatioByInfillPreset,
      "roughMaterialVolumeRatioByInfillPreset",
    ),
    roughExtrusionMilligramsPerSecond: rational(
      automatic.roughExtrusionMilligramsPerSecond,
      "roughExtrusionMilligramsPerSecond",
    ),
    handlingOrderFixedSeconds: integer(
      automatic.handlingOrderFixedSeconds,
      "handlingOrderFixedSeconds",
    ),
    handlingPlateSeconds: integer(
      automatic.handlingPlateSeconds,
      "handlingPlateSeconds",
    ),
    handlingPieceSeconds: integer(
      automatic.handlingPieceSeconds,
      "handlingPieceSeconds",
    ),
    handlingPackSeconds: integer(
      automatic.handlingPackSeconds,
      "handlingPackSeconds",
    ),
    shippingTripSeconds: integer(
      automatic.shippingTripSeconds,
      "shippingTripSeconds",
    ),
    shippingTripPricingDivisor: positiveInteger(
      automatic.shippingTripPricingDivisor,
      "shippingTripPricingDivisor",
    ),
    minimumPrintPriceMinor: integer(
      automatic.minimumPrintPriceMinor,
      "minimumPrintPriceMinor",
    ),
    smallOrderWeightThresholdMilligrams: integer(
      automatic.smallOrderWeightThresholdMilligrams,
      "smallOrderWeightThresholdMilligrams",
    ),
    smallOrderSurchargeMinor: integer(
      automatic.smallOrderSurchargeMinor,
      "smallOrderSurchargeMinor",
    ),
    freeShippingPrintThresholdMinor: integer(
      automatic.freeShippingPrintThresholdMinor,
      "freeShippingPrintThresholdMinor",
    ),
    expressMultiplier: rational(
      automatic.expressMultiplier,
      "expressMultiplier",
    ),
    expressMaximumPlateCount: positiveInteger(
      automatic.expressMaximumPlateCount,
      "expressMaximumPlateCount",
    ),
    expressAvailableProductionWindowSeconds: positiveInteger(
      automatic.expressAvailableProductionWindowSeconds,
      "expressAvailableProductionWindowSeconds",
    ),
    expressPackagingBufferSeconds: integer(
      automatic.expressPackagingBufferSeconds,
      "expressPackagingBufferSeconds",
    ),
    maximumAutomaticQuantity: positiveInteger(
      automatic.maximumAutomaticQuantity,
      "maximumAutomaticQuantity",
    ),
    maximumAutomaticAmountMinor: positiveInteger(
      automatic.maximumAutomaticAmountMinor,
      "maximumAutomaticAmountMinor",
    ),
    packingPaddingMicrometers: integer(
      automatic.packingPaddingMicrometers,
      "packingPaddingMicrometers",
    ),
    fillCoefficient: rational(automatic.fillCoefficient, "fillCoefficient"),
    packagingWeightMilligrams: integer(
      automatic.packagingWeightMilligrams,
      "packagingWeightMilligrams",
    ),
    paymentFeeRateBasisPoints: numberInteger(
      automatic.paymentFeeRateBasisPoints,
      "paymentFeeRateBasisPoints",
    ),
    paymentFeeFixedMinor: integer(
      automatic.paymentFeeFixedMinor,
      "paymentFeeFixedMinor",
    ),
    paymentProviderConfig: record(
      automatic.paymentProviderConfig,
      "paymentProviderConfig",
    ) as Prisma.InputJsonObject,
    shipmentCategories: categories,
  };
}

function rational(value: unknown, name: string): RationalValue {
  const parsed = record(value, name);
  const result = {
    numerator: integer(parsed.numerator, `${name}.numerator`),
    denominator: positiveInteger(parsed.denominator, `${name}.denominator`),
  };
  return result;
}

function materialRationals(
  value: unknown,
  name: string,
): Readonly<Record<Material, RationalValue>> {
  const values = record(value, name);
  return {
    PLA: rational(values.PLA, `${name}.PLA`),
    PETG: rational(values.PETG, `${name}.PETG`),
  };
}

function infillRationals(
  value: unknown,
  name: string,
): Readonly<Record<"DECORATIVE" | "STANDARD" | "STRONG", RationalValue>> {
  const values = record(value, name);
  return {
    DECORATIVE: rational(values.DECORATIVE, `${name}.DECORATIVE`),
    STANDARD: rational(values.STANDARD, `${name}.STANDARD`),
    STRONG: rational(values.STRONG, `${name}.STRONG`),
  };
}

function integer(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer string`);
  }
  return BigInt(value);
}

function positiveInteger(value: unknown, name: string): bigint {
  const parsed = integer(value, name);
  if (parsed <= 0n) throw new Error(`${name} must be positive`);
  return parsed;
}

function numberInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  const values = array(value, name);
  if (values.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${name} must contain non-blank strings`);
  }
  return values.map(String);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-blank string`);
  }
  return value.trim();
}
