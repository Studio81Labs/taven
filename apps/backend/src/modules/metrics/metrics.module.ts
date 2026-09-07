import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MetricsRetentionService } from "./metrics-retention.service";

@Module({
  imports: [PrismaModule],
  providers: [MetricsRetentionService],
  exports: [MetricsRetentionService],
})
export class MetricsModule {}
