import { createHash, timingSafeEqual } from "node:crypto";
import { BadGatewayException, UnauthorizedException } from "@nestjs/common";
import type { PaymentProviderConfig } from "./payment-provider.config";
import { PaymentIntentCreationError } from "./payment-provider.port";
import type {
  CheckoutPaymentMethod,
  CreatePaymentIntentInput,
  CreatedPaymentIntent,
  AuthenticatedPaymentEvent,
  PaymentProviderPort,
  PaymentProviderCapabilities,
  PaymentEventLocator,
  ProviderRefundResult,
} from "./payment-provider.port";

type ComgateConfig = Extract<PaymentProviderConfig, { provider: "comgate" }>;

const CAPABILITY_CACHE_MILLISECONDS = 5 * 60 * 1_000;

export class ComgatePaymentProviderAdapter implements PaymentProviderPort {
  private capabilityCache?: Readonly<{
    expiresAt: number;
    value: PaymentProviderCapabilities;
  }>;
  private capabilityRequest: Promise<PaymentProviderCapabilities> | undefined;

  constructor(private readonly config: ComgateConfig) {}

  providerName() {
    return "comgate";
  }

  async capabilities() {
    if (this.capabilityCache && this.capabilityCache.expiresAt > Date.now()) {
      return this.capabilityCache.value;
    }
    if (this.capabilityRequest) return this.capabilityRequest;

    const request = this.discoverCapabilities();
    this.capabilityRequest = request;
    try {
      return await request;
    } finally {
      if (this.capabilityRequest === request) {
        this.capabilityRequest = undefined;
      }
    }
  }

  private async discoverCapabilities(): Promise<PaymentProviderCapabilities> {
    const response = await this.request(
      "/method.json?lang=cs&curr=CZK&country=CZ",
      { method: "GET" },
    );
    const supported = supportedCheckoutMethods(response);
    const value = {
      provider: "comgate" as const,
      methods: supported,
    };
    this.capabilityCache = {
      expiresAt: Date.now() + CAPABILITY_CACHE_MILLISECONDS,
      value,
    };
    return value;
  }

  refundRetrySafety() {
    // Comgate explicitly permits multiple refunds with the same refId, so an
    // ambiguous result cannot be replayed without risking a double refund.
    return "MANUAL_RECONCILIATION" as const;
  }

  async createIntent(
    input: CreatePaymentIntentInput,
  ): Promise<CreatedPaymentIntent> {
    let response: Record<string, unknown>;
    try {
      response = await this.request(
        "/payment.json",
        {
          method: "POST",
          body: JSON.stringify({
            test: this.config.testMode,
            country: "CZ",
            price: providerAmount(input.amountMinor),
            curr: input.currency,
            label: "TAVEN order",
            refId: input.merchantReference,
            method: input.method === "CARD" ? "CARD_ALL" : "BANK_ONLY",
            email: input.email,
            fullName: input.fullName,
            delivery: "HOME_DELIVERY",
            category: "PHYSICAL_GOODS_ONLY",
            lang: "cs",
            expirationTime: `${expirationMinutes(
              input.expiresAt,
              input.observedAt,
            )}m`,
            dynamicExpiration: true,
            url_paid: input.returnUrls.success,
            url_cancelled: input.returnUrls.cancelled,
            url_pending: input.returnUrls.pending,
          }),
        },
        "AMBIGUOUS",
      );
    } catch (error) {
      if (error instanceof PaymentIntentCreationError) throw error;
      throw new PaymentIntentCreationError(
        "DEFINITIVE_FAILURE",
        "Payment provider rejected the request",
        { cause: error },
      );
    }
    const providerIntentId = optionalResponseText(response, "transId");
    if (!providerIntentId) {
      throw new PaymentIntentCreationError(
        "AMBIGUOUS",
        "Payment provider omitted transId",
      );
    }
    try {
      return {
        providerIntentId,
        checkoutUrl: absoluteCheckoutUrl(response.redirect),
      };
    } catch (error) {
      throw new PaymentIntentCreationError(
        "AMBIGUOUS",
        "Payment provider returned an invalid checkout result",
        { cause: error, providerIntentId },
      );
    }
  }

