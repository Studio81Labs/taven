import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { OperatorAccessGuard } from "../admin-access/operator-access.guard";
import {
  ApproveLegacyClaimWindowDto,
  CancelOrderDto,
  CreateClaimReprintDto,
  CreateClaimDto,
  CreatePriceAdjustmentDto,
  CreateReplacementDto,
  CreateShipmentDto,
  ExpireReplacementDto,
  FulfilmentCommandResultDto,
  FulfilmentProjectionDto,
  HandoffReshipmentDto,
  JobFailureDto,
  JobPrintedDto,
  JobQcSubmissionDto,
  PackJobDto,
  RejectClaimDto,
  ShipmentEventDto,
  ShipmentLabelDto,
  ShipmentProviderEvidenceDto,
  WithdrawClaimDto,
} from "./orders.dto";
import { OrdersService } from "./orders.service";

const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  required: true,
  description: "Stable command key; replaying altered input returns 409",
  schema: {
    type: "string",
    minLength: 8,
    pattern: "^\\s*\\S[\\s\\S]{6,253}\\S\\s*$",
  },
};

const ORDER_ID_PARAM = { name: "orderId", type: String, format: "uuid" };
const JOB_ID_PARAM = { name: "jobId", type: String, format: "uuid" };
const SHIPMENT_ID_PARAM = {
  name: "shipmentId",
  type: String,
  format: "uuid",
};
const ADJUSTMENT_ID_PARAM = {
  name: "adjustmentId",
  type: String,
  format: "uuid",
};
const CLAIM_ID_PARAM = { name: "claimId", type: String, format: "uuid" };

