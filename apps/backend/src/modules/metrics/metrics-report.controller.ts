import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentOperator } from "../admin-access/current-operator.decorator";
import { OperatorAccessGuard } from "../admin-access/operator-access.guard";
import { OPERATOR_CSRF_HEADER } from "../admin-access/operator-auth.openapi";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { RequireOperatorPermissions } from "../admin-access/require-operator-permissions.decorator";
import { MetricsOrderPageDto, MetricsReportDto } from "./metrics-report.dto";
import {
  MetricsReportService,
  parseMetricsQuery,
} from "./metrics-report.service";

const SUMMARY_FIELDS = new Set(["from", "to", "channel", "currency", "nodeId"]);
const ORDER_FIELDS = new Set([...SUMMARY_FIELDS, "cursor", "limit"]);

@ApiTags("operator metrics")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.METRICS_READ)
@Controller()
export class MetricsReportController {
  constructor(private readonly metrics: MetricsReportService) {}

  @Get("admin/metrics")
  @ApiOperation({
    summary: "Read v0-1 commercial and operational business metrics",
    description:
      "Uses one read-only repeatable-read database snapshot. Commercial sections are platform aggregates; operational sections are limited to one granted node.",
  })
  @ApiOkResponse({ type: MetricsReportDto })
  @ApiQuery({ name: "from", required: true, type: String, format: "date-time" })
  @ApiQuery({ name: "to", required: true, type: String, format: "date-time" })
  @ApiQuery({
    name: "channel",
    required: false,
    enum: ["direct", "organic", "paid", "referral", "unknown"],
  })
  @ApiQuery({ name: "currency", required: false, enum: ["CZK"] })
  @ApiQuery({ name: "nodeId", required: false, type: String, format: "uuid" })
  report(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<MetricsReportDto> {
    return this.metrics.report(
      operator,
      parseMetricsQuery(
        normalizeQuery(query, SUMMARY_FIELDS),
        operator.nodeIds,
      ),
    );
  }

  @Get("admin/metrics/orders")
  @ApiOperation({
    summary: "Read node-scoped order metric details",
    description:
      "Every item is proven to have exactly the requested operational node scope. The opaque cursor is bound to the complete filter set.",
  })
  @ApiOkResponse({ type: MetricsOrderPageDto })
  @ApiQuery({ name: "from", required: true, type: String, format: "date-time" })
  @ApiQuery({ name: "to", required: true, type: String, format: "date-time" })
  @ApiQuery({
    name: "channel",
    required: false,
    enum: ["direct", "organic", "paid", "referral", "unknown"],
  })
  @ApiQuery({ name: "currency", required: false, enum: ["CZK"] })
  @ApiQuery({ name: "nodeId", required: false, type: String, format: "uuid" })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  orders(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<MetricsOrderPageDto> {
    const normalized = normalizeQuery(query, ORDER_FIELDS);
    const limit =
      normalized.limit === undefined ? undefined : Number(normalized.limit);
    if (normalized.limit !== undefined && !Number.isSafeInteger(limit)) {
      throw new BadRequestException("metrics orders limit is invalid");
    }
    return this.metrics.orders(
      operator,
      parseMetricsQuery(normalized, operator.nodeIds),
      normalized.cursor,
      limit,
    );
  }
}

export function normalizeQuery(
  query: Readonly<Record<string, string | string[] | undefined>>,
  allowed: ReadonlySet<string>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string") {
      throw new BadRequestException(`${key} is invalid`);
    }
    normalized[key] = value;
  }
  return normalized;
}
