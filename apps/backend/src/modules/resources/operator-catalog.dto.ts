import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ReferenceProfileActivationNoticeDto } from "./reference-profile-activation-notice.dto";

const UUID = { type: String, format: "uuid" } as const;
const MAX_INT64 = "9223372036854775807";
const MIN_INT64_MAGNITUDE = "9223372036854775808";

function positiveIntegerPattern(maximum: string): string {
  const shorter = `[1-9][0-9]{0,${maximum.length - 2}}`;
  const sameLength = Array.from(maximum, (character, index) => {
    const maximumDigit = Number(character);
    const minimumDigit = index === 0 ? 1 : 0;
    if (maximumDigit <= minimumDigit) return null;
    return `${maximum.slice(0, index)}[${minimumDigit}-${maximumDigit - 1}][0-9]{${maximum.length - index - 1}}`;
  }).filter((pattern): pattern is string => pattern !== null);

  return `(?:${[shorter, ...sameLength, maximum].join("|")})`;
}

const POSITIVE_INT64 = positiveIntegerPattern(MAX_INT64);
const POSITIVE_INT64_OR_MIN_MAGNITUDE =
  positiveIntegerPattern(MIN_INT64_MAGNITUDE);
const NON_ZERO_INTEGER = {
  type: String,
  format: "int64",
  pattern: `^(?:${POSITIVE_INT64}|-${POSITIVE_INT64_OR_MIN_MAGNITUDE})$`,
} as const;
const NON_NEGATIVE_INTEGER = {
  type: String,
  format: "int64",
  pattern: `^(?:0|${POSITIVE_INT64})$`,
} as const;
const POSITIVE_INTEGER = {
  type: String,
  format: "int64",
  pattern: `^${POSITIVE_INT64}$`,
} as const;
const MATERIALS = ["PLA", "PETG"] as const;
const PRINT_QUALITIES = ["DRAFT", "STANDARD", "FINE"] as const;
const PRODUCTION_ARTIFACT_FORMATS = ["GCODE_3MF", "BGCODE", "GCODE"] as const;
const MACHINE_STATUSES = ["ACTIVE", "MAINTENANCE", "DISABLED"] as const;
const INVENTORY_STATUSES = ["AVAILABLE", "DEPLETED", "RETIRED"] as const;
const NON_BLANK_TEXT =
  "^(?=[\\s\\S]*\\S)[\\u0001-\\uD7FF\\uE000-\\u{10FFFF}]*$";
const SETTINGS = {
  type: Object,
  additionalProperties: true,
  description:
    "Settings must not exceed 64 nested object or array levels. String keys and values must not contain U+0000 or unpaired UTF-16 surrogates.",
} as const;

export class CatalogCommandResultDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiPropertyOptional({ type: String })
  status?: string;

  @ApiPropertyOptional({ type: String })
  state?: string;
}

export class ReferenceProfileActivationResultDto extends CatalogCommandResultDto {
  @ApiProperty({ type: () => ReferenceProfileActivationNoticeDto })
  notice!: ReferenceProfileActivationNoticeDto;
}

export class CatalogReasonDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 1000,
    pattern: NON_BLANK_TEXT,
  })
  reason!: string;
}

export class ActivateCommercialPolicyDto extends CatalogReasonDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483646 })
  expectedSelectionVersion!: number;
}

export class CommercialPolicySelectionDto {
  @ApiProperty({ type: String })
  currency!: string;

  @ApiProperty(UUID)
  priceListId!: string;

  @ApiProperty({ type: Number })
  selectionVersion!: number;
}

export class CommercialPolicyActivationResultDto extends CommercialPolicySelectionDto {
  @ApiProperty(UUID)
  id!: string;
}

export class CreateReferenceProfileDto {
  @ApiProperty({ type: String, enum: MATERIALS })
  material!: string;

  @ApiProperty({ type: String, enum: PRINT_QUALITIES })
  quality!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  slicerEngine!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  slicerVersion!: string;

