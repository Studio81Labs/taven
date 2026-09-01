import "dotenv/config";
import { Worker } from "bullmq";
import { readWorkerConfig } from "./config.js";
import { runLegacyV1FixtureSlicingJob } from "./legacy-v1-fixture-handler.js";
import { S3WorkerObjectStore } from "./object-store.js";
import { OrcaSidecarEngine } from "./orca-engine.js";
import { SlicingProcessor } from "./processor.js";
import { processWithRetryableProgress } from "./retry-progress.js";
import {
  closeSlicingWorkers,
  createSlicingWorkers,
  redisConnection,
} from "./fixture-runtime.js";

const config = readWorkerConfig();
const store = new S3WorkerObjectStore(config.storage);
const engineConfig = {
  ...config.engine,
  maximumArtifactBytes: config.limits.artifactBytes,
  maximumDiagnosticBytes: config.limits.diagnosticBytes,
};
const engine = new OrcaSidecarEngine(engineConfig, config.engine.runnerRoot);
const processor = new SlicingProcessor(store, engine, config);
const connection = redisConnection(config.redisUrl);

const workers = createSlicingWorkers(
  (queueName, process) =>
    new Worker(
      queueName,
      async (job) =>
        processWithRetryableProgress(
          job.data,
          job.attemptsMade + 1,
          (progress) => job.updateProgress(progress),
          process,
        ),
      {
        connection,
        concurrency: 1,
        lockDuration: config.engine.timeoutMilliseconds + 60_000,
        maxStalledCount: 1,
      },
    ),
  runLegacyV1FixtureSlicingJob,
  (input) => processor.process(input),
);

for (const worker of workers) {
  worker.on("completed", (job) => {
    console.info(
      `slicing job ${job.id ?? "unknown"} completed on ${worker.name}`,
    );
  });
  worker.on("failed", (job, error) => {
    console.error(
      `slicing job ${job?.id ?? "unknown"} failed on ${worker.name}`,
      error,
    );
  });
}

async function shutdown(): Promise<void> {
  await closeSlicingWorkers(workers);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
