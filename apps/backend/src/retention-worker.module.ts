import { Module } from "@nestjs/common";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { StorageModule } from "./modules/storage/storage.module";

/**
 * Keep retention startup independent from request-time and slicing modules.
 * Those modules perform profile snapshot work during application bootstrap and
 * require application-level database and object-storage privileges.
 */
@Module({
  imports: [StorageModule, MetricsModule],
})
export class RetentionWorkerModule {}