  @ApiProperty(SETTINGS)
  settings!: Record<string, unknown>;
}

export class CreateMachineProfileDto extends CreateReferenceProfileDto {
  @ApiProperty(UUID)
  machineCapabilityId!: string;

  @ApiProperty(UUID)
  referenceProfileId!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  nozzleDiameterMicrometers!: number;

  @ApiProperty({ type: String, enum: PRODUCTION_ARTIFACT_FORMATS })
  productionArtifactFormat!: string;
}

export class CreateMachineCapabilityDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  capabilityKey!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  manufacturer!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  model!: string;

  @ApiProperty(POSITIVE_INTEGER)
  buildVolumeXMicrometers!: string;

  @ApiProperty(POSITIVE_INTEGER)
  buildVolumeYMicrometers!: string;

  @ApiProperty(POSITIVE_INTEGER)
  buildVolumeZMicrometers!: string;

  @ApiProperty({
    type: [Number],
    minItems: 1,
    uniqueItems: true,
    items: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
  })
  supportedNozzleMicrometers!: number[];

  @ApiProperty({
    type: [String],
    minItems: 1,
    uniqueItems: true,
    items: { type: "string", enum: [...MATERIALS] },
  })
  supportedMaterials!: string[];
}

export class RegisterMachineDto {
  @ApiProperty(UUID)
  machineCapabilityId!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 50,
    pattern: NON_BLANK_TEXT,
  })
  code!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 200,
    pattern: NON_BLANK_TEXT,
  })
  displayName!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  installedNozzleMicrometers!: number;
}

export class CreatePrintConfigRevisionDto {
  @ApiProperty({ type: String, enum: PRINT_QUALITIES })
  quality!: string;

  @ApiProperty({ type: "integer", minimum: 0, maximum: 100 })
  infillPercent!: number;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  layerHeightMicrometers!: number;

  @ApiProperty({ type: Boolean })
  supportsEnabled!: boolean;

  @ApiProperty({ type: Boolean })
  brimEnabled!: boolean;

  @ApiProperty(SETTINGS)
  settings!: Record<string, unknown>;
}

export class PriceRationalDto {
  @ApiProperty(NON_NEGATIVE_INTEGER)
  numerator!: string;

  @ApiProperty(POSITIVE_INTEGER)
  denominator!: string;
}

export class PriceMaterialRatesDto {
  @ApiProperty({ type: () => PriceRationalDto })
  PLA!: PriceRationalDto;

  @ApiProperty({ type: () => PriceRationalDto })
  PETG!: PriceRationalDto;
}

export class PriceInfillRatiosDto {
  @ApiProperty({ type: () => PriceRationalDto })
  DECORATIVE!: PriceRationalDto;

  @ApiProperty({ type: () => PriceRationalDto })
  STANDARD!: PriceRationalDto;

  @ApiProperty({ type: () => PriceRationalDto })
  STRONG!: PriceRationalDto;
}

export class PriceShipmentCategoryDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  id!: string;

  @ApiProperty(POSITIVE_INTEGER)
  maxXMicrometers!: string;

  @ApiProperty(POSITIVE_INTEGER)
  maxYMicrometers!: string;

  @ApiProperty(POSITIVE_INTEGER)
  maxZMicrometers!: string;

  @ApiProperty(POSITIVE_INTEGER)
  maxDimensionSumMicrometers!: string;

  @ApiProperty(POSITIVE_INTEGER)
  maxWeightMilligrams!: string;

  @ApiProperty(POSITIVE_INTEGER)
  maxParcelVolumeCubicMicrometers!: string;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  carrierCostMinor!: string;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  customerShippingRateMinor!: string;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  packagingCostMinor!: string;
}

export class SellerTaxPolicyDto {
  @ApiProperty({ type: String, enum: ["NON_VAT_PAYER", "VAT_PAYER"] })
  regime!: string;

