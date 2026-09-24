import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
import {
  CompleteHandlingSessionDto,
  MeasurementCommandResultDto,
  RecordAcquisitionSpendDto,
  RecordActualCostDto,
  RecordManualHandlingSessionDto,
  StartHandlingSessionDto,
  VoidHandlingSessionDto,
} from "./measurement.dto";
import { MeasurementService } from "./measurement.service";
import {
  AcquisitionSpendEvidencePageDto,
  ActualCostEvidencePageDto,
} from "./measurement-read.dto";
import {
  HandlingAllocationPageDto,
  HandlingSessionPageDto,
  HandlingSessionReadDto,
} from "./handling-read.dto";

const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  required: true,
  schema: {
    type: "string",
    minLength: 8,
    pattern: "^\\s*\\S[\\s\\S]{6,253}\\S\\s*$",
  },
};
const SESSION_ID = { name: "sessionId", type: String, format: "uuid" };
const ORDER_ID = { name: "orderId", type: String, format: "uuid" };

@ApiTags("operator measurement")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_WRITE)
@Controller("admin")
export class MeasurementController {
  constructor(private readonly measurement: MeasurementService) {}

  @Post("handling-sessions/start")
  @HttpCode(200)
  @ApiOperation({ summary: "Start an operator handling timer" })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: StartHandlingSessionDto })
  @ApiOkResponse({ type: MeasurementCommandResultDto })
  start(
    @CurrentOperator() operator: OperatorContext,
    @Body() body: StartHandlingSessionDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.measurement.start(operator, body, key);
  }

  @Post("handling-sessions/:sessionId/stop")
  @HttpCode(200)
  @ApiOperation({
    summary: "Complete a handling timer and allocate its measured cost",
  })
  @ApiParam(SESSION_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CompleteHandlingSessionDto })
  @ApiOkResponse({ type: MeasurementCommandResultDto })
  stop(
    @CurrentOperator() operator: OperatorContext,
    @Param("sessionId") sessionId: string,
    @Body() body: CompleteHandlingSessionDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.measurement.complete(operator, sessionId, body, key);
  }

  @Post("handling-sessions/manual")
  @HttpCode(200)
  @ApiOperation({ summary: "Record a completed manual handling measurement" })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: RecordManualHandlingSessionDto })
  @ApiOkResponse({ type: MeasurementCommandResultDto })
  manual(
    @CurrentOperator() operator: OperatorContext,
    @Body() body: RecordManualHandlingSessionDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.measurement.recordManual(operator, body, key);
  }

  @Post("handling-sessions/:sessionId/void")
  @HttpCode(200)
  @ApiOperation({
    summary: "Void immutable handling evidence with a correction reason",
  })
  @ApiParam(SESSION_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: VoidHandlingSessionDto })
  @ApiOkResponse({ type: MeasurementCommandResultDto })
  void(
    @CurrentOperator() operator: OperatorContext,
    @Param("sessionId") sessionId: string,
    @Body() body: VoidHandlingSessionDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.measurement.void(operator, sessionId, body, key);
  }

  @Post("orders/:orderId/actual-costs")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION)
  @HttpCode(200)
  @ApiOperation({ summary: "Record append-only actual order-cost evidence" })
  @ApiParam(ORDER_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: RecordActualCostDto })
  @ApiOkResponse({ type: MeasurementCommandResultDto })
  actualCost(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Body() body: RecordActualCostDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.measurement.recordActualCost(operator, orderId, body, key);
  }

  @Post("acquisition-spend")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION)
  @HttpCode(200)
  @ApiOperation({ summary: "Record append-only acquisition spend evidence" })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: RecordAcquisitionSpendDto })
  @ApiOkResponse({ type: MeasurementCommandResultDto })
  acquisitionSpend(
    @CurrentOperator() operator: OperatorContext,
    @Body() body: RecordAcquisitionSpendDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.measurement.recordAcquisitionSpend(operator, body, key);
  }
}

@ApiTags("operator measurement")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
@Controller("admin/handling-sessions")
export class HandlingSessionReadController {
  constructor(private readonly measurement: MeasurementService) {}