  async verifyEvent(input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    body: unknown;
  }): Promise<AuthenticatedPaymentEvent> {
    const locator = this.locateEvent(input);
    // A callback URL is not proof of payment. Always ask Comgate for current
    // authenticated state before returning a normalized event.
    const status = await this.request(
      `/payment/transId/${encodeURIComponent(locator.providerTransactionId)}.json`,
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
    const currency = responseCurrency(status);
    const merchantReference = requiredResponseText(status, "refId");
    if (merchantReference !== locator.merchantReference) {
      throw new UnauthorizedException(
        "Payment callback reference does not match provider status",
      );
    }
    return {
      provider: "comgate",
      providerEventId: `comgate:${createProviderEventHash(
        locator.providerTransactionId,
        providerStatus,
      )}`,
      providerTransactionId: locator.providerTransactionId,
      merchantReference,
      status: normalizedStatus,
      amountMinor,
      currency,
      occurredAt: null,
      evidence: {
        source: "authenticated-status-api",
        providerStatus,
        test: this.config.testMode,
      },
    };
  }

  locateEvent(input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    body: unknown;
  }): PaymentEventLocator {
    const callback = bodyRecord(input.body);
    const merchant = requiredCallbackText(callback.merchant, "merchant");
    const secret = requiredCallbackText(callback.secret, "secret");
    if (
      merchant !== this.config.merchantId ||
      !constantTimeTextEqual(secret, this.config.secret)
    ) {
      throw new UnauthorizedException("Payment callback identity is invalid");
    }
    return {
      providerTransactionId: requiredCallbackText(
        callback.transId ?? callback.transactionId,
        "transId",
      ),
      merchantReference: requiredCallbackText(
        callback.refId ?? callback.merchantReference,
        "refId",
      ),
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
      occurredAt: null,
      evidence: { source: "authenticated-refund-api" },
    };
  }

  private async request(
    path: string,
    init: Readonly<{ method: "GET" | "POST" | "DELETE"; body?: string }>,
    transportFailure: "DEFINITIVE_FAILURE" | "AMBIGUOUS" = "DEFINITIVE_FAILURE",
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
    } catch (error) {
      if (transportFailure === "AMBIGUOUS") {
        throw new PaymentIntentCreationError(
          "AMBIGUOUS",
          "Payment provider result is unknown",
          { cause: error },
        );
      }
      throw new BadGatewayException("Payment provider is unavailable");
    }
    if (response.ok && response.status === 204) return { code: 0 };
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (transportFailure === "AMBIGUOUS") {
        throw new PaymentIntentCreationError(
          "AMBIGUOUS",
          "Payment provider returned an unreadable creation result",
          { cause: error },
        );
      }
      throw new BadGatewayException("Payment provider returned invalid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      if (transportFailure === "AMBIGUOUS") {
        throw new PaymentIntentCreationError(
          "AMBIGUOUS",
          "Payment provider returned an unreadable creation result",
        );
      }
      throw new BadGatewayException("Payment provider returned invalid JSON");
    }
    const record = body as Record<string, unknown>;
    if (!response.ok || (record.code !== undefined && record.code !== 0)) {
      if (record.code !== undefined && record.code !== 0) {
        if (transportFailure === "AMBIGUOUS") {
          throw new PaymentIntentCreationError(
            isDefinitiveCreationRejectionCode(record.code)
              ? "DEFINITIVE_FAILURE"
              : "AMBIGUOUS",
            "Payment provider rejected the request",
          );
        }
        throw new BadGatewayException("Payment provider rejected the request");
      }
      if (transportFailure === "AMBIGUOUS") {
        throw new PaymentIntentCreationError(
          "AMBIGUOUS",
          "Payment provider creation result is unknown",
        );
      }
      throw new BadGatewayException("Payment provider rejected the request");
    }
    return record;
  }
}

function isDefinitiveCreationRejectionCode(value: unknown): boolean {
  return (
    typeof value === "number" &&
    [
      1102, 1103, 1107, 1301, 1303, 1304, 1305, 1306, 1308, 1309, 1310, 1311,
      1316, 1317, 1400,
    ].includes(value)
  );
}

function providerAmount(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2_147_483_647) {
    throw new BadGatewayException("Payment amount is outside provider limits");
  }
  return amount;
}

function expirationMinutes(expiresAt: Date, observedAt: Date): number {
  return Math.max(
    30,
    Math.min(
      7 * 24 * 60,
      Math.ceil((expiresAt.getTime() - observedAt.getTime()) / 60_000),
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

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function requiredResponseText(
  value: Record<string, unknown>,
  name: string,
): string {
  const text = optionalResponseText(value, name);
  if (!text) throw new BadGatewayException(`Payment provider omitted ${name}`);
  return text;
}

function responseCurrency(value: Record<string, unknown>): string {
  const normalized = requiredResponseText(value, "curr").toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new BadGatewayException("Payment provider returned invalid currency");
  }
  return normalized;
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

function supportedCheckoutMethods(
  response: Record<string, unknown>,
): readonly CheckoutPaymentMethod[] {
  if (!Array.isArray(response.methods)) {
    throw new BadGatewayException("Payment provider omitted allowed methods");
  }
  const identifiers = response.methods.flatMap((method) => {
    if (!method || typeof method !== "object" || Array.isArray(method)) {
      throw new BadGatewayException(
        "Payment provider returned invalid methods",
      );
    }
    const record = method as Record<string, unknown>;
    return [record.id, record.group]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
  });
  const methods: CheckoutPaymentMethod[] = [];
  if (identifiers.some((value) => /^CARD(?:_|$)/.test(value))) {
    methods.push("CARD");
  }
  if (identifiers.some((value) => /^BANK(?:_|$)/.test(value))) {
    methods.push("BANK_TRANSFER");
  }
  return methods;
}
