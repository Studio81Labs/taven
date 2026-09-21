import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { CheckoutPaymentDeadlineService } from "./modules/payments/checkout-payment-deadline.service";
import { ComgatePaymentProviderAdapter } from "./modules/payments/comgate-payment-provider.adapter";
import { DisabledPaymentProviderAdapter } from "./modules/payments/disabled-payment-provider.adapter";
import { PaymentOutboxDispatcherService } from "./modules/payments/payment-outbox-dispatcher.service";
import {
  PAYMENT_PROVIDER_CONFIG,
  readPaymentProviderConfig,
  type PaymentProviderConfig,
} from "./modules/payments/payment-provider.config";
import { PAYMENT_PROVIDER } from "./modules/payments/payment-provider.port";
import { SandboxPaymentProviderAdapter } from "./modules/payments/sandbox-payment-provider.adapter";

@Module({
  imports: [PrismaModule],
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
          : config.provider === "sandbox"
            ? new SandboxPaymentProviderAdapter(config)
            : new DisabledPaymentProviderAdapter(),
    },
    CheckoutPaymentDeadlineService,
    PaymentOutboxDispatcherService,
  ],
})
export class CheckoutPaymentWorkerModule {}
