export type WorkerConfig = {
  redisUrl: string;
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  engine: {
    executable: string;
    name: string;
    version: string;
    imageSha256: string;
    timeoutMilliseconds: number;
    runnerRoot: string;
  };
  limits: {
    sourceBytes: number;
    artifactBytes: number;
    diagnosticBytes: number;
  };
};

const DEFAULT_ORCA_IMAGE_SHA256 =
  "bd93c5e4f02ee51509351fa7bf005773a7abd257d768f83a626abf7a319f786f";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boolean(value: string | undefined, name: string): boolean {
  if (!value?.trim()) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function endpoint(value: string): string {
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("TAVEN_S3_ENDPOINT must be a bare HTTP or HTTPS URL");
  }
  return parsed.toString();
}

export function readWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const legacyRedis = `redis://${env.REDIS_HOST?.trim() || "127.0.0.1"}:${positiveInteger(env.REDIS_PORT, 6379, "REDIS_PORT")}`;
  return {
    redisUrl: env.TAVEN_REDIS_URL?.trim() || legacyRedis,
    storage: {
      endpoint: endpoint(required(env, "TAVEN_S3_ENDPOINT")),
      region: required(env, "TAVEN_S3_REGION"),
      bucket: required(env, "TAVEN_S3_BUCKET"),
      accessKeyId: required(env, "TAVEN_S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "TAVEN_S3_SECRET_ACCESS_KEY"),
      forcePathStyle: boolean(
        env.TAVEN_S3_FORCE_PATH_STYLE,
        "TAVEN_S3_FORCE_PATH_STYLE",
      ),
    },
    engine: {
      executable: env.TAVEN_ORCA_EXECUTABLE?.trim() || "/opt/orca/AppRun",
      name: "orcaslicer",
      version: env.TAVEN_ORCA_VERSION?.trim() || "2.4.2",
      imageSha256:
        env.TAVEN_ORCA_IMAGE_SHA256?.trim() || DEFAULT_ORCA_IMAGE_SHA256,
      timeoutMilliseconds: positiveInteger(
        env.TAVEN_ORCA_TIMEOUT_MILLISECONDS,
        15 * 60 * 1_000,
        "TAVEN_ORCA_TIMEOUT_MILLISECONDS",
      ),
      runnerRoot: required(env, "TAVEN_ORCA_RUNNER_ROOT"),
    },
    limits: {
      sourceBytes: positiveInteger(
        env.TAVEN_SLICER_MAX_SOURCE_BYTES,
        100 * 1024 * 1024,
        "TAVEN_SLICER_MAX_SOURCE_BYTES",
      ),
      artifactBytes: positiveInteger(
        env.TAVEN_SLICER_MAX_ARTIFACT_BYTES,
        512 * 1024 * 1024,
        "TAVEN_SLICER_MAX_ARTIFACT_BYTES",
      ),
      diagnosticBytes: positiveInteger(
        env.TAVEN_SLICER_MAX_DIAGNOSTIC_BYTES,
        1024 * 1024,
        "TAVEN_SLICER_MAX_DIAGNOSTIC_BYTES",
      ),
    },
  };
}
