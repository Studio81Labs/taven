import {
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { PrismaService } from "../../prisma/prisma.service";
import {
  PAYMENT_PROVIDER_CONFIG,
  type PaymentProviderConfig,
} from "./payment-provider.config";
import { PaymentsService } from "./payments.service";
import { sandboxEventSignature } from "./sandbox-payment-provider.adapter";

type SandboxOutcome = "capture" | "decline" | "pending";

@ApiExcludeController()
@Controller("payments/sandbox")
export class SandboxCheckoutController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER_CONFIG)
    private readonly config: PaymentProviderConfig,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  @Get(":providerIntentId")
  @Header("Content-Type", "text/html; charset=utf-8")
  async checkout(
    @Param("providerIntentId") providerIntentId: string,
  ): Promise<string> {
    return checkoutPage(await this.payment(providerIntentId));
  }

  @Post(":providerIntentId/:outcome")
  @HttpCode(200)
  @Header("Content-Type", "text/html; charset=utf-8")
  async complete(
    @Param("providerIntentId") providerIntentId: string,
    @Param("outcome") outcomeInput: string,
  ): Promise<string> {
    const outcome = sandboxOutcome(outcomeInput);
    const config = sandboxConfig(this.config);
    const payment = await this.payment(providerIntentId);
    const status = {
      capture: "CAPTURED",
      decline: "FAILED",
      pending: "PENDING",
    }[outcome] as "CAPTURED" | "FAILED" | "PENDING";
    const body = {
      providerEventId: `sandbox-checkout:${payment.id}:${status}`,
      providerTransactionId: providerIntentId,
      status,
      amountMinor: payment.requestedAmountMinor.toString(),
      currency: payment.currency,
      occurredAt: new Date().toISOString(),
    };
    const result = await this.payments.consumeProviderEvent(
      "sandbox",
      {
        "x-taven-sandbox-signature": sandboxEventSignature(
          body,
          config.webhookSigningSecret,
        ),
      },
      body,
    );
    return checkoutPage(await this.payment(providerIntentId), result.outcome);
  }

  private async payment(providerIntentId: string) {
    sandboxConfig(this.config);
    const payment = await this.prisma.payment.findUnique({
      where: {
        provider_providerIntentId: {
          provider: "sandbox",
          providerIntentId,
        },
      },
      select: {
        id: true,
        providerIntentId: true,
        status: true,
        requestedAmountMinor: true,
        currency: true,
      },
    });
    if (!payment) {
      throw new NotFoundException("Sandbox payment was not found");
    }
    return payment;
  }
}

function sandboxOutcome(value: string): SandboxOutcome {
  if (value === "capture" || value === "decline" || value === "pending") {
    return value;
  }
  throw new NotFoundException("Sandbox outcome is unavailable");
}

function checkoutPage(
  payment: Readonly<{
    id: string;
    providerIntentId: string | null;
    status: string;
    requestedAmountMinor: bigint;
    currency: string;
  }>,
  outcome?: string,
): string {
  const path = `/payments/sandbox/${encodeURIComponent(payment.providerIntentId ?? "")}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>TAVEN. sandbox checkout</title>
  </head>
  <body>
    <main>
      <h1>TAVEN. sandbox checkout</h1>
      <p>Payment <code>${escapeHtml(payment.id)}</code></p>
      <p>Amount: ${escapeHtml(payment.requestedAmountMinor.toString())} minor units ${escapeHtml(payment.currency)}</p>
      <p>Current status: <strong>${escapeHtml(payment.status)}</strong></p>
      ${outcome ? `<p>Webhook outcome: <strong>${escapeHtml(outcome)}</strong></p>` : ""}
      <form method="post" action="${path}/capture"><button type="submit">Capture payment</button></form>
      <form method="post" action="${path}/pending"><button type="submit">Keep pending</button></form>
      <form method="post" action="${path}/decline"><button type="submit">Decline payment</button></form>
    </main>
  </body>
</html>`;
}

function sandboxConfig(config: PaymentProviderConfig) {
  if (config.provider !== "sandbox") {
    throw new NotFoundException("Sandbox checkout is unavailable");
  }
  return config;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
