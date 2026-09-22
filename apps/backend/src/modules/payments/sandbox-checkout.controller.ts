import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Redirect,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { ApiExcludeController } from "@nestjs/swagger";
import { PrismaService } from "../../prisma/prisma.service";
import {
  PAYMENT_PROVIDER_CONFIG,
  type PaymentProviderConfig,
} from "./payment-provider.config";
import { PaymentsService } from "./payments.service";
import {
  sandboxEventSignature,
  sandboxReturnSignature,
} from "./sandbox-payment-provider.adapter";

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
    @Query("returnToken") returnToken?: string,
    @Query("returnSignature") returnSignature?: string,
  ): Promise<string> {
    return checkoutPage(
      await this.payment(providerIntentId),
      undefined,
      returnToken,
      returnSignature,
    );
  }

  @Post(":providerIntentId/:outcome")
  @Redirect()
  async complete(
    @Param("providerIntentId") providerIntentId: string,
    @Param("outcome") outcomeInput: string,
    @Query("returnToken") returnToken?: string,
    @Query("returnSignature") returnSignature?: string,
  ): Promise<string | { url: string; statusCode: 303 }> {
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
      merchantReference: payment.merchantReference,
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
    const returnUrls = verifiedReturnUrls(
      returnToken,
      returnSignature,
      config.webhookSigningSecret,
    );
    const redirectTarget = returnUrls?.[outcomeReturnKey(outcome)];
    if (redirectTarget) return { url: redirectTarget, statusCode: 303 };
    return checkoutPage(
      await this.payment(providerIntentId),
      result.outcome,
      returnToken,
      returnSignature,
    );
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
        merchantReference: true,
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
  returnToken?: string,
  returnSignature?: string,
): string {
  const path = `/payments/sandbox/${encodeURIComponent(payment.providerIntentId ?? "")}`;
  const returnQuery = new URLSearchParams();
  if (returnToken && returnSignature) {
    returnQuery.set("returnToken", returnToken);
    returnQuery.set("returnSignature", returnSignature);
  }
  const action = (outcome: SandboxOutcome) =>
    returnQuery.size > 0
      ? `${path}/${outcome}?${returnQuery}`
      : `${path}/${outcome}`;
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
      <form method="post" action="${action("capture")}"><button type="submit">Capture payment</button></form>
      <form method="post" action="${action("pending")}"><button type="submit">Keep pending</button></form>
      <form method="post" action="${action("decline")}"><button type="submit">Decline payment</button></form>
    </main>
  </body>
</html>`;
}

function outcomeReturnKey(
  outcome: SandboxOutcome,
): "success" | "cancelled" | "pending" {
  if (outcome === "capture") return "success";
  if (outcome === "decline") return "cancelled";
  return "pending";
}

function verifiedReturnUrls(
  token: string | undefined,
  signature: string | undefined,
  secret: string,
): Readonly<{
  success: string;
  cancelled: string;
  pending: string;
}> | null {
  if (!token || !signature) return null;
  const expected = sandboxReturnSignature(token, secret).replace(
    /^sha256=/,
    "",
  );
  const actual = signature.replace(/^sha256=/, "");
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    const values = [candidate.success, candidate.cancelled, candidate.pending];
    if (
      values.some(
        (value) =>
          typeof value !== "string" || !value || !/^https?:\/\//.test(value),
      )
    ) {
      return null;
    }
    return {
      success: candidate.success as string,
      cancelled: candidate.cancelled as string,
      pending: candidate.pending as string,
    };
  } catch {
    return null;
  }
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
