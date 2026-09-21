import { Module } from "@nestjs/common";
import type { Queue } from "bullmq";
import { PrismaModule } from "./prisma/prisma.module";
import { CandidateEstimateService } from "./modules/resources/candidate-estimate.service";
import { OBJECT_STORAGE } from "./modules/storage/object-storage.port";
import { S3ObjectStorageAdapter } from "./modules/storage/s3-object-storage.adapter";
import {
  OBJECT_STORAGE_CONFIG,
  readWorkerObjectStorageConfig,
  type ObjectStorageConfig,
} from "./modules/storage/storage.config";
import { SlicerProfileSnapshotService } from "./modules/slicing/slicer-profile-snapshot.service";
import {
  readSlicingQueueConfig,
  type SlicingQueueConfig,
} from "./modules/slicing/slicing.config";
import { SlicingQueuePublisher } from "./modules/slicing/slicing-queue.publisher";
import { SlicingResultIngestionService } from "./modules/slicing/slicing-result-ingestion.service";
import {
  SLICING_QUEUE,
  SLICING_QUEUE_CONFIG,
} from "./modules/slicing/slicing.tokens";

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: OBJECT_STORAGE_CONFIG,
      useFactory: (): ObjectStorageConfig => readWorkerObjectStorageConfig(),
    },
    {
      provide: OBJECT_STORAGE,
      inject: [OBJECT_STORAGE_CONFIG],
      useFactory: (config: ObjectStorageConfig) =>
        new S3ObjectStorageAdapter(config),
    },
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
    SlicerProfileSnapshotService,
    CandidateEstimateService,
    SlicingResultIngestionService,
    SlicingQueuePublisher,
  ],
  exports: [SlicingQueuePublisher],
})
export class SlicingDispatchWorkerModule {}
