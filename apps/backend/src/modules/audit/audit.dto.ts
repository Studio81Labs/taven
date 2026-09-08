import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class AuditEventSummaryDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String })
  eventType!: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  operatorIdentityId?: string;

  @ApiPropertyOptional({ type: Boolean })
  legacy?: boolean;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  nodeId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  orderId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  paymentId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  refundTransactionId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  quoteRequestId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  quoteId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  correlationId?: string;

  @ApiPropertyOptional({ type: String })
  reasonCode?: string;

  @ApiPropertyOptional({ type: String })
  reason?: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  payload!: Record<string, boolean | number | string>;
}

export class AuditEventPageDto {
  @ApiProperty({ type: [AuditEventSummaryDto] })
  items!: AuditEventSummaryDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}
