export type SlicingQueueConfig = {
  connection: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    tls?: Record<string, never>;
    maxRetriesPerRequest: null;
  };
  pollMilliseconds: number;
  claimLimit: number;
};

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum?: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive integer`
        : `${name} must be an integer from 1 through ${maximum}`,
    );
  }
  return parsed;
}

export function readSlicingQueueConfig(
  env: NodeJS.ProcessEnv = process.env,
): SlicingQueueConfig {
  const value = env.TAVEN_REDIS_URL?.trim();
  if (!value)
    throw new Error("TAVEN_REDIS_URL is required for slicing dispatch");
  const parsed = new URL(value);
  if (
    !["redis:", "rediss:"].includes(parsed.protocol) ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("TAVEN_REDIS_URL must be a root Redis URL");
  }
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "rediss:"
      ? 6380
      : 6379;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TAVEN_REDIS_URL contains an invalid port");
  }
  return {
    connection: {
      host: parsed.hostname,
      port,
      ...(parsed.username
        ? { username: decodeURIComponent(parsed.username) }
        : {}),
      ...(parsed.password
        ? { password: decodeURIComponent(parsed.password) }
        : {}),
      ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
    },
    pollMilliseconds: positiveInteger(
      env.TAVEN_SLICING_DISPATCH_POLL_MILLISECONDS,
      1_000,
      "TAVEN_SLICING_DISPATCH_POLL_MILLISECONDS",
    ),
    claimLimit: positiveInteger(
      env.TAVEN_SLICING_DISPATCH_CLAIM_LIMIT,
      25,
      "TAVEN_SLICING_DISPATCH_CLAIM_LIMIT",
      100,
    ),
  };
}
