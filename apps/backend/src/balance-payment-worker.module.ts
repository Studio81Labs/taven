import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { BalancePaymentDeadlineService } from "./modules/payments/balance-payment-deadline.service";

@Module({
  imports: [PrismaModule],
  providers: [BalancePaymentDeadlineService],
})
export class BalancePaymentWorkerModule {}
