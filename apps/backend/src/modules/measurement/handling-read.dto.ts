import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;
const INSTANT = { type: String, format: "date-time" } as const;
const INTEGER = { type: String, pattern: "^[0-9]+$" } as const;

export class HandlingAllocationReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  orderId!: string;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  orderItemId!: string | null;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  orderPhaseId!: string | null;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  jobId!: string | null;

  @ApiPropertyOptional({ ...UUID, nullable: true })
  shipmentId!: string | null;

  @ApiProperty({ type: String })
  targetKey!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  servedUnitCount!: number;

  @ApiProperty(INTEGER)
  allocatedDurationMilliseconds!: string;

  @ApiProperty(INTEGER)
  allocatedCostMinor!: string;

  @ApiProperty({ type: String })
  currency!: string;
}

export class HandlingSessionReadDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiProperty(UUID)
  nodeId!: string;

  @ApiProperty(UUID)
  operatorIdentityId!: string;

  @ApiProperty({ type: String })
  component!: string;

  @ApiProperty({ type: String })
  source!: string;

  @ApiProperty({ type: String })
  lifecycle!: string;

  @ApiProperty(INSTANT)
  startedAt!: string;

  @ApiPropertyOptional({ ...INSTANT, nullable: true })
  endedAt!: string | null;

  @ApiPropertyOptional({ ...INTEGER, nullable: true })
  durationMilliseconds!: string | null;

  @ApiPropertyOptional({ ...INTEGER, nullable: true })
  totalCostMinor!: string | null;

  @ApiProperty(INTEGER)
  laborRateNumerator!: string;

  @ApiProperty(INTEGER)
  laborRateDenominator!: string;

  @ApiProperty({ type: String })
  laborRatePolicyVersion!: string;

  @ApiProperty({ type: String })
  currency!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  reason!: string | null;

  @ApiPropertyOptional({ ...INSTANT, nullable: true })
  completedAt!: string | null;

  @ApiPropertyOptional({ ...INSTANT, nullable: true })
  voidedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  voidReason!: string | null;

  @ApiProperty({ type: [HandlingAllocationReadDto] })
  allocations!: HandlingAllocationReadDto[];

  @ApiPropertyOptional(UUID)
  allocationsNextCursor?: string;
}

export class HandlingSessionPageDto {
  @ApiProperty({ type: [HandlingSessionReadDto] })
  items!: HandlingSessionReadDto[];

  @ApiPropertyOptional(UUID)
  nextCursor?: string;
}

export class HandlingAllocationPageDto {
  @ApiProperty({ type: [HandlingAllocationReadDto] })
  items!: HandlingAllocationReadDto[];

  @ApiPropertyOptional(UUID)
  nextCursor?: string;
}
