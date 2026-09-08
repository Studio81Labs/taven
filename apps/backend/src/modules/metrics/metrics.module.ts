import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { MetricsRetentionService } from "./metrics-retention.service";
import { MetricsReportController } from "./metrics-report.controller";
import { MetricsReportService } from "./metrics-report.service";

@Module({
  imports: [PrismaModule, AdminAccessModule],
  controllers: [MetricsReportController],
  providers: [MetricsRetentionService, MetricsReportService],
  exports: [MetricsRetentionService, MetricsReportService],
})
export class MetricsModule {}
