import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { MetricsRetentionService } from "./metrics-retention.service";
import { OperatorWarningsService } from "./operator-warnings.service";
import { MetricsReportController } from "./metrics-report.controller";
import { MetricsReportService } from "./metrics-report.service";

@Module({
  imports: [PrismaModule, AdminAccessModule],
  controllers: [MetricsReportController],
  providers: [
    MetricsRetentionService,
    MetricsReportService,
    OperatorWarningsService,
  ],
  exports: [MetricsRetentionService, MetricsReportService],
})
export class MetricsModule {}
