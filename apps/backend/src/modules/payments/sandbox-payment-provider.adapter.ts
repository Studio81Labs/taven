import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import type { PaymentProviderConfig } from "./payment-provider.config";
import type {
  CreatePaymentIntentInput,
  CreatedPaymentIntent,
  PaymentEventLocator,
  PaymentProviderPort,
  ProviderRefundResult,
  VerifiedPaymentEvent,
} from "./payment-provider.port";

type SandboxConfig = Extract<PaymentProviderConfig, { provider: "sandbox" }>;

export class SandboxPaymentProviderAdapter implements PaymentProviderPort {
  constructor(private readonly config: SandboxConfig) {}

  providerName() {
    return "sandbox";
  }

  async capabilities() {
    return {
      provider: "sandbox",
      methods: ["CARD", "BANK_TRANSFER"] as const,
    };
  }

  refundRetrySafety() {
    return "IDEMPOTENT" as const;
  }

  async createIntent(
    input: CreatePaymentIntentInput,
  ): Promise<CreatedPaymentIntent> {
    const providerIntentId = `sandbox-${input.paymentId}`;
    return {
      providerIntentId,
      checkoutUrl: `${this.config.publicBaseUrl}/payments/sandbox/${encodeURIComponent(providerIntentId)}`,
    };
  }

  async verifyEvent(input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    body: unknown;
  }): Promise<VerifiedPaymentEvent> {
    const locator = this.locateEvent(input);
    const body = eventBody(input.body);
    return {
      provider: "sandbox",
      providerEventId: requiredText(
        body.providerEventId,
        "providerEventId",
        255,
      ),
      providerTransactionId: locator.providerTransactionId,
      merchantReference: locator.merchantReference,
      status: paymentStatus(body.status),
      amountMinor: positiveBigInt(body.amountMinor, "amountMinor"),
      currency: currency(body.currency),
      occurredAt: timestamp(body.occurredAt),
      evidence: { source: "signed-sandbox-webhook" },
    };
  }

  locateEvent(input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    body: unknown;
  }): PaymentEventLocator {
    const body = eventBody(input.body);
    const signature = firstHeader(input.headers["x-taven-sandbox-signature"]);
    const expected = sandboxEventSignature(
      body,
      this.config.webhookSigningSecret,
    ).replace(/^sha256=/, "");
    const actualBytes = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
    const expectedBytes = Buffer.from(expected, "hex");
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new UnauthorizedException("Sandbox payment signature is invalid");
    }
    return {
      providerTransactionId: requiredText(
        body.providerTransactionId,
        "providerTransactionId",
        255,
      ),
      merchantReference: requiredText(
        body.merchantReference,
        "merchantReference",
        255,
      ),
    };
  }

  async cancelIntent(_providerIntentId: string): Promise<void> {}

  async refund(input: {
    paymentId: string;
    providerIntentId: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }): Promise<ProviderRefundResult> {
    return {
      providerRefundId: `sandbox-refund-${createHash("sha256")
        .update(input.idempotencyKey)
        .digest("hex")
        .slice(0, 32)}`,
      occurredAt: new Date(),
      evidence: { source: "sandbox-refund" },
    };
  }
}

function eventBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnauthorizedException("Sandbox payment event is invalid");
  }
  return value as Record<string, unknown>;
}

function firstHeader(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) throw new UnauthorizedException("Payment signature is missing");
  return header;
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new UnauthorizedException(`Sandbox ${name} is invalid`);
  }
  return value.trim();
}

function paymentStatus(value: unknown): "PENDING" | "CAPTURED" | "FAILED" {
  if (value !== "PENDING" && value !== "CAPTURED" && value !== "FAILED") {
    throw new UnauthorizedException("Sandbox payment status is invalid");
  }
  return value;
}

function positiveBigInt(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new UnauthorizedException(`Sandbox ${name} is invalid`);
  }
  return BigInt(value);
}

function currency(value: unknown): string {
  const normalized = requiredText(value, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new UnauthorizedException("Sandbox currency is invalid");
  }
  return normalized;
}

function timestamp(value: unknown): Date {
  const parsed = new Date(requiredText(value, "occurredAt", 50));
  if (Number.isNaN(parsed.getTime())) {
    throw new UnauthorizedException("Sandbox occurredAt is invalid");
  }
  return parsed;
}

export function sandboxEventSignature(body: unknown, secret: string): string {
  return `sha256=${createHmac("sha256", secret)
    .update(canonicalSandboxJson(body))
    .digest("hex")}`;
}

export function canonicalSandboxJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSandboxJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nested]) =>
          `${JSON.stringify(key)}:${canonicalSandboxJson(nested)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
