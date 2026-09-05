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
  CancelOrderDto,
  CreateClaimDto,
  CreatePriceAdjustmentDto,
  CreateReplacementDto,
  CreateShipmentDto,
  FulfilmentCommandResultDto,
  FulfilmentProjectionDto,
  JobFailureDto,
  JobPrintedDto,
  JobQcSubmissionDto,
  PackJobDto,
  ShipmentEventDto,
  ShipmentLabelDto,
  ShipmentProviderEvidenceDto,
} from "./orders.dto";
import { OrdersService } from "./orders.service";

const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  required: true,
  description: "Stable command key; replaying altered input returns 409",
  schema: { type: "string", minLength: 8 },
};

@ApiTags("operator fulfilment")
@ApiBearerAuth()
@UseGuards(OperatorAccessGuard)
@Controller("admin/orders/:orderId/fulfilment")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: "Read the fulfilment and recovery projection" })
  @ApiParam({ name: "orderId", type: String, format: "uuid" })
  @ApiOkResponse({ type: FulfilmentProjectionDto })
  @ApiNotFoundResponse({ description: "Order was not found" })
  get(@Param("orderId") orderId: string): Promise<FulfilmentProjectionDto> {
    return this.orders.getFulfilment(orderId);
  }

  @Post("jobs/:jobId/accept")
  @HttpCode(200)
  @ApiOperation({ summary: "Accept a platform-owned production Job" })
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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

  @Post("jobs/:jobId/packing")
  @HttpCode(200)
  @ApiOperation({ summary: "Pack and bind a Job to exactly one Shipment" })
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
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
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  createClaim(
    @Param("orderId") orderId: string,
    @Body() body: CreateClaimDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.createClaim(orderId, body, key);
  }

  @Post("claims/:claimId/refund")
  @HttpCode(200)
  @ApiOperation({
    summary: "Credit and refund every unresolved slot in a Claim",
  })
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
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FulfilmentCommandResultDto })
  cancel(
    @Param("orderId") orderId: string,
    @Body() body: CancelOrderDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.orders.cancelOrder(orderId, body, key);
  }
}
