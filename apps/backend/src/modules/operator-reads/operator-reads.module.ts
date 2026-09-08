import { Module } from "@nestjs/common";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { OrdersModule } from "../orders/orders.module";
import { PrismaModule } from "../../prisma/prisma.module";
import { OperatorReadsController } from "./operator-reads.controller";
import { OperatorReadsService } from "./operator-reads.service";

@Module({
  imports: [PrismaModule, AdminAccessModule, OrdersModule],
  controllers: [OperatorReadsController],
  providers: [OperatorReadsService],
})
export class OperatorReadsModule {}
