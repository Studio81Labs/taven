import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { AuditModule } from "../audit/audit.module";
import { PaymentsModule } from "../payments/payments.module";
import { ResourcesModule } from "../resources/resources.module";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { RecoveryCandidateController } from "./recovery-candidate.controller";
import { RecoveryCandidatePreparationService } from "./recovery-candidate-preparation.service";

@Module({
  imports: [
    PrismaModule,
    AdminAccessModule,
    AuditModule,
    PaymentsModule,
    ResourcesModule,
  ],
  controllers: [OrdersController, RecoveryCandidateController],
  providers: [OrdersService, RecoveryCandidatePreparationService],
  exports: [OrdersService],
})
export class OrdersModule {}
