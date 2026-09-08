import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export type MetricMoney = Readonly<{
  amountMinor: string;
  currency: string;
}>;

export type MetricRatio = Readonly<{
  numerator: number;
  denominator: number;
  value: number | null;
}>;

export type MetricsInterval = Readonly<{
  from: string;
  to: string;
  currency: string;
  channel?: string;
  nodeId: string;
}>;

export type MetricsCompleteness = Readonly<{
  status: "complete" | "warning" | "unknown";
  flags: readonly string[];
}>;

/**
 * v0-1 reports intentionally expose aggregates only. The metric sections are
 * documented in their `definition` field so clients can render a report
 * without reconstructing business semantics from the values alone.
 */
export class MetricsReportDto {
  @ApiProperty({ type: String, enum: ["v0-1"] })
  metricDefinition!: "v0-1";

  @ApiProperty({ type: String, format: "date-time" })
  generatedAt!: string;

  @ApiProperty({ type: "object", additionalProperties: true })
  interval!: MetricsInterval;

  @ApiProperty({ type: "object", additionalProperties: true })
  sourceCoverage!: Record<string, unknown>;

  @ApiProperty({ type: "object", additionalProperties: true })
  completeness!: MetricsCompleteness;

  @ApiProperty({ type: "object", additionalProperties: true })
  commercial!: Record<string, unknown>;

  @ApiProperty({ type: "object", additionalProperties: true })
  operational!: Record<string, unknown>;
}

export class MetricsOrderPageDto {
  @ApiProperty({ type: String, enum: ["v0-1"] })
  metricDefinition!: "v0-1";

  @ApiProperty({ type: String, format: "date-time" })
  generatedAt!: string;

  @ApiProperty({ type: "object", additionalProperties: true })
  interval!: MetricsInterval;

  @ApiProperty({ type: "object", additionalProperties: true })
  sourceCoverage!: Record<string, unknown>;

  @ApiProperty({ type: "object", additionalProperties: true })
  completeness!: MetricsCompleteness;

  @ApiProperty({ type: String, enum: ["OPERATIONAL_NODE"] })
  scope!: "OPERATIONAL_NODE";

  @ApiProperty({ type: String, format: "uuid" })
  nodeId!: string;

  @ApiProperty({
    type: "array",
    items: { type: "object", additionalProperties: true },
  })
  items!: readonly Record<string, unknown>[];

  @ApiPropertyOptional({ type: String, minLength: 1 })
  nextCursor?: string;
}
