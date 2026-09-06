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
import { AuditEventPageDto } from "./audit.dto";
import { AuditService } from "./audit.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type QueryValue = string | string[];

@ApiTags("operator audit")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.AUDIT_READ)
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get("admin/audit-events")
  @ApiOperation({ summary: "Read redacted immutable operator audit events" })
  @ApiOkResponse({ type: AuditEventPageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  @ApiQuery({ name: "eventType", required: false, type: String, minLength: 1 })
  @ApiQuery({ name: "nodeId", required: false, type: String, format: "uuid" })
  @ApiQuery({
    name: "operatorIdentityId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({ name: "orderId", required: false, type: String, format: "uuid" })
  @ApiQuery({
    name: "paymentId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({
    name: "quoteRequestId",
    required: false,
    type: String,
    format: "uuid",
  })
  list(
    @CurrentOperator() operator: OperatorContext,
    @Query("cursor") cursor?: QueryValue,
    @Query("limit") limit?: QueryValue,
    @Query("eventType") eventType?: QueryValue,
    @Query("nodeId") nodeId?: QueryValue,
    @Query("operatorIdentityId") operatorIdentityId?: QueryValue,
    @Query("orderId") orderId?: QueryValue,
    @Query("paymentId") paymentId?: QueryValue,
    @Query("quoteRequestId") quoteRequestId?: QueryValue,
  ): Promise<AuditEventPageDto> {
    const query = {
      cursor: scalarQueryValue("cursor", cursor),
      limit: scalarQueryValue("limit", limit),
      eventType: scalarQueryValue("eventType", eventType),
      nodeId: scalarQueryValue("nodeId", nodeId),
      operatorIdentityId: scalarQueryValue(
        "operatorIdentityId",
        operatorIdentityId,
      ),
      orderId: scalarQueryValue("orderId", orderId),
      paymentId: scalarQueryValue("paymentId", paymentId),
      quoteRequestId: scalarQueryValue("quoteRequestId", quoteRequestId),
    };
    const parsedLimit =
      query.limit === undefined ? undefined : Number(query.limit);
    if (query.eventType === "") {
      throw new BadRequestException("eventType is invalid");
    }
    for (const [name, value] of Object.entries({
      nodeId: query.nodeId,
      operatorIdentityId: query.operatorIdentityId,
      orderId: query.orderId,
      paymentId: query.paymentId,
      quoteRequestId: query.quoteRequestId,
    })) {
      if (value !== undefined && !UUID_PATTERN.test(value)) {
        throw new BadRequestException(`${name} is invalid`);
      }
    }
    return this.audit.list(
      operator,
      {
        ...(query.eventType !== undefined
          ? { eventType: query.eventType }
          : {}),
        ...(query.nodeId ? { nodeId: query.nodeId } : {}),
        ...(query.operatorIdentityId
          ? { operatorIdentityId: query.operatorIdentityId }
          : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.paymentId ? { paymentId: query.paymentId } : {}),
        ...(query.quoteRequestId
          ? { quoteRequestId: query.quoteRequestId }
          : {}),
      },
      query.cursor,
      parsedLimit,
    );
  }
}

function scalarQueryValue(
  name: string,
  value: QueryValue | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value;
}
