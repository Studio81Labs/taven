import { SLICING_QUEUE_NAME } from "@taven/slicer-contracts";
import { runFixtureSlicingJob } from "./fixture-handler.js";

type FixtureProcessor = (input: unknown) => unknown;

export function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  if (
    !["redis:", "rediss:"].includes(parsed.protocol) ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
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
  };
}

export function createSlicingWorkers<T>(
  createWorker: (queueName: string, processor: FixtureProcessor) => T,
  currentProcessor: FixtureProcessor,
): [T] {
  return [createWorker(SLICING_QUEUE_NAME, currentProcessor)];
}

export function createFixtureWorkers<T>(
  createWorker: (queueName: string, processor: FixtureProcessor) => T,
): [T] {
  return createSlicingWorkers(createWorker, runFixtureSlicingJob);
}

export async function closeSlicingWorkers(
  workers: readonly { close: () => Promise<unknown> }[],
): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
}

export const closeFixtureWorkers = closeSlicingWorkers;
