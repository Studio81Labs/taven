export interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
}

export const OBJECT_STORAGE_CONFIG = Symbol("OBJECT_STORAGE_CONFIG");

const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;

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
    seconds < 1 ||
    seconds > 7 * 24 * 60 * 60
  ) {
    throw new Error("TAVEN_S3_SIGNED_URL_TTL_SECONDS must be 1 through 604800");
  }
  return seconds;
}

export function readObjectStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorageConfig {
  const endpoint = required(env, "TAVEN_S3_ENDPOINT");
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("TAVEN_S3_ENDPOINT must be an absolute HTTP(S) URL");
  }
  if (
    (parsedEndpoint.protocol !== "http:" &&
      parsedEndpoint.protocol !== "https:") ||
    parsedEndpoint.username ||
    parsedEndpoint.password ||
    parsedEndpoint.pathname !== "/" ||
    parsedEndpoint.search ||
    parsedEndpoint.hash
  ) {
    throw new Error("TAVEN_S3_ENDPOINT must be a bare HTTP(S) endpoint URL");
  }

  const bucket = required(env, "TAVEN_S3_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("TAVEN_S3_BUCKET must be a valid bucket name");
  }

  return {
    endpoint: parsedEndpoint.toString(),
    region: required(env, "TAVEN_S3_REGION"),
    bucket,
    accessKeyId: required(env, "TAVEN_S3_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "TAVEN_S3_SECRET_ACCESS_KEY"),
    forcePathStyle: parseBoolean(
      env.TAVEN_S3_FORCE_PATH_STYLE,
      "TAVEN_S3_FORCE_PATH_STYLE",
    ),
    signedUrlTtlSeconds: parseTtlSeconds(env.TAVEN_S3_SIGNED_URL_TTL_SECONDS),
  };
}
