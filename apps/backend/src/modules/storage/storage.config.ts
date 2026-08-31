export interface ObjectStorageConfig {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
  uploadClientHashKey: string;
}

export const OBJECT_STORAGE_CONFIG = Symbol("OBJECT_STORAGE_CONFIG");

const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;
const MIN_SIGNED_URL_TTL_SECONDS = 2;
const MIN_UPLOAD_CLIENT_HASH_KEY_LENGTH = 32;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for object storage`);
  return value;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseTtlSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_SIGNED_URL_TTL_SECONDS ||
    seconds > 7 * 24 * 60 * 60
  ) {
    throw new Error("TAVEN_S3_SIGNED_URL_TTL_SECONDS must be 2 through 604800");
  }
  return seconds;
}

function parseEndpoint(value: string, name: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(`${name} must be a bare HTTP(S) endpoint URL`);
  }
  return endpoint.toString();
}

export function readObjectStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorageConfig {
  const endpoint = parseEndpoint(
    required(env, "TAVEN_S3_ENDPOINT"),
    "TAVEN_S3_ENDPOINT",
  );
  const publicEndpoint = parseEndpoint(
    env.TAVEN_S3_PUBLIC_ENDPOINT?.trim() || endpoint,
    "TAVEN_S3_PUBLIC_ENDPOINT",
  );

  const bucket = required(env, "TAVEN_S3_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("TAVEN_S3_BUCKET must be a valid bucket name");
  }

  const uploadClientHashKey = required(env, "TAVEN_UPLOAD_CLIENT_HASH_KEY");
  if (uploadClientHashKey.length < MIN_UPLOAD_CLIENT_HASH_KEY_LENGTH) {
    throw new Error(
      `TAVEN_UPLOAD_CLIENT_HASH_KEY must be at least ${MIN_UPLOAD_CLIENT_HASH_KEY_LENGTH} characters`,
    );
  }

  return {
    endpoint,
    publicEndpoint,
    region: required(env, "TAVEN_S3_REGION"),
    bucket,
    accessKeyId: required(env, "TAVEN_S3_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "TAVEN_S3_SECRET_ACCESS_KEY"),
    forcePathStyle: parseBoolean(
      env.TAVEN_S3_FORCE_PATH_STYLE,
      "TAVEN_S3_FORCE_PATH_STYLE",
    ),
    signedUrlTtlSeconds: parseTtlSeconds(env.TAVEN_S3_SIGNED_URL_TTL_SECONDS),
    uploadClientHashKey,
  };
}
