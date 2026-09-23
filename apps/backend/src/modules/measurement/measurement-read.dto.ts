import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;

export class ActualCostEvidenceDto {
  @ApiProperty(UUID) id!: string;
  @ApiProperty(UUID) orderId!: string;
  @ApiProperty({ type: String }) category!: string;
  @ApiProperty({ type: String, pattern: "^[0-9]+$" }) amountMinor!: string;
  @ApiProperty({ type: String }) currency!: string;
  @ApiProperty({ type: String, format: "date-time" }) occurredAt!: string;
  @ApiProperty({ type: String }) source!: string;
  @ApiProperty({ type: String }) sourceKey!: string;
  @ApiProperty({ type: String }) sourceEntityType!: string;
  @ApiProperty({ ...UUID, nullable: true }) sourceEntityId!: string | null;
  @ApiProperty({ ...UUID, nullable: true }) supersedesId!: string | null;
  @ApiProperty({ ...UUID, nullable: true }) successorId!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) recordedAt!: string;
  @ApiProperty({ type: Boolean }) isCurrent!: boolean;
}

export class ActualCostEvidencePageDto {
  @ApiProperty(UUID) orderId!: string;
  @ApiProperty({ type: [ActualCostEvidenceDto] })
  items!: ActualCostEvidenceDto[];
  @ApiPropertyOptional(UUID) nextCursor?: string;
}

export class AcquisitionSpendEvidenceDto {
  @ApiProperty(UUID) id!: string;
  @ApiProperty({ type: String }) channel!: string;
  @ApiProperty({ type: String, format: "date-time" }) periodStart!: string;
  @ApiProperty({ type: String, format: "date-time" }) periodEnd!: string;
  @ApiProperty({ type: String, pattern: "^[0-9]+$" }) amountMinor!: string;
  @ApiProperty({ type: String }) currency!: string;
  @ApiProperty({ type: String }) sourceKey!: string;
  @ApiProperty({ type: String }) sourceEntityType!: string;
  @ApiProperty({ ...UUID, nullable: true }) supersedesId!: string | null;
  @ApiProperty({ ...UUID, nullable: true }) successorId!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) recordedAt!: string;
  @ApiProperty({ type: Boolean }) isCurrent!: boolean;
}

export class AcquisitionSpendEvidencePageDto {
  @ApiProperty({ enum: ["PLATFORM"] }) scope!: "PLATFORM";
  @ApiProperty({ type: [AcquisitionSpendEvidenceDto] })
  items!: AcquisitionSpendEvidenceDto[];
  @ApiPropertyOptional(UUID) nextCursor?: string;
}
