import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;
const INSTANT = { type: String, format: "date-time" } as const;

export class PrepareJobReplacementDto {
  @ApiProperty(UUID)
  expectedReplacementRequestId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1000, pattern: "\\S" })
  reason!: string;
}

export class PrepareClaimReprintDto {
  @ApiProperty(UUID)
  expectedPredecessorShipmentId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1000, pattern: "\\S" })
  reason!: string;
}

export class RecoveryCandidatePreparationAcceptedDto {
  @ApiProperty(UUID)
  preparationId!: string;

  @ApiProperty({ enum: ["JOB_REPLACEMENT", "LOST_CLAIM_REPRINT"] })
  kind!: "JOB_REPLACEMENT" | "LOST_CLAIM_REPRINT";

  @ApiProperty(UUID)
  orderId!: string;

  @ApiProperty(UUID)
  targetId!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  generation!: number;

  @ApiProperty(INSTANT)
  requestedAt!: string;

  @ApiProperty({ type: String })
  statusPath!: string;
}

export class RecoveryCandidateSourceProgressDto {
  @ApiProperty(UUID)
  sourceJobId!: string;

  @ApiProperty({ type: [String], format: "uuid" })
  fulfilmentSlotIds!: string[];

  @ApiProperty({ type: Number, minimum: 1 })
  quantity!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  pendingCount!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  failedCount!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  selectableCount!: number;

  @ApiProperty({ type: [String] })
  blockingCodes!: string[];
}

export class RecoveryCandidatePreparationDetailDto extends RecoveryCandidatePreparationAcceptedDto {
  @ApiPropertyOptional({ ...UUID, nullable: true })
  replacementRequestId!: string | null;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  claimId!: string | null;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  predecessorShipmentId!: string | null;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  incidentEvidenceId!: string | null;

  @ApiProperty({ type: [String], format: "uuid" })
  sourceJobIds!: string[];

  @ApiProperty({
    enum: [
      "PREPARING",
      "CANDIDATES_AVAILABLE",
      "BLOCKED",
      "EXPIRED",
      "SUPERSEDED",
    ],
  })
  status!:
    "PREPARING" | "CANDIDATES_AVAILABLE" | "BLOCKED" | "EXPIRED" | "SUPERSEDED";

  @ApiProperty({ type: [RecoveryCandidateSourceProgressDto] })
  sources!: RecoveryCandidateSourceProgressDto[];

  @ApiProperty({ type: Number, minimum: 0 })
  dispatchCount!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  pendingCount!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  failedCount!: number;

  @ApiProperty({ type: [String] })
  blockingCodes!: string[];

  @ApiPropertyOptional({ ...INSTANT, nullable: true })
  nextRefreshAt!: string | null;
}

export class RecoveryCandidateIntervalDto {
  @ApiProperty(INSTANT)
  startsAt!: string;

  @ApiProperty(INSTANT)
  endsAt!: string;
}

export class RecoveryCandidateChoiceDto {
  @ApiProperty(UUID)
  candidateResourceEstimateId!: string;

  @ApiProperty(UUID)
  sourceJobId!: string;

  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty(UUID)
  machineProfileId!: string;

  @ApiProperty(UUID)
  machineCalibrationId!: string;

  @ApiProperty(UUID)
  inventoryId!: string;

  @ApiProperty(UUID)
  printConfigRevisionId!: string;

  @ApiProperty({ type: String })
  material!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  color!: string | null;

  @ApiProperty({ type: Number, minimum: 1 })
  quantity!: number;

  @ApiProperty({ type: Number, minimum: 1 })
  partsPerPlate!: number;

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  requiredMaterialMilligrams!: string;

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  requiredMachineSeconds!: string;

  @ApiProperty({ type: [RecoveryCandidateIntervalDto] })
  intervals!: RecoveryCandidateIntervalDto[];

  @ApiProperty(INSTANT)
  calculatedAt!: string;

  @ApiProperty(INSTANT)
  expiresAt!: string;

  @ApiProperty({ type: Boolean })
  selectable!: boolean;

  @ApiProperty({ type: [String] })
  blockingCodes!: string[];
}

export class RecoveryCandidatePreparationPageDto {
  @ApiProperty({ type: [RecoveryCandidatePreparationDetailDto] })
  items!: RecoveryCandidatePreparationDetailDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class RecoveryCandidateChoicePageDto {
  @ApiProperty({ type: [RecoveryCandidateChoiceDto] })
  items!: RecoveryCandidateChoiceDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}
