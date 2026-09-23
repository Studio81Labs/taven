import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { parseAutomaticQuotePricingParameters } from "../automatic-quotes/automatic-quote-pricing";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_API_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
// The public configurator accepts at most 256 items of 1,000 pieces each.
const MAX_PUBLIC_QUANTITY = 256_000n;
const AUTOMATIC_FIELDS = [
  "machineRateMinorPerSecond",
  "laborRateMinorPerSecond",
  "amortizationRateMinorPerSecond",
  "reprintRate",
  "marginRate",
  "materialRateMinorPerMilligram",
  "roughMaterialDensityMilligramsPerCubicMillimeter",
  "roughMaterialVolumeRatioByInfillPreset",
  "roughExtrusionMilligramsPerSecond",
  "handlingOrderFixedSeconds",
  "handlingPlateSeconds",
  "handlingPieceSeconds",
  "handlingPackSeconds",
  "shippingTripSeconds",
  "shippingTripPricingDivisor",
  "minimumPrintPriceMinor",
  "smallOrderWeightThresholdMilligrams",
  "smallOrderSurchargeMinor",
  "freeShippingPrintThresholdMinor",
  "expressMultiplier",
  "expressMaximumPlateCount",
  "expressAvailableProductionWindowSeconds",
  "expressPackagingBufferSeconds",
  "maximumAutomaticQuantity",
  "maximumAutomaticAmountMinor",
  "packingPaddingMicrometers",
  "fillCoefficient",
  "packagingWeightMilligrams",
  "paymentFeeRateBasisPoints",
  "paymentFeeFixedMinor",
  "paymentProviderConfig",
  "shipmentCategories",
] as const;
const RATIONAL_FIELDS = [
  "machineRateMinorPerSecond",
  "laborRateMinorPerSecond",
  "amortizationRateMinorPerSecond",
  "reprintRate",
  "marginRate",
  "roughExtrusionMilligramsPerSecond",
  "expressMultiplier",
  "fillCoefficient",
] as const;
const CATEGORY_FIELDS = [
  "id",
  "maxXMicrometers",
  "maxYMicrometers",
  "maxZMicrometers",
  "maxDimensionSumMicrometers",
  "maxWeightMilligrams",
  "maxParcelVolumeCubicMicrometers",
  "carrierCostMinor",
  "customerShippingRateMinor",
  "packagingCostMinor",
] as const;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new BadRequestException(`${name}.${extra} is unsupported`);
  const missing = keys.find((key) => !(key in value));
  if (missing) throw new BadRequestException(`${name}.${missing} is required`);
}

function rational(value: unknown, name: string): void {
  exactKeys(record(value, name), ["numerator", "denominator"], name);
}

function rationalGroup(
  value: unknown,
  name: string,
  keys: readonly string[],
): void {
  const group = record(value, name);
  exactKeys(group, keys, name);
  for (const key of keys) rational(group[key], `${name}.${key}`);
}

function checkedInteger(value: bigint, name: string, positive = false): void {
  if (value > MAX_INT64 || (positive && value === 0n)) {
    throw new BadRequestException(`${name} is outside the supported range`);
  }
}

