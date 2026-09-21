import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { MetricsRetentionService } from "./modules/metrics/metrics-retention.service";
import { RetentionService } from "./modules/storage/retention.service";
import { RetentionWorkerModule } from "./retention-worker.module";

const IDLE_POLL_MILLISECONDS = 5_000;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RetentionWorkerModule);
  const retention = app.get(RetentionService);
  const metricsRetention = app.get(MetricsRetentionService);
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    const [storageProcessed, metricsProcessed] = await Promise.all([
      retention.runOnce(),
      metricsRetention.runOnce(),
    ]);
    const processed = storageProcessed + metricsProcessed;
    if (processed === 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, IDLE_POLL_MILLISECONDS);
      });
    }
  }
  await app.close();
}

void main();
