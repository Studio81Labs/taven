import { Module } from "@nestjs/common";
import type { Queue } from "bullmq";
import { PrismaModule } from "../../prisma/prisma.module";
import { ResourcesModule } from "../resources/resources.module";
import { StorageModule } from "../storage/storage.module";
import { SlicerProfileSnapshotsModule } from "./slicer-profile-snapshots.module";
import {
  readSlicingQueueConfig,
  type SlicingQueueConfig,
} from "./slicing.config";
import { SlicingQueuePublisher } from "./slicing-queue.publisher";
import { SlicingResultIngestionService } from "./slicing-result-ingestion.service";
import { SLICING_QUEUE, SLICING_QUEUE_CONFIG } from "./slicing.tokens";

@Module({
  imports: [
    PrismaModule,
    ResourcesModule,
    SlicerProfileSnapshotsModule,
    StorageModule,
  ],
  providers: [
    {
      provide: SLICING_QUEUE_CONFIG,
      useFactory: (): SlicingQueueConfig => readSlicingQueueConfig(),
    },
    {
      provide: SLICING_QUEUE,
      inject: [SLICING_QUEUE_CONFIG],
      useFactory: async (config: SlicingQueueConfig) => {
        if (process.env.TAVEN_OPENAPI_EXPORT === "true") {
          return { close: async () => undefined } as Queue;
        }
        const { Queue } = await import("bullmq");
        const { SLICING_QUEUE_NAME } = await import("@taven/slicer-contracts");
        return new Queue(SLICING_QUEUE_NAME, { connection: config.connection });
      },
    },
    SlicingResultIngestionService,
    SlicingQueuePublisher,
  ],
  exports: [SlicingQueuePublisher],
})
export class SlicingModule {}
