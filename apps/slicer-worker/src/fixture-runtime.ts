import {
  LEGACY_V1_SLICING_QUEUE_NAME,
  SLICING_QUEUE_NAME,
} from "@taven/slicer-contracts";
import { runFixtureSlicingJob } from "./fixture-handler.js";
import { runLegacyV1FixtureSlicingJob } from "./legacy-v1-fixture-handler.js";

type FixtureProcessor = (input: unknown) => unknown;

export function createFixtureWorkers<T>(
  createWorker: (queueName: string, processor: FixtureProcessor) => T,
): [T, T] {
  return [
    createWorker(LEGACY_V1_SLICING_QUEUE_NAME, runLegacyV1FixtureSlicingJob),
    createWorker(SLICING_QUEUE_NAME, runFixtureSlicingJob),
  ];
}

export async function closeFixtureWorkers(
  workers: readonly { close: () => Promise<unknown> }[],
): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
}
