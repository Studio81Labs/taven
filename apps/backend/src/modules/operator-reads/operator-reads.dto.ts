import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { FulfilmentProjectionDto } from "../orders/orders.dto";
import { ReferenceProfileActivationNoticeDto } from "../resources/reference-profile-activation-notice.dto";
import { PriceListParametersDto } from "../resources/operator-catalog.dto";

const UUID = { type: String, format: "uuid" } as const;
const DECIMAL = { type: String, pattern: "^-?[0-9]+$" } as const;

export class OperatorOrderListItemDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  publicReference!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  confirmedAt!: string | null;
}

export class OperatorOrderPageDto {
  @ApiProperty({ type: [OperatorOrderListItemDto] })
  items!: OperatorOrderListItemDto[];

  @ApiPropertyOptional({ type: String, minLength: 1 })
  nextCursor?: string;
}

export class OperatorJobListItemDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  replacesJobId!: string | null;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
}

export class OperatorJobPageDto {
  @ApiProperty({ type: [OperatorJobListItemDto] })
  items!: OperatorJobListItemDto[];

  @ApiPropertyOptional({ type: String, minLength: 1 })
  nextCursor?: string;
}

export class OperatorJobSlotDto {
  @ApiProperty(UUID)
  fulfilmentSlotId!: string;

  @ApiProperty(UUID)
  orderItemId!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  quantityOrdinal!: number;

  @ApiProperty(UUID)
  sourceModelFileId!: string;

  @ApiProperty(UUID)
  modelGeometryId!: string;

  @ApiProperty({ type: String })
  material!: string;

  @ApiProperty({ type: String, nullable: true })
  color!: string | null;

  @ApiProperty({ ...DECIMAL, description: "X bound in micrometers" })
  boundsXMicrometers!: string;

  @ApiProperty({ ...DECIMAL, description: "Y bound in micrometers" })
  boundsYMicrometers!: string;

  @ApiProperty({ ...DECIMAL, description: "Z bound in micrometers" })
  boundsZMicrometers!: string;

  @ApiProperty({
    ...DECIMAL,
    description: "Canonical volume in cubic micrometers",
  })
  volumeCubicMicrometers!: string;

  @ApiProperty({ type: String, pattern: "^[0-9a-f]{64}$" })
  geometrySha256!: string;

  @ApiProperty({ type: () => [OperatorJobAcceptedRiskDto] })
  acceptedRisks!: OperatorJobAcceptedRiskDto[];
}

export class OperatorJobAcceptedRiskDto {
  @ApiProperty(UUID)
  findingId!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  severity!: string;

  @ApiProperty({ type: String })
  message!: string;

  @ApiProperty({ type: String })
  acknowledgementKey!: string;
}

export class OperatorJobEstimateDto {
  @ApiProperty(UUID)
  candidateResourceEstimateId!: string;

  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty(UUID)
  printConfigRevisionId!: string;

  @ApiProperty(UUID)
  machineProfileId!: string;

  @ApiProperty(UUID)
  machineCalibrationId!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  quantity!: number;

  @ApiProperty({ type: Number, minimum: 1 })
  partsPerPlate!: number;

  @ApiProperty({ type: Number, minimum: 1 })
  plateCount!: number;

  @ApiProperty({ ...DECIMAL, description: "Estimated machine seconds" })
  requiredMachineSeconds!: string;

  @ApiProperty({ ...DECIMAL, description: "Estimated material in milligrams" })
  requiredMaterialMilligrams!: string;

  @ApiProperty({ type: String, format: "date-time" })
  calculatedAt!: string;

  @ApiProperty({ type: String, enum: ["CANDIDATE_RESOURCE_ESTIMATE"] })
  provenance!: "CANDIDATE_RESOURCE_ESTIMATE";
}

export class OperatorJobDeadlineDto {
  @ApiProperty({ type: String, format: "date", nullable: true })
  date!: string | null;

  @ApiProperty({
    type: String,
    enum: ["ACCEPTED_INDIVIDUAL_QUOTE", "NO_PROMISED_DATE"],
    nullable: true,
  })
  provenance!: "ACCEPTED_INDIVIDUAL_QUOTE" | "NO_PROMISED_DATE";
}

export class OperatorJobArtifactAvailabilityDto {
  @ApiProperty({ type: Boolean })
  available!: boolean;