  @ApiProperty({ type: "integer", minimum: 0, maximum: 10_000 })
  vatRateBasisPoints!: number;
}

export class AutomaticQuoteParametersDto {
  @ApiProperty({ type: () => PriceRationalDto })
  machineRateMinorPerSecond!: PriceRationalDto;
  @ApiProperty({ type: () => PriceRationalDto })
  laborRateMinorPerSecond!: PriceRationalDto;
  @ApiProperty({ type: () => PriceRationalDto })
  amortizationRateMinorPerSecond!: PriceRationalDto;
  @ApiProperty({ type: () => PriceRationalDto }) reprintRate!: PriceRationalDto;
  @ApiProperty({ type: () => PriceRationalDto }) marginRate!: PriceRationalDto;
  @ApiProperty({ type: () => PriceMaterialRatesDto })
  materialRateMinorPerMilligram!: PriceMaterialRatesDto;
  @ApiProperty({ type: () => PriceMaterialRatesDto })
  roughMaterialDensityMilligramsPerCubicMillimeter!: PriceMaterialRatesDto;
  @ApiProperty({ type: () => PriceInfillRatiosDto })
  roughMaterialVolumeRatioByInfillPreset!: PriceInfillRatiosDto;
  @ApiProperty({ type: () => PriceRationalDto })
  roughExtrusionMilligramsPerSecond!: PriceRationalDto;
  @ApiProperty(NON_NEGATIVE_INTEGER) handlingOrderFixedSeconds!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) handlingPlateSeconds!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) handlingPieceSeconds!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) handlingPackSeconds!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) shippingTripSeconds!: string;
  @ApiProperty(POSITIVE_INTEGER) shippingTripPricingDivisor!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) minimumPrintPriceMinor!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER)
  smallOrderWeightThresholdMilligrams!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) smallOrderSurchargeMinor!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) freeShippingPrintThresholdMinor!: string;
  @ApiProperty({ type: () => PriceRationalDto })
  expressMultiplier!: PriceRationalDto;
  @ApiProperty({ type: String, enum: ["1", "2"] })
  expressMaximumPlateCount!: string;
  @ApiProperty(POSITIVE_INTEGER)
  expressAvailableProductionWindowSeconds!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) expressPackagingBufferSeconds!: string;
  @ApiProperty(POSITIVE_INTEGER) maximumAutomaticQuantity!: string;
  @ApiProperty(POSITIVE_INTEGER) maximumAutomaticAmountMinor!: string;
  @ApiProperty(NON_NEGATIVE_INTEGER) packingPaddingMicrometers!: string;
  @ApiProperty({ type: () => PriceRationalDto })
  fillCoefficient!: PriceRationalDto;
  @ApiProperty(NON_NEGATIVE_INTEGER) packagingWeightMilligrams!: string;
  @ApiProperty({ type: "integer", minimum: 0, maximum: 10_000 })
  paymentFeeRateBasisPoints!: number;
  @ApiProperty(NON_NEGATIVE_INTEGER) paymentFeeFixedMinor!: string;
  @ApiProperty({ type: Object, additionalProperties: true })
  paymentProviderConfig!: Record<string, unknown>;
  @ApiProperty({ type: [PriceShipmentCategoryDto], minItems: 1 })
  shipmentCategories!: PriceShipmentCategoryDto[];
}

export class PriceListParametersDto {
  @ApiProperty({ type: () => SellerTaxPolicyDto })
  sellerTaxPolicy!: SellerTaxPolicyDto;

  @ApiProperty({ type: () => AutomaticQuoteParametersDto })
  automaticQuote!: AutomaticQuoteParametersDto;
}

export class CreatePriceListDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  revision!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  termsRevision!: string;

  @ApiProperty({ type: String, enum: ["CZK"] })
  currency!: string;

  @ApiProperty({ type: () => PriceListParametersDto })
  parameters!: PriceListParametersDto;
}

