import { Module } from "@nestjs/common";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { OrdersModule } from "../orders/orders.module";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { OperatorJobArtifactsService } from "./operator-job-artifacts.service";
import { OperatorReadsController } from "./operator-reads.controller";
import { OperatorReadsService } from "./operator-reads.service";

@Module({
  imports: [
    PrismaModule,
    AdminAccessModule,
    OrdersModule,
    AuditModule,
    StorageModule,
  ],
  controllers: [OperatorReadsController],
  providers: [OperatorReadsService, OperatorJobArtifactsService],
})
export class OperatorReadsModule {}
