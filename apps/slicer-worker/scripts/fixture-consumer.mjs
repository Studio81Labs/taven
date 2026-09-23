// Test-only BullMQ consumer for the isolated browser -> real API journey.
import { Worker } from "bullmq";
import {
  closeFixtureWorkers,
  createFixtureWorkers,
  redisConnection,
} from "../dist/fixture-runtime.js";

const redisUrl = process.env.TAVEN_REDIS_URL;
if (!redisUrl || process.env.TAVEN_ENVIRONMENT !== "development") {
  throw new Error("Fixture consumer requires a development Redis URL");
}
const { hostname } = new URL(redisUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
  throw new Error("Fixture consumer may only connect to local Redis");
}

const connection = redisConnection(redisUrl);
const workers = createFixtureWorkers(
  (queueName, processor) =>
    new Worker(queueName, (job) => processor(job.data), {
      connection,
      concurrency: 1,
    }),
);

for (const worker of workers) {
  worker.on("failed", (job, error) => {
    console.error(`fixture slicing ${job?.id ?? "unknown"} failed`, error);
  });
}

await Promise.all(workers.map((worker) => worker.waitUntilReady()));
console.info("isolated fixture slicing ready");

async function shutdown() {
  await closeFixtureWorkers(workers);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