  @ApiProperty({
    type: String,
    enum: [
      "NOT_GENERATED",
      "NOT_READY",
      "TERMINAL_JOB",
      "EXPIRED",
      "DELETED",
      "MISSING_BYTES",
      "INTEGRITY_MISMATCH",
    ],
    nullable: true,
  })
  reason!:
    | "NOT_GENERATED"
    | "NOT_READY"
    | "TERMINAL_JOB"
    | "EXPIRED"
    | "DELETED"
    | "MISSING_BYTES"
    | "INTEGRITY_MISMATCH"
    | null;
}

export class OperatorJobArtifactsDto {
  @ApiProperty({ type: OperatorJobArtifactAvailabilityDto })
  sourceModel!: OperatorJobArtifactAvailabilityDto;

  @ApiProperty({ type: OperatorJobArtifactAvailabilityDto })
  preview!: OperatorJobArtifactAvailabilityDto;

  @ApiProperty({ type: OperatorJobArtifactAvailabilityDto })
  production!: OperatorJobArtifactAvailabilityDto;
}

export class OperatorJobDetailDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  nodeId!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty({ type: String })
  orderReference!: string;

  @ApiProperty(UUID)
  orderPhaseId!: string;

  @ApiProperty(UUID)
  shipmentPlanId!: string;

  @ApiProperty({ ...UUID, nullable: true })
  shipmentId!: string | null;

  @ApiProperty({ type: Number, minimum: 0 })
  shipmentPlanOrdinal!: number;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ ...UUID, nullable: true })
  replacesJobId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  replacementJobId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  sourceReplacementRequestId!: string | null;

  @ApiProperty({ ...UUID, nullable: true })
  resultReplacementRequestId!: string | null;

  @ApiProperty({ type: [OperatorJobSlotDto] })
  slots!: OperatorJobSlotDto[];

  @ApiProperty({ type: OperatorJobEstimateDto })
  estimate!: OperatorJobEstimateDto;

  @ApiProperty({ type: OperatorJobDeadlineDto })
  deadline!: OperatorJobDeadlineDto;

  @ApiProperty({ type: OperatorJobArtifactsDto })
  artifacts!: OperatorJobArtifactsDto;
}

export class OperatorJobArtifactDownloadDto {
  @ApiProperty({ type: String, format: "uri" })
  downloadUrl!: string;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;

  @ApiProperty({ type: String })
  contentType!: string;

  @ApiProperty({ ...DECIMAL, description: "Object size in bytes" })
  contentLength!: string;

  @ApiProperty({ type: String, pattern: "^[0-9a-f]{64}$" })
  sha256!: string;
}

export class OperatorOrderItemDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  ordinal!: number;

  @ApiProperty(UUID)
  sourceModelFileId!: string;

  @ApiProperty(UUID)
  modelGeometryId!: string;

  @ApiProperty(UUID)
  printConfigRevisionId!: string;

  @ApiProperty({ type: String })
  material!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  color!: string | null;

  @ApiProperty({ type: Number, minimum: 1 })
  quantity!: number;

  @ApiPropertyOptional({ type: Number, minimum: 1, nullable: true })
  referencePartsPerPlate!: number | null;

  @ApiProperty({ type: () => OperatorReferenceSliceDto, nullable: true })
  primaryReferenceSlice!: OperatorReferenceSliceDto | null;

  @ApiProperty({ type: () => OperatorReferenceSliceDto, nullable: true })
  tailReferenceSlice!: OperatorReferenceSliceDto | null;

  @ApiProperty({ type: [String] })
  preflightFindings!: string[];
}

export class OperatorReferenceSliceDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  kind!: string;

  @ApiProperty(UUID)
  modelGeometryId!: string;

  @ApiProperty(UUID)
  printConfigRevisionId!: string;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  referenceProfileId!: string | null;

  @ApiPropertyOptional({ type: Number, minimum: 1, nullable: true })
  packageQuantity!: number | null;

  @ApiPropertyOptional({ type: Number, minimum: 1, nullable: true })
  packagePlateCount!: number | null;

  @ApiProperty({ type: Number, minimum: 1 })
  partsPerPlate!: number;

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  estimatedPrintSeconds!: string;

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  estimatedMaterialMilligrams!: string;

  @ApiProperty({ type: String })
  slicerEngine!: string;

  @ApiProperty({ type: String })
  slicerVersion!: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
}

export class OperatorAcceptedPriceDto {
  @ApiProperty(UUID)
  bindingId!: string;

  @ApiProperty(UUID)
  snapshotId!: string;

  @ApiProperty(DECIMAL)
  contractTotalMinor!: string;

  @ApiProperty(DECIMAL)
  netAmountMinor!: string;

  @ApiProperty(DECIMAL)
  vatAmountMinor!: string;

  @ApiProperty({ type: String })
  currency!: string;

  @ApiProperty({ type: String })
  priceListRevision!: string;