export class CreateMachineCalibrationDto {
  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  flowRatioPartsPerMillion!: number;

  @ApiProperty({
    type: "integer",
    minimum: -2_147_483_648,
    maximum: 2_147_483_647,
  })
  xyCompensationMicrometers!: number;

  @ApiProperty({
    type: "integer",
    minimum: -2_147_483_648,
    maximum: 2_147_483_647,
  })
  elephantFootCompensationMicrometers!: number;

  @ApiProperty(SETTINGS)
  settings!: Record<string, unknown>;
}

export class CreateInventoryDto {
  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  sku!: string;

  @ApiProperty({ type: String, enum: MATERIALS })
  material!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 200,
    pattern: NON_BLANK_TEXT,
  })
  vendor!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  color?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 100,
    pattern: NON_BLANK_TEXT,
  })
  lotCode?: string | null;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  priceMinorUnitsNumerator!: string;

  @ApiProperty(POSITIVE_INTEGER)
  priceMinorUnitsDenominator!: string;

  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 3,
    pattern: "^[A-Z]{3}$",
  })
  currency!: string;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  remainingMilligrams!: string;
}

export class ReceiveInventoryDto extends CreateInventoryDto {
  @ApiProperty({ type: String, format: "date-time" })
  purchasedAt!: string;
}

export class RecordInitialInventoryReceiptDto extends CatalogReasonDto {
  @ApiProperty(POSITIVE_INTEGER)
  receivedMilligrams!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 200,
    pattern: NON_BLANK_TEXT,
  })
  vendor!: string;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  priceMinorUnitsNumerator!: string;

  @ApiProperty(POSITIVE_INTEGER)
  priceMinorUnitsDenominator!: string;

  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 3,
    pattern: "^[A-Z]{3}$",
  })
  currency!: string;

  @ApiProperty({ type: String, format: "date-time" })
  purchasedAt!: string;
}

export class CorrectInventoryReceiptDto extends CatalogReasonDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 500,
    pattern: NON_BLANK_TEXT,
  })
  declare reason: string;

  @ApiProperty(UUID)
  supersedesReceiptId!: string;

  @ApiProperty(POSITIVE_INTEGER)
  receivedMilligrams!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 200,
    pattern: NON_BLANK_TEXT,
  })
  vendor!: string;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  priceMinorUnitsNumerator!: string;

  @ApiProperty(POSITIVE_INTEGER)
  priceMinorUnitsDenominator!: string;

  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 3,
    pattern: "^[A-Z]{3}$",
  })
  currency!: string;

  @ApiProperty({ type: String, format: "date-time" })
  purchasedAt!: string;
}

export class InventoryMountDto extends CatalogReasonDto {
  @ApiProperty({ type: String, enum: ["MOUNTED", "UNMOUNTED"] })
  mountStatus!: "MOUNTED" | "UNMOUNTED";
}

export class MachineAvailabilityWindowDto {
  @ApiProperty({ type: String, format: "date-time" })
  startsAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  endsAt!: string;
}

export class ReplaceMachineAvailabilityDto extends CatalogReasonDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 500,
    pattern: NON_BLANK_TEXT,
  })
  declare reason: string;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: 2_147_483_646,
    nullable: true,
  })
  expectedVersion!: number | null;

  @ApiProperty({ type: [MachineAvailabilityWindowDto], maxItems: 1000 })
  windows!: MachineAvailabilityWindowDto[];
}

export class MachineStatusDto extends CatalogReasonDto {
  @ApiProperty({ type: String, enum: MACHINE_STATUSES })
  status!: string;
}

export class InventoryStatusDto extends CatalogReasonDto {
  @ApiProperty({ type: String, enum: INVENTORY_STATUSES })
  status!: string;
}

export class InventoryAdjustmentDto extends CatalogReasonDto {
  @ApiProperty(NON_ZERO_INTEGER)
  deltaMilligrams!: string;
}
