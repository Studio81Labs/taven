import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;

export class JobPrintedDto {
  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  actualMaterialMilligrams!: string;
}

export class JobQcSubmissionDto {
  @ApiPropertyOptional(UUID)
  photoAssetId?: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 500 })
  omissionReason?: string;
}

export class JobFailureDto {
  @ApiProperty({
    type: String,
    enum: [
      "PREPARATION",
      "GCODE",
      "MACHINE",
      "PRINTING",
      "POST_PRINT",
      "POST_QC",
      "PACKING",
    ],
  })
  stage!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 2_000 })
  reason!: string;

  @ApiProperty({ type: String, enum: ["REPLACE", "REFUND"] })
  recovery!: "REPLACE" | "REFUND";

  @ApiPropertyOptional({ type: String, pattern: "^[0-9]+$" })
  actualMaterialMilligrams?: string;
}

export class CreateReplacementDto {
  @ApiProperty({
    ...UUID,
    description:
      "Compatible candidate calculated after the source failure with future capacity",
  })
  candidateResourceEstimateId!: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 255,
    description:
      "Stable resource-plan identity; omitted values derive from the command key",
  })
  planKey?: string;
}

export class ClaimReprintJobDto {
  @ApiProperty(UUID)
  sourceJobId!: string;

  @ApiProperty({
    ...UUID,
    description:
      "Compatible candidate calculated after the parcel loss with future capacity",
  })
  candidateResourceEstimateId!: string;
}

export class CreateClaimReprintDto {
  @ApiProperty({ type: [ClaimReprintJobDto], minItems: 1 })
  replacements!: ClaimReprintJobDto[];

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 255,
    description:
      "Stable reprint identity; omitted values derive from the command key",
  })
  planKey?: string;
}

export class PackJobDto {
  @ApiProperty(UUID)
  shipmentId!: string;
}

export class CreateShipmentDto {
  @ApiProperty(UUID)
  shipmentPlanId!: string;

  @ApiPropertyOptional(UUID)
  replacesShipmentId?: string;
}

export class ShipmentLabelDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  carrier!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  providerShipmentId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 190 })
  carrierLabelId!: string;

  @ApiPropertyOptional({ type: String, maxLength: 255 })
  trackingCode?: string;
}

export class ShipmentProviderEvidenceDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  providerEventId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  providerTransactionId!: string;

  @ApiProperty({ type: String, format: "date-time" })
  occurredAt!: string;
}

export class ShipmentEventDto extends ShipmentProviderEvidenceDto {
  @ApiProperty({
    type: String,
    enum: ["TRANSIT_SCAN", "DELIVERY_SCAN", "LOST", "RETURNED", "RECOVERED"],
  })
  kind!: "TRANSIT_SCAN" | "DELIVERY_SCAN" | "LOST" | "RETURNED" | "RECOVERED";
}

export class PriceAdjustmentSlotCreditDto {
  @ApiProperty(UUID)
  fulfilmentSlotId!: string;

  @ApiProperty({ type: String, pattern: "^[1-9][0-9]*$" })
  amountMinor!: string;
}

export class PriceAdjustmentAllocationDto {
  @ApiPropertyOptional({
    type: [PriceAdjustmentSlotCreditDto],
    minItems: 1,
    description:
      "Exact per-slot credit allocation; required for non-express adjustments and derived from the immutable express component when omitted for express adjustments",
  })
  slotCredits?: PriceAdjustmentSlotCreditDto[];
}

export class CreatePriceAdjustmentDto {
  @ApiProperty({
    type: String,
    enum: [
      "EXPRESS_BREACH",
      "PRODUCTION_FAILURE",
      "SHIPMENT_INCIDENT",
      "POST_DELIVERY_ISSUE",
    ],
  })
  reason!: string;

  @ApiProperty({ type: String, pattern: "^[1-9][0-9]*$" })
  amountMinor!: string;

  @ApiPropertyOptional(UUID)
  paymentId?: string;

  @ApiPropertyOptional(UUID)
  claimId?: string;

  @ApiProperty({ type: PriceAdjustmentAllocationDto })
  allocation!: PriceAdjustmentAllocationDto & Record<string, unknown>;
}

export class CreateClaimDto {
  @ApiProperty({
    type: String,
    enum: ["SHIPMENT_INCIDENT", "POST_DELIVERY_QUALITY"],
  })
  origin!: "SHIPMENT_INCIDENT" | "POST_DELIVERY_QUALITY";

  @ApiProperty({ type: String, minLength: 1, maxLength: 2_000 })
  reason!: string;

  @ApiProperty({ type: [String], format: "uuid", minItems: 1 })
  fulfilmentSlotIds!: string[];

  @ApiPropertyOptional(UUID)
  incidentShipmentId?: string;
}

export class HandoffReshipmentDto extends ShipmentProviderEvidenceDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  carrier!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  providerShipmentId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 190 })
  carrierLabelId!: string;

  @ApiPropertyOptional({ type: String, maxLength: 255 })
  trackingCode?: string;

  @ApiProperty({ type: String, format: "date-time" })
  custodyConfirmedAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  reQcPassedAt!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 500 })
  reQcEvidence!: string;
}

export class CancellationPrintingConsumptionDto {
  @ApiProperty(UUID)
  jobId!: string;

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  actualMaterialMilligrams!: string;
}

export class CancelOrderDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 2_000 })
  reason!: string;

  @ApiPropertyOptional({
    type: [CancellationPrintingConsumptionDto],
    description:
      "Exact material consumption for every Job that is actively printing",
  })
  printingConsumptions?: CancellationPrintingConsumptionDto[];
}

export class FulfilmentCommandResultDto {
  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: Object })
  result!: Record<string, unknown>;
}

export class FulfilmentProjectionDto {
  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty({ type: String })
  orderStatus!: string;

  @ApiProperty({ type: Object })
  phase!: Record<string, unknown>;

  @ApiProperty({ type: [Object] })
  jobs!: Array<Record<string, unknown>>;

  @ApiProperty({ type: [Object] })
  shipments!: Array<Record<string, unknown>>;

  @ApiProperty({ type: [Object] })
  slots!: Array<Record<string, unknown>>;

  @ApiProperty({ type: [Object] })
  replacementRequests!: Array<Record<string, unknown>>;

  @ApiProperty({ type: [Object] })
  claims!: Array<Record<string, unknown>>;

  @ApiProperty({ type: [Object] })
  priceAdjustments!: Array<Record<string, unknown>>;
}