  @ApiProperty({ type: String })
  termsRevision!: string;
}

export class OperatorSettlementDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  kind!: string;

  @ApiProperty({ type: String })
  currency!: string;

  @ApiProperty(DECIMAL)
  contractTotalMinor!: string;

  @ApiProperty(DECIMAL)
  capturedTotalMinor!: string;

  @ApiProperty(DECIMAL)
  refundAmountMinor!: string;

  @ApiProperty(DECIMAL)
  amountDueMinor!: string;

  @ApiProperty(DECIMAL)
  refundableBalanceMinor!: string;

  @ApiProperty({ type: String, format: "date-time" })
  settledAt!: string;
}

export class OperatorRefundTransactionDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  claimId!: string | null;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  priceAdjustmentId!: string | null;

  @ApiProperty({ ...DECIMAL })
  amountMinor!: string;

  @ApiProperty({ type: String })
  reason!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: String, format: "date-time" })
  requestedAt!: string;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  completedAt!: string | null;
}

export class OperatorPaymentDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderPriceBindingId!: string;

  @ApiProperty(UUID)
  priceSnapshotId!: string;

  @ApiProperty({ type: String })
  role!: string;

  @ApiProperty({ type: String })
  provider!: string;

  @ApiProperty({ type: String })
  checkoutMethod!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  merchantReference!: string | null;

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  requestedAmountMinor!: string;

  @ApiPropertyOptional({ ...DECIMAL, nullable: true })
  capturedAmountMinor!: string | null;

  @ApiProperty({ type: String })
  currency!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: Boolean })
  captureAuthorized!: boolean;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  captureCutoffAt!: string | null;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  checkoutCaptureExpiresAt!: string | null;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  balanceDueAt!: string | null;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  capturedAt!: string | null;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: string;

  @ApiProperty({ type: [OperatorRefundTransactionDto] })
  refunds!: OperatorRefundTransactionDto[];
}

export class OperatorOrderTimelineEventDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  eventType!: string;

  @ApiProperty({ type: String })
  actorKind!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  reasonCode!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, format: "date-time" })
  occurredAt!: string;
}

export class OperatorFinancialProjectionDto {
  @ApiPropertyOptional({ ...UUID, nullable: true })
  activeContractRevisionId!: string | null;

  @ApiPropertyOptional({ ...DECIMAL, nullable: true })
  activeContractTotalMinor!: string | null;

  @ApiPropertyOptional({ ...DECIMAL, nullable: true })
  activeContractNetMinor!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  currency!: string | null;

  @ApiProperty({ type: [OperatorSettlementDto] })
  settlements!: OperatorSettlementDto[];

  @ApiProperty({ type: [OperatorPaymentDto] })
  payments!: OperatorPaymentDto[];
}

export class OperatorOrderDetailDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  publicReference!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  confirmedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  acceptedTermsRevision!: string | null;

  @ApiPropertyOptional({ type: OperatorAcceptedPriceDto, nullable: true })
  acceptedPrice!: OperatorAcceptedPriceDto | null;

  @ApiProperty({ type: [OperatorOrderItemDto] })
  items!: OperatorOrderItemDto[];

  @ApiProperty({ type: OperatorFinancialProjectionDto })
  financial!: OperatorFinancialProjectionDto;

  @ApiProperty({ type: FulfilmentProjectionDto })
  fulfilment!: FulfilmentProjectionDto;

  @ApiProperty({ type: [OperatorOrderTimelineEventDto] })
  timeline!: OperatorOrderTimelineEventDto[];
}

export class ReferenceProfileReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  digest!: string;

  @ApiProperty({ type: String })
  material!: string;

  @ApiProperty({ type: String })
  quality!: string;

  @ApiProperty({ type: String })
  slicerEngine!: string;

  @ApiProperty({ type: String })
  slicerVersion!: string;

  @ApiProperty({ type: String })
  state!: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
}

export class MachineProfileReadDto extends ReferenceProfileReadDto {
  @ApiProperty(UUID)
  machineCapabilityId!: string;

  @ApiProperty(UUID)
  referenceProfileId!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  nozzleDiameterMicrometers!: number;

  @ApiProperty({ type: String })
  productionArtifactFormat!: string;
}

export class PrintConfigRevisionReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  digest!: string;

  @ApiProperty({ type: String })
  quality!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  infillPercent!: number;

  @ApiProperty({ type: Number, minimum: 1 })
  layerHeightMicrometers!: number;

  @ApiProperty({ type: Boolean })
  supportsEnabled!: boolean;

  @ApiProperty({ type: Boolean })
  brimEnabled!: boolean;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
}

