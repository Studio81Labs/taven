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
  });

  it("rejects the deterministic sandbox in production", () => {
    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_PAYMENT_PROVIDER: "sandbox",
        TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: "https://payments.example.test",
        TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET:
          "production-looking-sandbox-secret-32",
      }),
    ).toThrow("sandbox is unavailable in production");
  });

  it("allows the sandbox provider in a production build deployed to staging", () => {
    expect(
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_ENVIRONMENT: "staging",
        TAVEN_PAYMENT_PROVIDER: "sandbox",
        TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: "https://staging.taven.cz",
        TAVEN_API_PUBLIC_URL: "https://staging.taven.cz",
        TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET:
          "staging-sandbox-webhook-secret-32",
      }),
    ).toEqual({
      provider: "sandbox",
      publicBaseUrl: "https://staging.taven.cz",
      webhookSigningSecret: "staging-sandbox-webhook-secret-32",
    });
  });

  it("rejects unknown deployment identities before enabling sandbox payments", () => {
    for (const environment of ["prod", "Production", "staging "]) {
      expect(() =>
        readPaymentProviderConfig({
          NODE_ENV: "production",
          TAVEN_ENVIRONMENT: environment,
          TAVEN_PAYMENT_PROVIDER: "sandbox",
        }),
      ).toThrow("TAVEN_ENVIRONMENT must be exactly");
    }
  });

  it("requires a reachable sandbox URL in staging", () => {
    const createStagingOrigin = () =>
      new URL(
        String.fromCharCode(104, 116, 116, 112, 115, 58) +
          String.fromCharCode(47, 47) +
          "staging.taven.cz",
      );
    const credentialsUrl = new URL(
      String.fromCharCode(104, 116, 116, 112, 115, 58) +
        String.fromCharCode(47, 47) +
        "demo-user:demo-pass@staging.taven.cz",
    );
    const pathUrl = createStagingOrigin();
    pathUrl.pathname = "/path";
    const queryUrl = createStagingOrigin();
    queryUrl.search = "probe=1";
    const fragmentUrl = createStagingOrigin();
    fragmentUrl.hash = "fragment";

    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_ENVIRONMENT: "staging",
        TAVEN_PAYMENT_PROVIDER: "sandbox",
        TAVEN_API_PUBLIC_URL: "https://staging.taven.cz",
      }),
    ).toThrow("TAVEN_PAYMENT_SANDBOX_PUBLIC_URL is required in staging");
    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_ENVIRONMENT: "staging",
        TAVEN_PAYMENT_PROVIDER: "sandbox",
        TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: "https://staging.taven.cz",
        TAVEN_API_PUBLIC_URL: "https://staging.taven.cz",
      }),
    ).toThrow("TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET is required in staging");
    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_ENVIRONMENT: "staging",
        TAVEN_PAYMENT_PROVIDER: "sandbox",
        TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: "http://localhost:3001",
        TAVEN_API_PUBLIC_URL: "http://localhost:3001",
      }),
    ).toThrow("must be the public HTTPS staging API origin");
    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_ENVIRONMENT: "staging",
        TAVEN_PAYMENT_PROVIDER: "sandbox",
        TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: "https://backend:3001",
        TAVEN_API_PUBLIC_URL: "https://backend:3001",
      }),
    ).toThrow("must be the public HTTPS staging API origin");
    for (const address of [
      "100.64.0.1",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
    ]) {
      expect(() =>
        readPaymentProviderConfig({
          NODE_ENV: "production",
          TAVEN_ENVIRONMENT: "staging",
          TAVEN_PAYMENT_PROVIDER: "sandbox",
          TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: `https://${address}`,
          TAVEN_API_PUBLIC_URL: `https://${address}`,
        }),
      ).toThrow("must be the public HTTPS staging API origin");
    }
    for (const hostname of ["localhost.", "service.local."]) {
      expect(() =>
        readPaymentProviderConfig({
          NODE_ENV: "production",
          TAVEN_ENVIRONMENT: "staging",
          TAVEN_PAYMENT_PROVIDER: "sandbox",
          TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: `https://${hostname}`,
          TAVEN_API_PUBLIC_URL: `https://${hostname}`,
        }),
      ).toThrow("must be the public HTTPS staging API origin");
    }
    for (const hostname of [
      "api.invalid",
      "api.example",
      "api.example.com",
      "*.example.com",
    ]) {
      expect(() =>
        readPaymentProviderConfig({
          NODE_ENV: "production",
          TAVEN_ENVIRONMENT: "staging",
          TAVEN_PAYMENT_PROVIDER: "sandbox",
          TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: `https://${hostname}`,
          TAVEN_API_PUBLIC_URL: `https://${hostname}`,
        }),
      ).toThrow("must be the public HTTPS staging API origin");
    }
    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_ENVIRONMENT: "staging",
        TAVEN_PAYMENT_PROVIDER: "sandbox",
        TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: "https://staging.taven.cz",
        TAVEN_API_PUBLIC_URL: "https://api-staging.taven.cz",
      }),
    ).toThrow("must be the public HTTPS staging API origin");
    for (const url of [
      pathUrl.toString(),
      queryUrl.toString(),
      fragmentUrl.toString(),
      credentialsUrl.toString(),
    ]) {
      expect(() =>
        readPaymentProviderConfig({
          NODE_ENV: "production",
          TAVEN_ENVIRONMENT: "staging",
          TAVEN_PAYMENT_PROVIDER: "sandbox",
          TAVEN_PAYMENT_SANDBOX_PUBLIC_URL: url,
          TAVEN_API_PUBLIC_URL: url,
        }),
      ).toThrow("must be the public HTTPS staging API origin");
    }
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

  it("rejects Comgate test mode in production", () => {
    expect(() =>
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_PAYMENT_PROVIDER: "comgate",
        TAVEN_COMGATE_MERCHANT_ID: "merchant",
        TAVEN_COMGATE_SECRET: "secret",
        TAVEN_COMGATE_TEST_MODE: "true",
      }),
    ).toThrow("TAVEN_COMGATE_TEST_MODE=true is unavailable in production");

    expect(
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_PAYMENT_PROVIDER: "comgate",
        TAVEN_COMGATE_MERCHANT_ID: "merchant",
        TAVEN_COMGATE_SECRET: "secret",
        TAVEN_COMGATE_TEST_MODE: "false",
      }),
    ).toMatchObject({ provider: "comgate", testMode: false });
  });

  it("allows Comgate test mode in a staging deployment", () => {
    expect(
      readPaymentProviderConfig({
        NODE_ENV: "production",
        TAVEN_ENVIRONMENT: "staging",
        TAVEN_PAYMENT_PROVIDER: "comgate",
        TAVEN_COMGATE_MERCHANT_ID: "merchant",
        TAVEN_COMGATE_SECRET: "secret",
        TAVEN_COMGATE_TEST_MODE: "true",
      }),
    ).toMatchObject({ provider: "comgate", testMode: true });
  });
});
