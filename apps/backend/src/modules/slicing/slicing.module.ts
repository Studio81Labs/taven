import { Module } from "@nestjs/common";
import { Queue } from "bullmq";
import { PrismaModule } from "../../prisma/prisma.module";
import { ResourcesModule } from "../resources/resources.module";
import {
  readSlicingQueueConfig,
  type SlicingQueueConfig,
} from "./slicing.config";
import { SlicingQueuePublisher } from "./slicing-queue.publisher";
import { SlicingResultIngestionService } from "./slicing-result-ingestion.service";
import { SLICING_QUEUE, SLICING_QUEUE_CONFIG } from "./slicing.tokens";

@Module({
  imports: [PrismaModule, ResourcesModule],
  providers: [
    {
      provide: SLICING_QUEUE_CONFIG,
      useFactory: (): SlicingQueueConfig => readSlicingQueueConfig(),
    },
    {
      provide: SLICING_QUEUE,
      inject: [SLICING_QUEUE_CONFIG],
      useFactory: async (config: SlicingQueueConfig) => {
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
