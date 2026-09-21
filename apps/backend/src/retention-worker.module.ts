import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { MetricsRetentionService } from "./modules/metrics/metrics-retention.service";
import { OBJECT_STORAGE } from "./modules/storage/object-storage.port";
import { S3ObjectStorageAdapter } from "./modules/storage/s3-object-storage.adapter";
import {
  OBJECT_STORAGE_CONFIG,
  readObjectStorageConfig,
  type ObjectStorageConfig,
} from "./modules/storage/storage.config";
import { RetentionService } from "./modules/storage/retention.service";

/**
 * Keep retention startup independent from request-time and slicing modules.
 * Those modules perform profile snapshot work during application bootstrap and
 * require application-level database and object-storage privileges.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: OBJECT_STORAGE_CONFIG,
      useFactory: (): ObjectStorageConfig => readObjectStorageConfig(),
    },
    {
      provide: OBJECT_STORAGE,
      inject: [OBJECT_STORAGE_CONFIG],
      useFactory: (config: ObjectStorageConfig) =>
        new S3ObjectStorageAdapter(config),
    },
    RetentionService,
    MetricsRetentionService,
  ],
})
export class RetentionWorkerModule {}
