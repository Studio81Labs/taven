import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Ip,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiSecurity,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { OPERATOR_CSRF_HEADER } from "../admin-access/operator-auth.openapi";
import {
  CreateBalancePaymentDto,
  CheckoutPaymentDto,
  CreateCheckoutPaymentDto,
  PaymentCapabilitiesDto,
  PaymentWebhookAcceptedDto,
} from "./payments.dto";
import { PaymentsService } from "./payments.service";
import { OperatorAccessGuard } from "../admin-access/operator-access.guard";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { RequireOperatorPermissions } from "../admin-access/require-operator-permissions.decorator";

const SESSION_ID = { name: "sessionId", type: String, format: "uuid" };
const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  required: true,
  description: "Stable client command identity (8-255 characters)",
  schema: {
    type: "string",
    minLength: 8,
    pattern: "^\\s*\\S[\\s\\S]{6,253}\\S\\s*$",
  },
};

@ApiTags("payments")
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get("payments/capabilities")
  @ApiOperation({
    summary: "List checkout methods offered by the active provider",
  })
  @ApiOkResponse({ type: PaymentCapabilitiesDto })
  capabilities(): Promise<PaymentCapabilitiesDto> {
    return this.payments.capabilities();
  }

  @Post("admin/orders/:orderId/balance-payment")
  @HttpCode(200)
  @ApiSecurity("operatorSession")
  @UseGuards(OperatorAccessGuard)
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION)
  @ApiParam({ name: "orderId", type: String, format: "uuid" })
  @ApiHeader({ ...OPERATOR_CSRF_HEADER, required: true })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateBalancePaymentDto })
  @ApiOperation({ summary: "Create the post-QC balance payment intent" })
  @ApiOkResponse({ type: CheckoutPaymentDto })
  @ApiConflictResponse({ description: "Balance topology or command changed" })
  @ApiServiceUnavailableResponse({
    description: "The configured payment provider is unavailable",
  })
  createBalance(
    @Param("orderId") orderId: string,
    @Body() body: CreateBalancePaymentDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<CheckoutPaymentDto> {
    return this.payments.createBalancePayment(orderId, body, idempotencyKey);
  }

  @Post("automatic-quote-sessions/:sessionId/checkout/payments")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiParam(SESSION_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateCheckoutPaymentDto })
  @ApiOperation({ summary: "Create the initial checkout payment intent" })
  @ApiOkResponse({ type: CheckoutPaymentDto })
  @ApiUnauthorizedResponse({ description: "Session capability is invalid" })
  @ApiConflictResponse({ description: "Checkout topology or input changed" })
  @ApiServiceUnavailableResponse({
    description: "Checkout awaits launch approval or provider recovery",
  })
  create(
    @Param("sessionId") sessionId: string,
    @Body() body: CreateCheckoutPaymentDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<CheckoutPaymentDto> {
    return this.payments.createCheckoutPayment(
      sessionId,
      body,
      authorization,
      idempotencyKey,
    );
  }

  @Get("automatic-quote-sessions/:sessionId/checkout/payment")
  @ApiBearerAuth()
  @ApiParam(SESSION_ID)
  @ApiQuery({ name: "paymentId", type: String, format: "uuid", required: true })
  @ApiOperation({ summary: "Read a specific checkout payment state" })
  @ApiOkResponse({ type: CheckoutPaymentDto })
  status(
    @Param("sessionId") sessionId: string,
    @Query("paymentId") paymentId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<CheckoutPaymentDto> {
    return this.payments.getCheckoutPayment(
      sessionId,
      paymentId,
      authorization,
    );
  }

  @Delete("automatic-quote-sessions/:sessionId/checkout/payment")
  @ApiBearerAuth()
  @ApiParam(SESSION_ID)
  @ApiQuery({ name: "paymentId", type: String, format: "uuid", required: true })
  @ApiOperation({ summary: "Cancel an open checkout payment" })
  @ApiOkResponse({ type: CheckoutPaymentDto })
  cancel(
    @Param("sessionId") sessionId: string,
    @Query("paymentId") paymentId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<CheckoutPaymentDto> {
    return this.payments.cancelCheckoutPayment(
      sessionId,
      paymentId,
      authorization,
    );
  }

  @Post("payments/webhooks/:provider")
  @HttpCode(200)
  @ApiParam({ name: "provider", type: String })
  @ApiConsumes("application/json", "application/x-www-form-urlencoded")
  @ApiBody({ schema: { type: "object", additionalProperties: true } })
  @ApiOperation({ summary: "Consume an authenticated payment-provider event" })
  @ApiOkResponse({ type: PaymentWebhookAcceptedDto })
  @ApiTooManyRequestsResponse({
    description: "Payment webhook verification limit is exhausted",
  })
  webhook(
    @Param("provider") provider: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Ip() clientAddress: string,
  ): Promise<PaymentWebhookAcceptedDto> {
    return this.payments.consumeProviderEvent(
      provider,
      headers,
      body,
      clientAddress,
    );
  }
}