@ApiTags("operator fulfilment")
@ApiBearerAuth()
@UseGuards(OperatorAccessGuard)
@Controller("admin/orders/:orderId/fulfilment")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: "Read the fulfilment and recovery projection" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkResponse({ type: FulfilmentProjectionDto })
  @ApiNotFoundResponse({ description: "Order was not found" })
  get(@Param("orderId") orderId: string): Promise<FulfilmentProjectionDto> {
    return this.orders.getFulfilment(orderId);
  }

  @Post("claim-window-migration")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve the exact Claim window for a legacy accepted Order",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: ApproveLegacyClaimWindowDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  approveLegacyClaimWindow(
    @Param("orderId") orderId: string,
    @Body() body: ApproveLegacyClaimWindowDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.approveLegacyClaimWindow(orderId, body, key);
  }

  @Post("jobs/:jobId/accept")
  @HttpCode(200)
  @ApiOperation({ summary: "Accept a platform-owned production Job" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  acceptJob(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.acceptJob(orderId, jobId, key);
  }

  @Post("jobs/:jobId/printing")
  @HttpCode(200)
  @ApiOperation({ summary: "Start printing a G-code-ready Job" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  startPrinting(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.startPrinting(orderId, jobId, key);
  }

  @Post("jobs/:jobId/printed")
  @HttpCode(200)
  @ApiOperation({ summary: "Finish printing and settle consumed resources" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: JobPrintedDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  printed(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Body() body: JobPrintedDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.finishPrinting(orderId, jobId, body, key);
  }

  @Post("jobs/:jobId/qc-submission")
  @HttpCode(200)
  @ApiOperation({ summary: "Submit optional v0 QC evidence" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: JobQcSubmissionDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  submitQc(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Body() body: JobQcSubmissionDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.submitQc(orderId, jobId, body, key);
  }

  @Post("jobs/:jobId/qc-approval")
  @HttpCode(200)
  @ApiOperation({ summary: "Approve a Job after QC" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  approveQc(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.approveQc(orderId, jobId, key);
  }

  @Post("jobs/:jobId/failure")
  @HttpCode(200)
  @ApiOperation({
    summary: "Record a terminal Job failure and recovery obligation",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: JobFailureDto })
  @ApiConflictResponse({
    description: "Failure or recovery conflicts with current state",
  })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  failJob(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Body() body: JobFailureDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.failJob(orderId, jobId, body, key);
  }

  @Post("jobs/:jobId/replacement")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reserve fresh resources and create a replacement Job",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateReplacementDto })
  @ApiConflictResponse({ description: "Fresh resources cannot be reserved" })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  createReplacement(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Body() body: CreateReplacementDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.createReplacement(orderId, jobId, body, key);
  }

  @Post("jobs/:jobId/replacement-expiry")
  @HttpCode(200)
  @ApiOperation({
    summary: "Close an expired replacement request into refund recovery",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: ExpireReplacementDto })
  @ApiConflictResponse({ description: "Replacement request has not expired" })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  expireReplacement(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Body() body: ExpireReplacementDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.expireReplacement(orderId, jobId, body, key);
  }

  @Post("jobs/:jobId/packing")
  @HttpCode(200)
  @ApiOperation({ summary: "Pack and bind a Job to exactly one Shipment" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(JOB_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: PackJobDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  packJob(
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Body() body: PackJobDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.packJob(orderId, jobId, body, key);
  }

  @Post("shipments")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a parcel or replacement parcel leaf" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateShipmentDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  createShipment(
    @Param("orderId") orderId: string,
    @Body() body: CreateShipmentDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.createShipment(orderId, body, key);
  }

  @Post("shipments/:shipmentId/label")
  @HttpCode(200)
  @ApiOperation({ summary: "Record a manually-created carrier label" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(SHIPMENT_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: ShipmentLabelDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  labelShipment(
    @Param("orderId") orderId: string,
    @Param("shipmentId") shipmentId: string,
    @Body() body: ShipmentLabelDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.labelShipment(orderId, shipmentId, body, key);
  }

  @Post("shipments/:shipmentId/label-void")
  @HttpCode(200)
  @ApiOperation({ summary: "Record a provider-confirmed carrier label void" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(SHIPMENT_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: ShipmentProviderEvidenceDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  confirmLabelVoid(
    @Param("orderId") orderId: string,
    @Param("shipmentId") shipmentId: string,
    @Body() body: ShipmentProviderEvidenceDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.confirmLabelVoid(orderId, shipmentId, body, key);
  }

  @Post("shipments/:shipmentId/handoff")
  @HttpCode(200)
  @ApiOperation({ summary: "Commit one provider-confirmed parcel handoff" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(SHIPMENT_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: ShipmentProviderEvidenceDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  handoffShipment(
    @Param("orderId") orderId: string,
    @Param("shipmentId") shipmentId: string,
    @Body() body: ShipmentProviderEvidenceDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.handoffShipment(orderId, shipmentId, body, key);
  }

  @Post("shipments/:shipmentId/events")
  @HttpCode(200)
  @ApiOperation({ summary: "Apply an authenticated carrier lifecycle event" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(SHIPMENT_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: ShipmentEventDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  shipmentEvent(
    @Param("orderId") orderId: string,
    @Param("shipmentId") shipmentId: string,
    @Body() body: ShipmentEventDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.applyShipmentEvent(orderId, shipmentId, body, key);
  }

  @Post("adjustments")
  @HttpCode(200)
  @ApiOperation({ summary: "Record an immutable manual price adjustment" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreatePriceAdjustmentDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  adjustment(
    @Param("orderId") orderId: string,
    @Body() body: CreatePriceAdjustmentDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.createPriceAdjustment(orderId, body, key);
  }

  @Post("adjustments/:adjustmentId/refund")
  @HttpCode(200)
  @ApiOperation({ summary: "Request the refund for a manual price adjustment" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(ADJUSTMENT_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  refundAdjustment(
    @Param("orderId") orderId: string,
    @Param("adjustmentId") adjustmentId: string,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.refundAdjustment(orderId, adjustmentId, key);
  }

  @Post("claims")
  @HttpCode(200)
  @ApiOperation({ summary: "Open a manually verified fulfilment Claim" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateClaimDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  createClaim(
    @Param("orderId") orderId: string,
    @Body() body: CreateClaimDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.createClaim(orderId, body, key);
  }

  @Post("claims/:claimId/rejection")
  @HttpCode(200)
  @ApiOperation({ summary: "Reject a clean post-delivery quality Claim" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(CLAIM_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: RejectClaimDto })
  @ApiConflictResponse({
    description: "Claim has incident, remedy, or financial recovery history",
  })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  rejectClaim(
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Body() body: RejectClaimDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.rejectClaim(orderId, claimId, body, key);
  }

  @Post("claims/:claimId/withdrawal")
  @HttpCode(200)
  @ApiOperation({ summary: "Withdraw a clean post-delivery quality Claim" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(CLAIM_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: WithdrawClaimDto })
  @ApiConflictResponse({
    description: "Claim has incident, remedy, or financial recovery history",
  })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  withdrawClaim(
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Body() body: WithdrawClaimDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.withdrawClaim(orderId, claimId, body, key);
  }

  @Post("claims/:claimId/reshipment-handoff")
  @HttpCode(200)
  @ApiOperation({
    summary: "Re-QC and hand off a custody-confirmed incident reshipment",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(CLAIM_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: HandoffReshipmentDto })
  @ApiConflictResponse({
    description: "Claim, custody, QC, or parcel scope is not reshippable",
  })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  handoffReshipment(
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Body() body: HandoffReshipmentDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.handoffReshipment(orderId, claimId, body, key);
  }

  @Post("claims/:claimId/reprint")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reserve and create a whole-parcel reprint for a LOST Claim",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(CLAIM_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateClaimReprintDto })
  @ApiConflictResponse({
    description: "Claim scope or fresh replacement capacity is unavailable",
  })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  createClaimReprint(
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Body() body: CreateClaimReprintDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.createClaimReprint(orderId, claimId, body, key);
  }

  @Post("claims/:claimId/refund")
  @HttpCode(200)
  @ApiOperation({
    summary: "Credit and refund every unresolved slot in a Claim",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiParam(CLAIM_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  refundClaim(
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.refundClaim(orderId, claimId, key);
  }

  @Post("complete")
  @HttpCode(200)
  @ApiOperation({ summary: "Complete a fully delivered and settled order" })
  @ApiParam(ORDER_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  complete(
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.completeOrder(orderId, key);
  }

  @Post("cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel an order before physical handoff and request refunds",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CancelOrderDto })
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  cancel(
    @Param("orderId") orderId: string,
    @Body() body: CancelOrderDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.cancelOrder(orderId, body, key);
  }
}