  @Get()
  @ApiOperation({ summary: "List scoped handling sessions and allocations" })
  @ApiOkResponse({ type: HandlingSessionPageDto })
  @ApiQuery({
    name: "lifecycle",
    required: false,
    enum: ["OPEN", "COMPLETED", "VOIDED"],
  })
  @ApiQuery({ name: "orderId", required: false, type: String, format: "uuid" })
  @ApiQuery({ name: "cursor", required: false, type: String, format: "uuid" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  list(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<HandlingSessionPageDto> {
    const page = handlingQuery(query);
    return this.measurement.handlingSessions(
      operator,
      page.lifecycle,
      page.orderId,
      page.cursor,
      page.limit,
    );
  }

  @Get(":sessionId")
  @ApiOperation({ summary: "Read one scoped handling session and allocations" })
  @ApiParam(SESSION_ID)
  @ApiOkResponse({ type: HandlingSessionReadDto })
  detail(
    @CurrentOperator() operator: OperatorContext,
    @Param("sessionId") sessionId: string,
  ): Promise<HandlingSessionReadDto> {
    return this.measurement.handlingSession(operator, sessionId);
  }

  @Get(":sessionId/allocations")
  @ApiOperation({ summary: "Page through scoped handling allocations" })
  @ApiParam(SESSION_ID)
  @ApiOkResponse({ type: HandlingAllocationPageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, format: "uuid" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  allocations(
    @CurrentOperator() operator: OperatorContext,
    @Param("sessionId") sessionId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<HandlingAllocationPageDto> {
    const page = evidenceQuery(query, new Set(["cursor", "limit"]));
    return this.measurement.handlingAllocations(
      operator,
      sessionId,
      page.cursor,
      page.limit,
    );
  }
}

@ApiTags("operator measurement")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION)
@Controller("admin")
export class MeasurementReadController {
  constructor(private readonly measurement: MeasurementService) {}

  @Get("orders/:orderId/actual-costs")
  @ApiOperation({ summary: "Read scoped actual-cost evidence and corrections" })
  @ApiParam(ORDER_ID)
  @ApiOkResponse({ type: ActualCostEvidencePageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, format: "uuid" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  actualCosts(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ActualCostEvidencePageDto> {
    const page = evidenceQuery(query, new Set(["cursor", "limit"]));
    return this.measurement.actualCostEvidence(
      operator,
      orderId,
      page.cursor,
      page.limit,
    );
  }

  @Get("acquisition-spend")
  @ApiOperation({
    summary: "Read platform acquisition-spend evidence and corrections",
  })
  @ApiOkResponse({ type: AcquisitionSpendEvidencePageDto })
  @ApiQuery({
    name: "channel",
    required: false,
    enum: ["DIRECT", "ORGANIC", "PAID", "REFERRAL", "UNKNOWN"],
  })
  @ApiQuery({ name: "cursor", required: false, type: String, format: "uuid" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  spend(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<AcquisitionSpendEvidencePageDto> {
    const page = evidenceQuery(query, new Set(["channel", "cursor", "limit"]));
    return this.measurement.acquisitionSpendEvidence(
      operator,
      page.channel,
      page.cursor,
      page.limit,
    );
  }
}

function evidenceQuery(
  query: Record<string, string | string[] | undefined>,
  allowed: ReadonlySet<string>,
): { channel?: string; cursor?: string; limit?: number } {
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string")
      throw new BadRequestException(`${key} is invalid`);
  }
  return {
    ...(query.channel !== undefined
      ? { channel: query.channel as string }
      : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor as string } : {}),
    ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
  };
}

function handlingQuery(query: Record<string, string | string[] | undefined>): {
  lifecycle?: string;
  orderId?: string;
  cursor?: string;
  limit?: number;
} {
  const allowed = new Set(["lifecycle", "orderId", "cursor", "limit"]);
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string")
      throw new BadRequestException(`${key} is invalid`);
  }
  return {
    ...(query.lifecycle !== undefined
      ? { lifecycle: query.lifecycle as string }
      : {}),
    ...(query.orderId !== undefined
      ? { orderId: query.orderId as string }
      : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor as string } : {}),
    ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
  };
}
