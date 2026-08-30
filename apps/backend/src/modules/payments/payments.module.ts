import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { BalancePaymentDeadlineService } from "./balance-payment-deadline.service";

@Module({
  imports: [PrismaModule],
  providers: [BalancePaymentDeadlineService],
  exports: [BalancePaymentDeadlineService],
})
export class PaymentsModule {}
