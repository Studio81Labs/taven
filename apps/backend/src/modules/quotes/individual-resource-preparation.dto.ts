import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class PrepareIndividualOrderResourcesDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 2000, pattern: "\\S" })
  reason!: string;
}

export class IndividualResourcePreparationDto {
  @ApiProperty({ type: String, format: "uuid" })
  orderId!: string;

  @ApiProperty({ type: String, enum: ["PENDING", "READY"] })
  status!: "PENDING" | "READY";

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  phaseResourcePlanId!: string | null;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  planExpiresAt!: string | null;
}
