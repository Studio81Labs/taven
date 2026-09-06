import { createHash } from "node:crypto";

export type TavenEnvironment = "development" | "staging" | "production";

export type GithubLoginConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  completionUrl: string;
  attemptEncryptionKey: Buffer;
}>;

export type AdminAccessConfig = Readonly<{
  environment: TavenEnvironment;
  adminOrigins: readonly string[];
  csrfKey: Buffer;
  clientHashKey: Buffer;
  github: GithubLoginConfig | null;
}>;

const LOCAL_DEFAULT_ORIGINS = ["http://localhost:3002"];

export function readAdminAccessConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdminAccessConfig {
  const environment = readEnvironment(env);
  const openApi = env.TAVEN_OPENAPI_EXPORT === "true";
  const testMode = env.VITEST === "true" || env.NODE_ENV === "test";
  const adminOrigins = readOrigins(env.TAVEN_ADMIN_ORIGINS, environment);
  const csrfKey = readKey(
    env.TAVEN_ADMIN_CSRF_KEY,
    "TAVEN_ADMIN_CSRF_KEY",
    environment,
    openApi || testMode,
  );
  const clientHashKey = readKey(
    env.TAVEN_ADMIN_CLIENT_HASH_KEY,
    "TAVEN_ADMIN_CLIENT_HASH_KEY",
    environment,
    openApi || testMode,
  );

  return {
    environment,
    adminOrigins,
    csrfKey,
    clientHashKey,
    github:
      environment === "development"
        ? null
        : readGithubConfig(env, environment, openApi || testMode),
  };
}

function readEnvironment(env: NodeJS.ProcessEnv): TavenEnvironment {
  const value = env.TAVEN_ENVIRONMENT;
  if (
    value === "development" ||
    value === "staging" ||
    value === "production"
  ) {
    return value;
  }
  if (env.TAVEN_OPENAPI_EXPORT === "true" || env.VITEST === "true") {
    return "development";
  }
  throw new Error(
    "TAVEN_ENVIRONMENT must be development, staging, or production",
  );
}

function readOrigins(
  value: string | undefined,
  environment: TavenEnvironment,
): string[] {
  const origins = (
    value ??
    (environment === "development" ? LOCAL_DEFAULT_ORIGINS.join(",") : "")
  )
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error(
      "TAVEN_ADMIN_ORIGINS must contain at least one exact origin",
    );
  }
  return origins.map((origin) => {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error("TAVEN_ADMIN_ORIGINS must contain exact origins only");
    }
    return origin;
  });
}

function readGithubConfig(
  env: NodeJS.ProcessEnv,
  environment: Exclude<TavenEnvironment, "development">,
  allowPlaceholder: boolean,
): GithubLoginConfig {
  const clientId = required(
    env.TAVEN_GITHUB_APP_CLIENT_ID,
    "TAVEN_GITHUB_APP_CLIENT_ID",
    allowPlaceholder,
  );
  const clientSecret = required(
    env.TAVEN_GITHUB_APP_CLIENT_SECRET,
    "TAVEN_GITHUB_APP_CLIENT_SECRET",
    allowPlaceholder,
  );
  const callbackUrl = required(
    env.TAVEN_GITHUB_APP_CALLBACK_URL,
    "TAVEN_GITHUB_APP_CALLBACK_URL",
    allowPlaceholder,
  );
  const completionUrl = required(
    env.TAVEN_ADMIN_COMPLETION_URL,
    "TAVEN_ADMIN_COMPLETION_URL",
    allowPlaceholder,
  );
  assertHttpsUrl(
    callbackUrl,
    "TAVEN_GITHUB_APP_CALLBACK_URL",
    environment,
    allowPlaceholder,
  );
  assertHttpsUrl(
    completionUrl,
    "TAVEN_ADMIN_COMPLETION_URL",
    environment,
    allowPlaceholder,
  );
  return {
    clientId,
    clientSecret,
    callbackUrl,
    completionUrl,
    attemptEncryptionKey: readKey(
      env.TAVEN_GITHUB_LOGIN_ATTEMPT_ENCRYPTION_KEY,
      "TAVEN_GITHUB_LOGIN_ATTEMPT_ENCRYPTION_KEY",
      environment,
      allowPlaceholder,
    ),
  };
}

function required(
  value: string | undefined,
  name: string,
  allowPlaceholder: boolean,
): string {
  if (value?.trim()) return value.trim();
  if (allowPlaceholder) return `openapi-${name.toLowerCase()}`;
  throw new Error(`${name} is required outside development`);
}

function assertHttpsUrl(
  value: string,
  name: string,
  environment: Exclude<TavenEnvironment, "development">,
  allowPlaceholder: boolean,
): void {
  if (allowPlaceholder && value.startsWith("openapi-")) return;
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an exact HTTPS URL`);
  }
  if (environment === "production" && parsed.hostname === "localhost") {
    throw new Error(`${name} must not target localhost in production`);
  }
}

function readKey(
  value: string | undefined,
  name: string,
  environment: TavenEnvironment,
  allowPlaceholder: boolean,
): Buffer {
  if (!value?.trim()) {
    if (!allowPlaceholder && environment !== "development") {
      throw new Error(`${name} is required outside development`);
    }
    if (!allowPlaceholder && environment === "development") {
      throw new Error(`${name} is required in development`);
    }
    return createHash("sha256").update(`openapi:${name}`).digest();
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new Error(`${name} must be base64url`);
  }
  if (decoded.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes`);
  }
  return decoded;
}
