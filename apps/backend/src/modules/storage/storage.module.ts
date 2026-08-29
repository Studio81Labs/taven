import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MinioObjectStorageAdapter } from "./minio-object-storage.adapter";
import { OBJECT_STORAGE } from "./object-storage.port";
import { RetentionService } from "./retention.service";
import {
  OBJECT_STORAGE_CONFIG,
  readObjectStorageConfig,
  type ObjectStorageConfig,
} from "./storage.config";
import { StorageController } from "./storage.controller";
import { UploadService } from "./upload.service";

@Module({
  imports: [PrismaModule],
  controllers: [StorageController],
  providers: [
    {
      provide: OBJECT_STORAGE_CONFIG,
      useFactory: (): ObjectStorageConfig => readObjectStorageConfig(),
    },
    {
      provide: OBJECT_STORAGE,
      inject: [OBJECT_STORAGE_CONFIG],
      useFactory: (config: ObjectStorageConfig) =>
        new MinioObjectStorageAdapter(config),
    },
    UploadService,
    RetentionService,
  ],
  exports: [OBJECT_STORAGE, UploadService, RetentionService],
})
export class StorageModule {}
