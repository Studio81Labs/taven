import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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

const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  required: true,
  schema: { type: "string", minLength: 8 },
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
