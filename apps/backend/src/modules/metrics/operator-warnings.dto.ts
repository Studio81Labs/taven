import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export const WARNING_CODES = [
  "REFUND_UNRESOLVED",
  "CAPTURE_COMPENSATION_DUE",
  "EMAIL_OUTBOX_DUE",
  "EMAIL_OUTBOX_FAILED",
  "RETENTION_DUE",
  "RETENTION_FAILED",
  "PROFILE_UNAVAILABLE",
  "INVENTORY_UNAVAILABLE",
  "RESERVATION_CONFLICT",
  "REFERENCE_PROFILE_ACTIVATED",
  "MATERIAL_RATE_BELOW_PURCHASE",
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export class WarningEvidenceDto {
  @ApiPropertyOptional({ type: String }) material?: string;
  @ApiPropertyOptional({ type: String }) machineId?: string;
  @ApiPropertyOptional({ type: String }) inventoryId?: string;
  @ApiPropertyOptional({ type: String }) conflictReservationId?: string;
  @ApiPropertyOptional({ type: String }) candidateIntervalId?: string;
  @ApiPropertyOptional({ type: String }) remainingMilligrams?: string;
  @ApiPropertyOptional({ type: String }) reservedMilligrams?: string;
  @ApiPropertyOptional({ type: String }) uncompensatedMinor?: string;
  @ApiPropertyOptional({ type: String }) amountMinor?: string;
  @ApiPropertyOptional({ type: String }) currency?: string;
  @ApiPropertyOptional({ type: String }) purchaseRateNumerator?: string;
  @ApiPropertyOptional({ type: String }) purchaseRateDenominator?: string;
  @ApiPropertyOptional({ type: String }) selectedRateNumerator?: string;
  @ApiPropertyOptional({ type: String }) selectedRateDenominator?: string;
  @ApiPropertyOptional({ type: String }) rateDifferenceNumerator?: string;
  @ApiPropertyOptional({ type: String }) rateDifferenceDenominator?: string;
}

export class OperatorWarningDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ enum: WARNING_CODES }) code!: WarningCode;
  @ApiProperty({ enum: ["PLATFORM", "NODE"] }) scope!: "PLATFORM" | "NODE";
  @ApiProperty({ type: String }) sourceType!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiPropertyOptional({ type: String, format: "uuid" }) nodeId?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" }) orderId?: string;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: String, format: "date-time" }) observedAt!: string;
  @ApiPropertyOptional({ type: String, format: "date-time" }) dueAt?: string;
  @ApiProperty({ type: WarningEvidenceDto }) evidence!: WarningEvidenceDto;
}

export class WarningCoverageDto {
  @ApiProperty({ type: Boolean })
  sourceScanLimited!: boolean;

  @ApiProperty({ enum: ["unavailable"] })
  emailDeliveryAttempts!: "unavailable";

  @ApiProperty({ enum: ["unavailable"] })
  reservationConflictHistory!: "unavailable";

  @ApiProperty({ enum: ["available", "unavailable"] })
  selectedMaterialRate!: "available" | "unavailable";

  @ApiProperty({ type: Number, minimum: 0 })
  inventoryLotsWithoutReceipt!: number;
}

export class OperatorWarningsReportDto {
  @ApiProperty({ type: String, format: "date-time" }) generatedAt!: string;
  @ApiProperty({ type: String, format: "uuid" }) nodeId!: string;
  @ApiProperty({ type: [OperatorWarningDto] }) items!: OperatorWarningDto[];
  @ApiProperty({ type: Boolean }) truncated!: boolean;
  @ApiProperty({ type: WarningCoverageDto }) coverage!: WarningCoverageDto;
}
