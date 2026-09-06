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
  @ApiQuery({ name: "cursor", required: false, type: String })
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
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("eventType") eventType?: string,
    @Query("nodeId") nodeId?: string,
    @Query("operatorIdentityId") operatorIdentityId?: string,
    @Query("orderId") orderId?: string,
    @Query("paymentId") paymentId?: string,
    @Query("quoteRequestId") quoteRequestId?: string,
  ): Promise<AuditEventPageDto> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (eventType === "") {
      throw new BadRequestException("eventType is invalid");
    }
    for (const [name, value] of Object.entries({
      nodeId,
      operatorIdentityId,
      orderId,
      paymentId,
      quoteRequestId,
    })) {
      if (value !== undefined && !UUID_PATTERN.test(value)) {
        throw new BadRequestException(`${name} is invalid`);
      }
    }
    return this.audit.list(
      operator,
      {
        ...(eventType !== undefined ? { eventType } : {}),
        ...(nodeId ? { nodeId } : {}),
        ...(operatorIdentityId ? { operatorIdentityId } : {}),
        ...(orderId ? { orderId } : {}),
        ...(paymentId ? { paymentId } : {}),
        ...(quoteRequestId ? { quoteRequestId } : {}),
      },
      cursor,
      parsedLimit,
    );
  }
}