function checkedMoney(value: bigint, name: string): void {
  if (value > MAX_API_MINOR) {
    throw new BadRequestException(`${name} exceeds the quote API range`);
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function validatePriceListParameters(
  value: Prisma.InputJsonObject,
): void {
  const root = record(value, "parameters");
  exactKeys(root, ["sellerTaxPolicy", "automaticQuote"], "parameters");
  exactKeys(
    record(root.sellerTaxPolicy, "sellerTaxPolicy"),
    ["regime", "vatRateBasisPoints"],
    "sellerTaxPolicy",
  );
  const automatic = record(root.automaticQuote, "automaticQuote");
  exactKeys(automatic, AUTOMATIC_FIELDS, "automaticQuote");
  for (const field of RATIONAL_FIELDS) {
    rational(automatic[field], `automaticQuote.${field}`);
  }
  rationalGroup(
    automatic.materialRateMinorPerMilligram,
    "materialRateMinorPerMilligram",
    ["PLA", "PETG"],
  );
  rationalGroup(
    automatic.roughMaterialDensityMilligramsPerCubicMillimeter,
    "roughMaterialDensityMilligramsPerCubicMillimeter",
    ["PLA", "PETG"],
  );
  rationalGroup(
    automatic.roughMaterialVolumeRatioByInfillPreset,
    "roughMaterialVolumeRatioByInfillPreset",
    ["DECORATIVE", "STANDARD", "STRONG"],
  );
  const categories = automatic.shipmentCategories;
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new BadRequestException("shipmentCategories must not be empty");
  }
  for (const [index, category] of categories.entries()) {
    exactKeys(
      record(category, `shipmentCategories[${index}]`),
      CATEGORY_FIELDS,
      `shipmentCategories[${index}]`,
    );
  }
  let parsed: ReturnType<typeof parseAutomaticQuotePricingParameters>;
  try {
    parsed = parseAutomaticQuotePricingParameters(value as Prisma.JsonValue);
  } catch (error) {
    throw new BadRequestException(
      error instanceof Error
        ? error.message
        : "Price-list parameters are invalid",
    );
  }
  for (const field of RATIONAL_FIELDS) {
    const rate = parsed[field];
    checkedInteger(rate.numerator, field);
    checkedInteger(rate.denominator, field, true);
  }
  for (const group of [
    parsed.materialRateMinorPerMilligram,
    parsed.roughMaterialDensityMilligramsPerCubicMillimeter,
    parsed.roughMaterialVolumeRatioByInfillPreset,
  ]) {
    for (const rate of Object.values(group)) {
      checkedInteger(rate.numerator, "rate numerator");
      checkedInteger(rate.denominator, "rate denominator", true);
    }
  }
  if (
    parsed.fillCoefficient.numerator === 0n ||
    parsed.fillCoefficient.numerator > parsed.fillCoefficient.denominator
  ) {
    throw new BadRequestException("fillCoefficient must be in (0, 1]");
  }
  if (
    parsed.expressMultiplier.numerator < parsed.expressMultiplier.denominator
  ) {
    throw new BadRequestException("expressMultiplier must be at least one");
  }
  if (parsed.roughExtrusionMilligramsPerSecond.numerator === 0n) {
    throw new BadRequestException(
      "roughExtrusionMilligramsPerSecond must be positive",
    );
  }
  for (const rate of [
    ...Object.values(parsed.roughMaterialDensityMilligramsPerCubicMillimeter),
    ...Object.values(parsed.roughMaterialVolumeRatioByInfillPreset),
  ]) {
    if (rate.numerator === 0n) {
      throw new BadRequestException("rough material ratios must be positive");
    }
  }
  const integerFields = [
    "handlingOrderFixedSeconds",
    "handlingPlateSeconds",
    "handlingPieceSeconds",
    "handlingPackSeconds",
    "shippingTripSeconds",
    "shippingTripPricingDivisor",
    "minimumPrintPriceMinor",
    "smallOrderWeightThresholdMilligrams",
    "smallOrderSurchargeMinor",
    "freeShippingPrintThresholdMinor",
    "expressMaximumPlateCount",
    "expressAvailableProductionWindowSeconds",
    "expressPackagingBufferSeconds",
    "maximumAutomaticQuantity",
    "maximumAutomaticAmountMinor",
    "packingPaddingMicrometers",
    "packagingWeightMilligrams",
    "paymentFeeFixedMinor",
  ] as const;
  for (const field of integerFields) checkedInteger(parsed[field], field);
  for (const field of [
    "minimumPrintPriceMinor",
    "smallOrderSurchargeMinor",
    "freeShippingPrintThresholdMinor",
    "maximumAutomaticAmountMinor",
    "paymentFeeFixedMinor",
  ] as const) {
    checkedMoney(parsed[field], field);
  }
  if (parsed.expressMaximumPlateCount > 2n) {
    throw new BadRequestException("expressMaximumPlateCount cannot exceed two");
  }
  if (parsed.paymentFeeRateBasisPoints > 10_000) {
    throw new BadRequestException(
      "paymentFeeRateBasisPoints cannot exceed 10000",
    );
  }
  const categoryIds = new Set<string>();
  for (const category of parsed.shipmentCategories) {
    if (category.id.length > 100 || categoryIds.has(category.id)) {
      throw new BadRequestException(
        "shipment category IDs must be unique and at most 100 characters",
      );
    }
    categoryIds.add(category.id);
    for (const field of [
      "maxXMicrometers",
      "maxYMicrometers",
      "maxZMicrometers",
      "maxDimensionSumMicrometers",
      "maxWeightMilligrams",
      "maxParcelVolumeCubicMicrometers",
    ] as const)
      checkedInteger(category[field], field, true);
    for (const field of [
      "carrierCostMinor",
      "customerShippingRateMinor",
      "packagingCostMinor",
    ] as const) {
      checkedInteger(category[field], field);
      checkedMoney(category[field], field);
    }
  }
  const parcelCount =
    parsed.maximumAutomaticQuantity < MAX_PUBLIC_QUANTITY
      ? parsed.maximumAutomaticQuantity
      : MAX_PUBLIC_QUANTITY;
  const labor = parsed.laborRateMinorPerSecond;
  const fixedHandling = ceilDiv(
    parsed.handlingOrderFixedSeconds * labor.numerator,
    labor.denominator,
  );
  const parcelHandling =
    ceilDiv(parsed.handlingPackSeconds * labor.numerator, labor.denominator) +
    ceilDiv(
      parsed.shippingTripSeconds * labor.numerator,
      labor.denominator * parsed.shippingTripPricingDivisor,
    );
  const maximumCategoryCost = parsed.shipmentCategories.reduce(
    (maximum, category) => {
      const cost = category.carrierCostMinor + category.packagingCostMinor;
      return cost > maximum ? cost : maximum;
    },
    0n,
  );
  const maximumShippingRate = parsed.shipmentCategories.reduce(
    (maximum, category) =>
      category.customerShippingRateMinor > maximum
        ? category.customerShippingRateMinor
        : maximum,
    0n,
  );
  const fixedProductionCost =
    fixedHandling + parcelCount * (parcelHandling + maximumCategoryCost);
  const margin = parsed.marginRate;
  const fixedPrintPrice = ceilDiv(
    fixedProductionCost * (margin.denominator + margin.numerator),
    margin.denominator,
  );
  const minimumBasePrice =
    fixedPrintPrice > parsed.minimumPrintPriceMinor
      ? fixedPrintPrice
      : parsed.minimumPrintPriceMinor;
  const maximumConfiguredNet =
    ceilDiv(
      minimumBasePrice * parsed.expressMultiplier.numerator,
      parsed.expressMultiplier.denominator,
    ) +
    parsed.smallOrderSurchargeMinor +
    parcelCount * maximumShippingRate;
  const maximumConfiguredGross = ceilDiv(
    maximumConfiguredNet * BigInt(10_000 + parsed.taxPolicy.vatRateBasisPoints),
    10_000n,
  );
  checkedMoney(maximumConfiguredGross, "configured quote total");
  const maximumPaymentFee =
    ceilDiv(
      parsed.maximumAutomaticAmountMinor *
        BigInt(parsed.paymentFeeRateBasisPoints),
      10_000n,
    ) + parsed.paymentFeeFixedMinor;
  checkedMoney(maximumPaymentFee, "maximum payment fee");
}
