import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type {
  CreatedPaymentIntent,
  PaymentEventLocator,
  PaymentProviderCapabilities,
  PaymentProviderPort,
  ProviderRefundResult,
  VerifiedPaymentEvent,
} from "./payment-provider.port";

export class DisabledPaymentProviderAdapter implements PaymentProviderPort {
  providerName(): string {
    return "disabled";
  }

  async capabilities(): Promise<PaymentProviderCapabilities> {
    return { provider: this.providerName(), methods: [] };
  }

  refundRetrySafety(): "MANUAL_RECONCILIATION" {
    return "MANUAL_RECONCILIATION";
  }

  async createIntent(): Promise<CreatedPaymentIntent> {
    throw unavailable();
  }

  locateEvent(): PaymentEventLocator {
    throw new NotFoundException("Payment provider webhook is unavailable");
  }

  async verifyEvent(): Promise<VerifiedPaymentEvent> {
    throw new NotFoundException("Payment provider webhook is unavailable");
  }

  async cancelIntent(): Promise<void> {
    throw unavailable();
  }

  async refund(): Promise<ProviderRefundResult> {
    throw unavailable();
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException(
    "Payment provider is disabled until checkout is configured",
  );
}
