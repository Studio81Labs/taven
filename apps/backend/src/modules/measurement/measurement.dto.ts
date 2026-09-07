import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;

export class HandlingAllocationInputDto {
  @ApiProperty(UUID)
  orderId!: string;

  @ApiPropertyOptional(UUID)
  orderItemId?: string;

  @ApiPropertyOptional({
    ...UUID,
    description: "Required for POSTPROCESSING_ITEM; forbidden otherwise.",
  })
  orderPhaseId?: string;

  @ApiPropertyOptional(UUID)
  jobId?: string;

  @ApiPropertyOptional(UUID)
  shipmentId?: string;

  @ApiProperty({ type: String, pattern: "^[1-9][0-9]*$" })
  servedUnitCount!: string;
}

export class StartHandlingSessionDto {
  @ApiProperty({
    enum: [
      "HANDLING_ORDER_FIX",
      "HANDLING_PLATE",
      "HANDLING_PIECE",
      "HANDLING_PACK",
      "SHIPPING_TRIP",
      "POSTPROCESSING_ITEM",
    ],
  })
  component!: string;
}

export class CompleteHandlingSessionDto {
  @ApiProperty({ type: [HandlingAllocationInputDto], minItems: 1 })
  allocations!: HandlingAllocationInputDto[];
}

export class RecordManualHandlingSessionDto extends StartHandlingSessionDto {
  @ApiProperty({ type: String, format: "date-time" })
  startedAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  endedAt!: string;

  @ApiProperty({ type: String, pattern: "^[1-9][0-9]*$" })
  durationMilliseconds!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1000 })
  reason!: string;

  @ApiProperty({ type: [HandlingAllocationInputDto], minItems: 1 })
  allocations!: HandlingAllocationInputDto[];
}

export class VoidHandlingSessionDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1000 })
  reason!: string;
}

export class RecordActualCostDto {
  @ApiProperty({
    enum: [
      "MATERIAL",
      "VARIABLE_MACHINE",
      "CARRIER",
      "PACKAGING",
      "PAYMENT_FEE",
    ],
  })
  category!: string;

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  amountMinor!: string;

  @ApiProperty({ type: String, pattern: "^[A-Z]{3}$" })
  currency!: string;

  @ApiProperty({ type: String, format: "date-time" })
  occurredAt!: string;

  @ApiProperty({ enum: ["MEASURED", "MANUAL"] })
  source!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  sourceKey!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  sourceEntityType!: string;

  @ApiPropertyOptional(UUID)
  sourceEntityId?: string;

  @ApiPropertyOptional(UUID)
  supersedesId?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 1000,
    description: "Required when source is MANUAL or supersedesId is supplied.",
  })
  reason?: string;
}

export class RecordAcquisitionSpendDto {
  @ApiProperty({ enum: ["DIRECT", "ORGANIC", "PAID", "REFERRAL", "UNKNOWN"] })
  channel!: string;

  @ApiProperty({ type: String, format: "date-time" })
  periodStart!: string;

  @ApiProperty({ type: String, format: "date-time" })
  periodEnd!: string;

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  amountMinor!: string;

  @ApiProperty({ type: String, pattern: "^[A-Z]{3}$" })
  currency!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  sourceKey!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  sourceEntityType!: string;

  @ApiPropertyOptional(UUID)
  supersedesId?: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 1000 })
  reason?: string;
}

export class MeasurementCommandResultDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String })
  status!: string;
}
