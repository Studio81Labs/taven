import { CHECKOUT_PAYMENT_FLOWS_ENV } from "../../launch-approval-gates";
import { isIP } from "node:net";

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
type DeploymentEnvironment = "development" | "staging" | "production";

export function readPaymentProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaymentProviderConfig {
  const deploymentEnvironment = readDeploymentEnvironment(env);
  const production = deploymentEnvironment === "production";
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
    if (production) {
      throw new Error(
        "TAVEN_PAYMENT_PROVIDER=sandbox is unavailable in production",
      );
    }
    const sandboxPublicUrl = env.TAVEN_PAYMENT_SANDBOX_PUBLIC_URL?.trim();
    const sandboxSecret = env.TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET?.trim();
    if (deploymentEnvironment === "staging" && !sandboxPublicUrl) {
      throw new Error(
        "TAVEN_PAYMENT_SANDBOX_PUBLIC_URL is required in staging",
      );
    }
    const publicBaseUrl = absoluteHttpUrl(
      sandboxPublicUrl || "http://localhost:3001",
      "TAVEN_PAYMENT_SANDBOX_PUBLIC_URL",
    );
    if (
      deploymentEnvironment === "staging" &&
      !isPublicStagingSandboxUrl(publicBaseUrl, env.TAVEN_API_PUBLIC_URL)
    ) {
      throw new Error(
        "TAVEN_PAYMENT_SANDBOX_PUBLIC_URL must be the public HTTPS staging API origin",
      );
    }
    if (deploymentEnvironment === "staging" && !sandboxSecret) {
      throw new Error(
        "TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET is required in staging",
      );
    }
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
  const testMode = parseBoolean(env.TAVEN_COMGATE_TEST_MODE, true, production);
  if (production && testMode) {
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

/**
 * The image is built with NODE_ENV=production in staging as well as in
 * production. TAVEN_ENVIRONMENT is the deployment boundary and therefore
 * determines whether sandbox payment settings are forbidden. Keep the
 * NODE_ENV fallback for callers that do not provide the deployment identity,
 * but never treat an unknown identity as a safe non-production target.
 */
function readDeploymentEnvironment(
  env: NodeJS.ProcessEnv,
): DeploymentEnvironment {
  const configured = env.TAVEN_ENVIRONMENT;
  if (configured === "development" || configured === "staging") {
    return configured;
  }
  if (configured === "production") return configured;
  if (configured !== undefined && configured !== "") {
    throw new Error(
      "TAVEN_ENVIRONMENT must be exactly development, staging, or production",
    );
  }
  return env.NODE_ENV === "production" ? "production" : "development";
}

function isPublicStagingSandboxUrl(
  sandboxUrl: string,
  apiUrlValue: string | undefined,
): boolean {
  if (!apiUrlValue?.trim()) return false;
  let apiUrl: URL;
  let sandboxOrigin: URL;
  try {
    apiUrl = new URL(apiUrlValue.trim());
    sandboxOrigin = new URL(sandboxUrl);
  } catch {
    return false;
  }
  return (
    apiUrl.protocol === "https:" &&
    isBareOrigin(apiUrl) &&
    isBareOrigin(sandboxOrigin) &&
    apiUrl.origin === sandboxOrigin.origin &&
    isPublicHostname(apiUrl.hostname)
  );
}

function isBareOrigin(url: URL): boolean {
  return (
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, "");
  const labels = normalized.split(".");
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const ipVersion = isIP(normalized);
  if (
    (ipVersion === 0 &&
      (normalized.length > 253 ||
        labels.length < 2 ||
        labels.some((label) => !validLabel.test(label)))) ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".example") ||
    normalized === "example.com" ||
    normalized.endsWith(".example.com") ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  ) {
    return false;
  }
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    const value = octets.reduce((result, octet) => result * 256 + octet, 0);
    return !(
      [
        [0x00000000, 0x00ffffff], // "this" network
        [0x0a000000, 0x0affffff], // private use
        [0x64400000, 0x647fffff], // shared address space
        [0x7f000000, 0x7fffffff], // loopback
        [0xa9fe0000, 0xa9feffff], // link-local
        [0xac100000, 0xac1fffff], // private use
        [0xc0000000, 0xc00000ff], // protocol assignments
        [0xc0000200, 0xc00002ff], // documentation
        [0xc0a80000, 0xc0a8ffff], // private use
        [0xc6120000, 0xc613ffff], // benchmarking
        [0xc6336400, 0xc63364ff], // documentation
        [0xcb007100, 0xcb0071ff], // documentation
        [0xe0000000, 0xffffffff], // multicast and reserved
      ] as const
    ).some(([start, end]) => value >= start && value <= end);
  }
  if (ipVersion === 6) {
    return !normalized.startsWith("fc") && !normalized.startsWith("fd");
  }
  return true;
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
