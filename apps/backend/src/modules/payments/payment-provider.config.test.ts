import { describe, expect, it } from "vitest";
import { readPaymentProviderConfig } from "./payment-provider.config";

describe("payment provider configuration", () => {
  it("does not require provider settings while checkout is disabled", () => {
    expect(
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED: "false",
      }),
    ).toEqual({ provider: "disabled" });
    expect(readPaymentProviderConfig({})).toEqual({ provider: "disabled" });
  });

  it("uses the explicitly selected deterministic sandbox outside production", () => {
    expect(
      readPaymentProviderConfig({ TAVEN_PAYMENT_PROVIDER: "sandbox" }),
    ).toEqual({
      provider: "sandbox",
      publicBaseUrl: "http://localhost:3001",
      webhookSigningSecret: "local-only-payment-sandbox-secret-32",
    });
  });

  it("fails closed when enabled checkout does not select a provider", () => {
    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED: "true",
      }),
    ).toThrow("TAVEN_PAYMENT_PROVIDER is required");
    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_PAYMENT_PROVIDER: "sandbox",
      }),
    ).toThrow("Production sandbox requires an explicit public URL");
  });

  it("requires Comgate credentials and HTTPS", () => {
    expect(() =>
      readPaymentProviderConfig({ TAVEN_PAYMENT_PROVIDER: "comgate" }),
    ).toThrow("TAVEN_COMGATE_MERCHANT_ID is required");
    expect(() =>
      readPaymentProviderConfig({
        TAVEN_PAYMENT_PROVIDER: "comgate",
        TAVEN_COMGATE_MERCHANT_ID: "merchant",
        TAVEN_COMGATE_SECRET: "secret",
        TAVEN_COMGATE_TEST_MODE: "true",
        TAVEN_COMGATE_API_BASE_URL: "http://example.test",
      }),
    ).toThrow("must use HTTPS");
  });
});
