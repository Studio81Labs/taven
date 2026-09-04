import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AutomaticQuotesModule } from "../automatic-quotes/automatic-quotes.module";
import { ResourcesModule } from "../resources/resources.module";
import { BalancePaymentDeadlineService } from "./balance-payment-deadline.service";
import { CheckoutPaymentDeadlineService } from "./checkout-payment-deadline.service";
import { ComgatePaymentProviderAdapter } from "./comgate-payment-provider.adapter";
import { PaymentOutboxDispatcherService } from "./payment-outbox-dispatcher.service";
import {
  PAYMENT_PROVIDER_CONFIG,
  readPaymentProviderConfig,
  type PaymentProviderConfig,
} from "./payment-provider.config";
import { PAYMENT_PROVIDER } from "./payment-provider.port";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { SandboxPaymentProviderAdapter } from "./sandbox-payment-provider.adapter";

@Module({
  imports: [PrismaModule, AutomaticQuotesModule, ResourcesModule],
  controllers: [PaymentsController],
  providers: [
    {
      provide: PAYMENT_PROVIDER_CONFIG,
      useFactory: (): PaymentProviderConfig => readPaymentProviderConfig(),
    },
    {
      provide: PAYMENT_PROVIDER,
      inject: [PAYMENT_PROVIDER_CONFIG],
      useFactory: (config: PaymentProviderConfig) =>
        config.provider === "comgate"
          ? new ComgatePaymentProviderAdapter(config)
          : new SandboxPaymentProviderAdapter(config),
    },
    PaymentsService,
    BalancePaymentDeadlineService,
    CheckoutPaymentDeadlineService,
    PaymentOutboxDispatcherService,
  ],
  exports: [
    PAYMENT_PROVIDER,
    PaymentsService,
    BalancePaymentDeadlineService,
    CheckoutPaymentDeadlineService,
    PaymentOutboxDispatcherService,
  ],
})
export class PaymentsModule {}
