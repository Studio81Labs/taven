import { CHECKOUT_PAYMENT_FLOWS_ENV } from "../../launch-approval-gates";

export type PaymentProviderConfig =
  | Readonly<{ provider: "disabled" }>
  | Readonly<{
      provider: "sandbox";
      publicBaseUrl: string;
      webhookSigningSecret: string;
    }>
  | Readonly<{
      provider: "comgate";
      merchantId: string;
      secret: string;
      testMode: boolean;
      apiBaseUrl: string;
    }>;

export const PAYMENT_PROVIDER_CONFIG = Symbol("PAYMENT_PROVIDER_CONFIG");

const DEFAULT_SANDBOX_SECRET = "local-only-payment-sandbox-secret-32";

export function readPaymentProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaymentProviderConfig {
  const provider = env.TAVEN_PAYMENT_PROVIDER?.trim().toLowerCase();
  if (!provider) {
    if (env[CHECKOUT_PAYMENT_FLOWS_ENV] !== "true") {
      return { provider: "disabled" };
    }
    throw new Error(
      "TAVEN_PAYMENT_PROVIDER is required when checkout payments are enabled",
    );
  }
  if (provider === "sandbox") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "TAVEN_PAYMENT_PROVIDER=sandbox is unavailable in production",
      );
    }
    const sandboxPublicUrl = env.TAVEN_PAYMENT_SANDBOX_PUBLIC_URL?.trim();
    const sandboxSecret = env.TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET?.trim();
    const publicBaseUrl = absoluteHttpUrl(
      sandboxPublicUrl || "http://localhost:3001",
      "TAVEN_PAYMENT_SANDBOX_PUBLIC_URL",
    );
    const webhookSigningSecret = sandboxSecret || DEFAULT_SANDBOX_SECRET;
    if (webhookSigningSecret.length < 32) {
      throw new Error(
        "TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET must be at least 32 characters",
      );
    }
    return { provider: "sandbox", publicBaseUrl, webhookSigningSecret };
  }
  if (provider !== "comgate") {
    throw new Error("TAVEN_PAYMENT_PROVIDER must be sandbox or comgate");
  }
  const testMode = parseBoolean(
    env.TAVEN_COMGATE_TEST_MODE,
    true,
    env.NODE_ENV === "production",
  );
  if (env.NODE_ENV === "production" && testMode) {
    throw new Error(
      "TAVEN_COMGATE_TEST_MODE=true is unavailable in production",
    );
  }
  return {
    provider,
    merchantId: required(env, "TAVEN_COMGATE_MERCHANT_ID"),
    secret: required(env, "TAVEN_COMGATE_SECRET"),
    testMode,
    apiBaseUrl: absoluteHttpsUrl(
      env.TAVEN_COMGATE_API_BASE_URL?.trim() ||
        "https://payments.comgate.cz/v2.0",
      "TAVEN_COMGATE_API_BASE_URL",
    ),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the payment provider`);
  return value;
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
  required = false,
): boolean {
  if (value === undefined || value.trim() === "") {
    if (required) {
      throw new Error("TAVEN_COMGATE_TEST_MODE is required in production");
    }
    return defaultValue;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("TAVEN_COMGATE_TEST_MODE must be true or false");
}

function absoluteHttpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function absoluteHttpsUrl(value: string, name: string): string {
  const normalized = absoluteHttpUrl(value, name);
  if (!normalized.startsWith("https://")) {
    throw new Error(`${name} must use HTTPS`);
  }
  return normalized;
}
