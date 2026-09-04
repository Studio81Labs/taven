import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SandboxPaymentProviderAdapter } from "./sandbox-payment-provider.adapter";

const secret = "test-sandbox-webhook-signing-secret-32";

describe("SandboxPaymentProviderAdapter", () => {
  const adapter = new SandboxPaymentProviderAdapter({
    provider: "sandbox",
    publicBaseUrl: "http://localhost:3001",
    webhookSigningSecret: secret,
  });

  it("creates a deterministic provider intent with both checkout methods", async () => {
    expect(adapter.capabilities()).toEqual({
      provider: "sandbox",
      methods: ["CARD", "BANK_TRANSFER"],
    });
    await expect(
      adapter.createIntent({
        paymentId: "00000000-0000-4000-8000-000000000001",
        orderReference: "TAV-1",
        amountMinor: 12_300n,
        currency: "CZK",
        method: "CARD",
        email: "customer@example.test",
        fullName: "Customer",
        expiresAt: new Date("2026-09-04T12:00:00Z"),
        returnUrls: {
          success: "https://taven.cz/success",
          cancelled: "https://taven.cz/cancelled",
          pending: "https://taven.cz/pending",
        },
      }),
    ).resolves.toEqual({
      providerIntentId: "sandbox-00000000-0000-4000-8000-000000000001",
      checkoutUrl:
        "http://localhost:3001/payments/sandbox/sandbox-00000000-0000-4000-8000-000000000001",
    });
  });

  it("accepts only correctly signed, bounded normalized evidence", async () => {
    const body = {
      providerEventId: "event-1",
      providerTransactionId: "sandbox-payment-1",
      status: "CAPTURED",
      amountMinor: "12300",
      currency: "CZK",
      occurredAt: "2026-09-04T10:00:00.000Z",
    };
    const signature = createHmac("sha256", secret)
      .update(canonicalJson(body))
      .digest("hex");
    await expect(
      adapter.verifyEvent({
        headers: { "x-taven-sandbox-signature": `sha256=${signature}` },
        body,
      }),
    ).resolves.toMatchObject({
      provider: "sandbox",
      providerEventId: "event-1",
      status: "CAPTURED",
      amountMinor: 12_300n,
    });
    await expect(
      adapter.verifyEvent({
        headers: { "x-taven-sandbox-signature": "sha256=00" },
        body,
      }),
    ).rejects.toThrow("signature is invalid");
  });
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
