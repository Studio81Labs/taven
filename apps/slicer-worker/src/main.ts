import "dotenv/config";
import { Worker } from "bullmq";
import { SLICING_QUEUE_NAME } from "@taven/slicer-contracts";
import { runFixtureSlicingJob } from "./fixture-handler.js";

const worker = new Worker(
  SLICING_QUEUE_NAME,
  async (job) => runFixtureSlicingJob(job.data),
  {
    connection: {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
  },
);

worker.on("completed", (job) => {
  console.info(`fixture slicing job ${job.id ?? "unknown"} completed`);
});
worker.on("failed", (job, error) => {
  console.error(`fixture slicing job ${job?.id ?? "unknown"} failed`, error);
});

async function shutdown(): Promise<void> {
  await worker.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
