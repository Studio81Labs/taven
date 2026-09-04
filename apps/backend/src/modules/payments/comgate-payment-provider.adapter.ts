import { createHash } from "node:crypto";
import { BadGatewayException, UnauthorizedException } from "@nestjs/common";
import type { PaymentProviderConfig } from "./payment-provider.config";
import type {
  CreatePaymentIntentInput,
  CreatedPaymentIntent,
  PaymentProviderPort,
  ProviderRefundResult,
  VerifiedPaymentEvent,
} from "./payment-provider.port";

type ComgateConfig = Extract<PaymentProviderConfig, { provider: "comgate" }>;

export class ComgatePaymentProviderAdapter implements PaymentProviderPort {
  constructor(private readonly config: ComgateConfig) {}

  capabilities() {
    return {
      provider: "comgate",
      methods: ["CARD", "BANK_TRANSFER"] as const,
    };
  }

  refundRetrySafety() {
    // Comgate explicitly permits multiple refunds with the same refId, so an
    // ambiguous result cannot be replayed without risking a double refund.
    return "MANUAL_RECONCILIATION" as const;
  }

  async createIntent(
    input: CreatePaymentIntentInput,
  ): Promise<CreatedPaymentIntent> {
    const response = await this.request("/payment.json", {
      method: "POST",
      body: JSON.stringify({
        test: this.config.testMode,
        country: "CZ",
        price: providerAmount(input.amountMinor),
        curr: input.currency,
        label: "TAVEN order",
        refId: input.paymentId,
        method: input.method === "CARD" ? "CARD_ALL" : "BANK_ONLY",
        email: input.email,
        fullName: input.fullName,
        delivery: "HOME_DELIVERY",
        category: "PHYSICAL_GOODS_ONLY",
        lang: "cs",
        expirationTime: `${expirationMinutes(input.expiresAt)}m`,
        dynamicExpiration: true,
        url_paid: input.returnUrls.success,
        url_cancelled: input.returnUrls.cancelled,
        url_pending: input.returnUrls.pending,
      }),
    });
    return {
      providerIntentId: requiredResponseText(response, "transId"),
      checkoutUrl: absoluteCheckoutUrl(response.redirect),
    };
  }

  async verifyEvent(input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    body: unknown;
  }): Promise<VerifiedPaymentEvent> {
    const callback = bodyRecord(input.body);
    const transactionId = requiredCallbackText(
      callback.transId ?? callback.transactionId,
      "transId",
    );
    // A callback URL is not proof of payment. Always ask Comgate for current
    // authenticated state before returning a normalized event.
    const status = await this.request(
      `/payment/transId/${encodeURIComponent(transactionId)}.json`,
      { method: "GET" },
    );
    const providerStatus = requiredResponseText(status, "status");
    const normalizedStatus =
      providerStatus === "PAID"
        ? "CAPTURED"
        : providerStatus === "CANCELLED"
          ? "FAILED"
          : providerStatus === "PENDING" || providerStatus === "AUTHORIZED"
            ? "PENDING"
            : null;
    if (!normalizedStatus) {
      throw new BadGatewayException(
        "Comgate returned an unknown payment status",
      );
    }
    const amountMinor = positiveResponseBigInt(status.price, "price");
    const currency = requiredResponseText(status, "curr").toUpperCase();
    const occurredAt = new Date();
    return {
      provider: "comgate",
      providerEventId: `comgate:${createProviderEventHash(
        transactionId,
        providerStatus,
      )}`,
      providerTransactionId: transactionId,
      status: normalizedStatus,
      amountMinor,
      currency,
      occurredAt,
      evidence: {
        source: "authenticated-status-api",
        providerStatus,
        test: this.config.testMode,
      },
    };
  }

  async cancelIntent(providerIntentId: string): Promise<void> {
    const path = `/payment/transId/${encodeURIComponent(providerIntentId)}.json`;
    try {
      await this.request(path, { method: "DELETE" });
    } catch (error) {
      // DELETE is not idempotent in Comgate's API: a repeated cancellation can
      // return 1400. Authenticate the current state before deciding whether the
      // durable void command still needs retrying.
      const status = await this.request(path, { method: "GET" }).catch(() => {
        throw error;
      });
      if (requiredResponseText(status, "status") !== "CANCELLED") throw error;
    }
  }

  async refund(input: {
    paymentId: string;
    providerIntentId: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }): Promise<ProviderRefundResult> {
    const result = await this.request("/refund.json", {
      method: "POST",
      body: JSON.stringify({
        transId: input.providerIntentId,
        amount: providerAmount(input.amountMinor),
        test: this.config.testMode,
        refId: input.idempotencyKey,
      }),
    });
    return {
      providerRefundId:
        optionalResponseText(result, "refundId") ?? input.idempotencyKey,
      occurredAt: new Date(),
      evidence: { source: "authenticated-refund-api" },
    };
  }

  private async request(
    path: string,
    init: Readonly<{ method: "GET" | "POST" | "DELETE"; body?: string }>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        method: init.method,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(
            `${this.config.merchantId}:${this.config.secret}`,
          ).toString("base64")}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new BadGatewayException("Payment provider is unavailable");
    }
    if (response.ok && response.status === 204) return { code: 0 };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BadGatewayException("Payment provider returned invalid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadGatewayException("Payment provider returned invalid JSON");
    }
    const record = body as Record<string, unknown>;
    if (!response.ok || (record.code !== undefined && record.code !== 0)) {
      throw new BadGatewayException("Payment provider rejected the request");
    }
    return record;
  }
}

function providerAmount(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2_147_483_647) {
    throw new BadGatewayException("Payment amount is outside provider limits");
  }
  return amount;
}

function expirationMinutes(expiresAt: Date): number {
  return Math.max(
    30,
    Math.min(
      7 * 24 * 60,
      Math.ceil((expiresAt.getTime() - Date.now()) / 60_000),
    ),
  );
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnauthorizedException("Payment provider payload is invalid");
  }
  return value as Record<string, unknown>;
}

function requiredCallbackText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 255) {
    throw new UnauthorizedException(`Payment callback ${name} is invalid`);
  }
  return value.trim();
}

function requiredResponseText(
  value: Record<string, unknown>,
  name: string,
): string {
  const text = optionalResponseText(value, name);
  if (!text) throw new BadGatewayException(`Payment provider omitted ${name}`);
  return text;
}

function optionalResponseText(
  value: Record<string, unknown>,
  name: string,
): string | null {
  const candidate = value[name];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

function positiveResponseBigInt(value: unknown, name: string): bigint {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9][0-9]*$/.test(normalized)) {
    throw new BadGatewayException(`Payment provider returned invalid ${name}`);
  }
  return BigInt(normalized);
}

function absoluteCheckoutUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadGatewayException("Payment provider omitted checkout URL");
  }
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadGatewayException("Payment provider omitted checkout URL");
  }
  if (parsed.protocol !== "https:") {
    throw new BadGatewayException("Payment provider returned an unsafe URL");
  }
  return parsed.toString();
}

function createProviderEventHash(
  transactionId: string,
  providerStatus: string,
): string {
  return createHash("sha256")
    .update(`${transactionId}:${providerStatus}`, "utf8")
    .digest("hex");
}
