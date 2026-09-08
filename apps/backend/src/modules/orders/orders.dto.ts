import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;
const DATE_TIME = { type: String, format: "date-time" } as const;
const INTEGER_STRING = { type: String, pattern: "^[0-9]+$" } as const;

export class JobPrintedDto {
  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  actualMaterialMilligrams!: string;
}

export class CancellationPrintingConsumptionDto {
  @ApiProperty(UUID)
  jobId!: string;

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

  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;

  @ApiProperty({ type: String, enum: ["REPLACE", "REFUND"] })
  recovery!: "REPLACE" | "REFUND";

  @ApiPropertyOptional({ type: String, pattern: "^[0-9]+$" })
  actualMaterialMilligrams?: string;

  @ApiPropertyOptional({
    type: [CancellationPrintingConsumptionDto],
    description:
      "Exact material consumption for every other actively printing Job in the failed parcel",
  })
  printingConsumptions?: CancellationPrintingConsumptionDto[];
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

  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;
}

export class ExpireReplacementDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;

  @ApiPropertyOptional({
    type: [CancellationPrintingConsumptionDto],
    description:
      "Exact material consumption for every actively printing Job abandoned by the expired replacement request",
  })
  printingConsumptions?: CancellationPrintingConsumptionDto[];
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

  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;
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

  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;
}

export class ShipmentProviderEvidenceDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  providerEventId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  providerTransactionId!: string;

  @ApiProperty({ type: String, format: "date-time" })
  occurredAt!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;
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

  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  rationale!: string;

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

  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;

  @ApiProperty({ type: [String], format: "uuid", minItems: 1 })
  fulfilmentSlotIds!: string[];

  @ApiPropertyOptional(UUID)
  incidentShipmentId?: string;
}

export class ApproveLegacyClaimWindowDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  claimPolicyRevision!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 3650 })
  claimWindowDays!: number;

  @ApiProperty({ type: String, minLength: 1, maxLength: 500 })
  approvalReference!: string;
}

export class RejectClaimDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;
}

export class WithdrawClaimDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;
}

export class RefundDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
  reason!: string;
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

export class CancelOrderDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1_000 })
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

export class FulfilmentPhaseDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty({ type: String })
  kind!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  activatedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  qcPassedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  shippedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  deliveredAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  completedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;
}

export class FulfilmentJobShipmentAssignmentDto {
  @ApiProperty(UUID)
  jobId!: string;

  @ApiProperty(UUID)
  shipmentId!: string;

  @ApiProperty(UUID)
  shipmentPlanId!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty(DATE_TIME)
  assignedAt!: string;
}

export class FulfilmentReplacementRequestDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty(UUID)
  shipmentPlanId!: string;

  @ApiProperty(UUID)
  sourceJobId!: string;

  @ApiProperty({ ...UUID, nullable: true })
  replacementJobId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  phaseReservationSetId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  claimId!: string | null;

  @ApiProperty({ type: String })
  reason!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty(DATE_TIME)
  deadlineAt!: string;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  resolvedAt!: string | null;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;
}

export class FulfilmentJobDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  nodeId!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty(UUID)
  shipmentPlanId!: string;

  @ApiProperty(UUID)
  phaseResourcePlanJobId!: string;

  @ApiProperty({ ...UUID, nullable: true })
  replacesJobId!: string | null;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  acceptedAt!: string | null;

  @ApiProperty({ ...INTEGER_STRING, nullable: true })
  payoutAmount!: string | null;

  @ApiProperty({ type: String, nullable: true })
  payoutCurrency!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  gcodeReadyAt!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  productionSliceResultId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  productionArtifactHash!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  printingAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  printedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  photoSubmittedAt!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  qcPhotoAssetId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  qcEvidenceOmissionReason!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  qcApprovedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  qcRejectedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  packedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  handedOverAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  settledAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  failedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  failureStage!: string | null;

  @ApiProperty({ type: String, nullable: true })
  failureReason!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancellationReason!: string | null;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;

  @ApiProperty({ type: FulfilmentJobShipmentAssignmentDto, nullable: true })
  shipmentAssignment!: FulfilmentJobShipmentAssignmentDto | null;

  @ApiProperty({ type: FulfilmentReplacementRequestDto, nullable: true })
  replacementRequestSource!: FulfilmentReplacementRequestDto | null;
}

export class FulfilmentShipmentDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty(UUID)
  shipmentPlanId!: string;

  @ApiProperty(UUID)
  deliveryDestinationId!: string;

  @ApiProperty({ ...UUID, nullable: true })
  replacesShipmentId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  reprintClaimId!: string | null;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  carrier!: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerShipmentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  carrierLabelId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  trackingCode!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  labelCreatedAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  cancellationRequestedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerVoidId!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  providerVoidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerAcceptanceScanId!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  handedOverAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  deliveredAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;

  @ApiProperty({ type: [FulfilmentJobShipmentAssignmentDto] })
  jobAssignments!: FulfilmentJobShipmentAssignmentDto[];
}