export class PriceListReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  revision!: string;

  @ApiProperty({ type: String })
  termsRevision!: string;

  @ApiProperty({ type: String })
  currency!: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
}

export class MachineCapabilityReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty({ type: String })
  capabilityKey!: string;

  @ApiProperty({ type: String })
  manufacturer!: string;

  @ApiProperty({ type: String })
  model!: string;

  @ApiProperty(DECIMAL)
  buildVolumeXMicrometers!: string;

  @ApiProperty(DECIMAL)
  buildVolumeYMicrometers!: string;

  @ApiProperty(DECIMAL)
  buildVolumeZMicrometers!: string;

  @ApiProperty({ type: [Number] })
  supportedNozzleMicrometers!: number[];

  @ApiProperty({ type: [String] })
  supportedMaterials!: string[];
}

export class MachineReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  nodeId!: string;

  @ApiProperty(UUID)
  machineCapabilityId!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  displayName!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  installedNozzleMicrometers!: number;
}

export class InventoryReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: String })
  sku!: string;

  @ApiProperty({ type: String })
  material!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  color!: string | null;

  @ApiProperty(DECIMAL)
  remainingMilligrams!: string;

  @ApiProperty(DECIMAL)
  reservedMilligrams!: string;

  @ApiProperty(DECIMAL)
  availableMilligrams!: string;

  @ApiProperty({ type: String })
  status!: string;
}

const CATALOG_JSON = { type: Object, additionalProperties: true } as const;

export class ReferenceProfileDetailDto extends ReferenceProfileReadDto {
  @ApiProperty(CATALOG_JSON)
  settings!: Record<string, unknown>;
}

export class MachineProfileDetailDto extends MachineProfileReadDto {
  @ApiProperty(CATALOG_JSON)
  settings!: Record<string, unknown>;
}

export class PrintConfigRevisionDetailDto extends PrintConfigRevisionReadDto {
  @ApiProperty(CATALOG_JSON)
  settings!: Record<string, unknown>;
}

export class PriceListDetailDto extends PriceListReadDto {
  @ApiProperty({ type: () => PriceListParametersDto })
  parameters!: PriceListParametersDto;
}

export class InventoryDetailDto extends InventoryReadDto {
  @ApiProperty(UUID)
  nodeId!: string;

  @ApiProperty({ type: String })
  vendor!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  lotCode!: string | null;

  @ApiProperty(DECIMAL)
  priceMinorUnitsNumerator!: string;

  @ApiProperty(DECIMAL)
  priceMinorUnitsDenominator!: string;

  @ApiProperty({ type: String })
  currency!: string;
}

export class MachineCalibrationReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: String })
  digest!: string;

  @ApiProperty({ type: String })
  state!: string;

  @ApiProperty({ type: Number })
  flowRatioPartsPerMillion!: number;

  @ApiProperty({ type: Number })
  xyCompensationMicrometers!: number;

  @ApiProperty({ type: Number })
  elephantFootCompensationMicrometers!: number;
}

export class CapacityReservationReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: String, format: "date-time" })
  startsAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  endsAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;
}

export class ReferenceProfilePageDto {
  @ApiProperty({ type: [ReferenceProfileReadDto] })
  items!: ReferenceProfileReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class ReferenceProfileActivationNoticePageDto {
  @ApiProperty({ type: [ReferenceProfileActivationNoticeDto] })
  items!: ReferenceProfileActivationNoticeDto[];

  @ApiPropertyOptional({ type: String, minLength: 1 })
  nextCursor?: string;
}

export class MachineProfilePageDto {
  @ApiProperty({ type: [MachineProfileReadDto] })
  items!: MachineProfileReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class PrintConfigRevisionPageDto {
  @ApiProperty({ type: [PrintConfigRevisionReadDto] })
  items!: PrintConfigRevisionReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class PriceListPageDto {
  @ApiProperty({ type: [PriceListReadDto] })
  items!: PriceListReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class MachineCapabilityPageDto {
  @ApiProperty({ type: [MachineCapabilityReadDto] })
  items!: MachineCapabilityReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class MachinePageDto {
  @ApiProperty({ type: [MachineReadDto] })
  items!: MachineReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class InventoryPageDto {
  @ApiProperty({ type: [InventoryReadDto] })
  items!: InventoryReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class MachineCalibrationPageDto {
  @ApiProperty({ type: [MachineCalibrationReadDto] })
  items!: MachineCalibrationReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class CapacityReservationPageDto {
  @ApiProperty({ type: [CapacityReservationReadDto] })
  items!: CapacityReservationReadDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}
