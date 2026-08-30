import "dotenv/config";
import { Worker } from "bullmq";
import {
  closeFixtureWorkers,
  createFixtureWorkers,
} from "./fixture-runtime.js";

const connection = {
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.REDIS_PORT ?? 6379),
};

const workers = createFixtureWorkers(
  (queueName, processor) =>
    new Worker(queueName, async (job) => processor(job.data), { connection }),
);

for (const worker of workers) {
  worker.on("completed", (job) => {
    console.info(
      `fixture slicing job ${job.id ?? "unknown"} completed on ${worker.name}`,
    );
  });
  worker.on("failed", (job, error) => {
    console.error(
      `fixture slicing job ${job?.id ?? "unknown"} failed on ${worker.name}`,
      error,
    );
  });
}

async function shutdown(): Promise<void> {
  await closeFixtureWorkers(workers);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
