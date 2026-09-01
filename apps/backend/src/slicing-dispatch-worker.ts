import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import {
  readSlicingQueueConfig,
  type SlicingQueueConfig,
} from "./modules/slicing/slicing.config";
import { SlicingQueuePublisher } from "./modules/slicing/slicing-queue.publisher";

async function poll(
  publisher: SlicingQueuePublisher,
  config: SlicingQueueConfig,
  isStopping: () => boolean,
): Promise<void> {
  while (!isStopping()) {
    try {
      const delivered = await publisher.publishPending(config.claimLimit);
      const reconciled = await publisher.reconcileCompleted(config.claimLimit);
      if (delivered > 0)
        console.info(`published ${delivered} slicing dispatches`);
      if (reconciled > 0)
        console.info(`reconciled ${reconciled} slicing results`);
    } catch (error) {
      console.error(
        "slicing dispatch poll failed",
        error instanceof Error ? error.message : "unknown error",
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, config.pollMilliseconds),
    );
  }
}

async function main(): Promise<void> {
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });
  const publisher = application.get(SlicingQueuePublisher);
  const config: SlicingQueueConfig = readSlicingQueueConfig();
  let stopping = false;
  const shutdown = () => {
    stopping = true;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await poll(publisher, config, () => stopping);
  await application.close();
}

void main();