export class FulfilmentSlotDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty(UUID)
  orderItemId!: string;

  @ApiProperty({ type: Number })
  quantityOrdinal!: number;

  @ApiProperty({ type: String })
  packingUnitKey!: string;

  @ApiProperty(INTEGER_STRING)
  settlementAmountMinor!: string;

  @ApiProperty({ type: String })
  outcome!: string;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  deliveredAt!: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  claimUntil!: string | null;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;
}

export class FulfilmentClaimSlotResolutionDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  claimId!: string;

  @ApiProperty(UUID)
  fulfilmentSlotId!: string;

  @ApiProperty({ ...UUID, nullable: true })
  replacementRequestId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  replacementShipmentId!: string | null;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  resolvedAt!: string | null;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;
}

export class FulfilmentRefundDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  paymentId!: string;

  @ApiProperty({ ...UUID, nullable: true })
  claimId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  priceAdjustmentId!: string | null;

  @ApiProperty({ type: String })
  provider!: string;

  @ApiProperty({ type: String, nullable: true })
  providerRefundId!: string | null;

  @ApiProperty(INTEGER_STRING)
  amountMinor!: string;

  @ApiProperty({ type: String })
  reason!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty(DATE_TIME)
  requestedAt!: string;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  completedAt!: string | null;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;
}

export class FulfilmentReshipmentAuthorizationDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty(UUID)
  shipmentPlanId!: string;

  @ApiProperty(UUID)
  deliveryDestinationId!: string;

  @ApiProperty(UUID)
  claimId!: string;

  @ApiProperty(UUID)
  originalShipmentId!: string;

  @ApiProperty(UUID)
  reshipmentShipmentId!: string;

  @ApiProperty(UUID)
  acceptanceEventId!: string;

  @ApiProperty(DATE_TIME)
  custodyConfirmedAt!: string;

  @ApiProperty(DATE_TIME)
  reQcPassedAt!: string;

  @ApiProperty({ type: String })
  reQcEvidence!: string;

  @ApiProperty(DATE_TIME)
  issuedAt!: string;

  @ApiProperty(DATE_TIME)
  consumedAt!: string;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;
}

export class FulfilmentClaimDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty({ ...UUID, nullable: true })
  incidentShipmentId!: string | null;

  @ApiProperty({ type: String })
  origin!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: String })
  reason!: string;

  @ApiProperty(DATE_TIME)
  openedAt!: string;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  resolvedAt!: string | null;

  @ApiProperty(DATE_TIME)
  createdAt!: string;

  @ApiProperty(DATE_TIME)
  updatedAt!: string;

  @ApiProperty({ type: [FulfilmentClaimSlotResolutionDto] })
  resolutions!: FulfilmentClaimSlotResolutionDto[];

  @ApiProperty({ type: [FulfilmentRefundDto] })
  refunds!: FulfilmentRefundDto[];

  @ApiProperty({ type: [FulfilmentReshipmentAuthorizationDto] })
  reshipmentAuthorizations!: FulfilmentReshipmentAuthorizationDto[];
}

export class FulfilmentPriceAdjustmentDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty({ ...UUID, nullable: true })
  paymentId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  claimId!: string | null;

  @ApiProperty(UUID)
  sourceContractPriceId!: string;

  @ApiProperty({ type: String })
  idempotencyKey!: string;

  @ApiProperty({ type: String })
  reason!: string;

  @ApiProperty(INTEGER_STRING)
  amountMinor!: string;

  @ApiProperty(INTEGER_STRING)
  refundRequiredMinor!: string;

  @ApiProperty({ type: String })
  currency!: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  allocation!: Record<string, unknown>;

  @ApiProperty(DATE_TIME)
  createdAt!: string;
}

export class FulfilmentProjectionDto {
  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty({ type: String })
  orderStatus!: string;

  @ApiProperty({ type: FulfilmentPhaseDto })
  phase!: FulfilmentPhaseDto;

  @ApiProperty({ type: [FulfilmentJobDto] })
  jobs!: FulfilmentJobDto[];

  @ApiProperty({ type: [FulfilmentShipmentDto] })
  shipments!: FulfilmentShipmentDto[];

  @ApiProperty({ type: [FulfilmentSlotDto] })
  slots!: FulfilmentSlotDto[];

  @ApiProperty({ type: [FulfilmentReplacementRequestDto] })
  replacementRequests!: FulfilmentReplacementRequestDto[];

  @ApiProperty({ type: [FulfilmentClaimDto] })
  claims!: FulfilmentClaimDto[];

  @ApiProperty({ type: [FulfilmentPriceAdjustmentDto] })
  priceAdjustments!: FulfilmentPriceAdjustmentDto[];
}
