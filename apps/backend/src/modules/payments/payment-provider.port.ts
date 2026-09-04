export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");

export type CheckoutPaymentMethod = "CARD" | "BANK_TRANSFER";

export type PaymentProviderCapabilities = Readonly<{
  provider: string;
  methods: readonly CheckoutPaymentMethod[];
}>;

export type RefundRetrySafety = "IDEMPOTENT" | "MANUAL_RECONCILIATION";

export type CreatePaymentIntentInput = Readonly<{
  paymentId: string;
  orderReference: string;
  amountMinor: bigint;
  currency: string;
  method: CheckoutPaymentMethod;
  email: string;
  fullName: string;
  expiresAt: Date;
  returnUrls: Readonly<{
    success: string;
    cancelled: string;
    pending: string;
  }>;
}>;

export type CreatedPaymentIntent = Readonly<{
  providerIntentId: string;
  checkoutUrl: string;
}>;

export type VerifiedPaymentEvent = Readonly<{
  provider: string;
  providerEventId: string;
  providerTransactionId: string;
  status: "PENDING" | "CAPTURED" | "FAILED";
  amountMinor: bigint;
  currency: string;
  occurredAt: Date;
  evidence: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type ProviderRefundResult = Readonly<{
  providerRefundId: string;
  occurredAt: Date;
  evidence: Readonly<Record<string, string | number | boolean | null>>;
}>;

export interface PaymentProviderPort {
  providerName(): string;

  capabilities(): Promise<PaymentProviderCapabilities>;

  refundRetrySafety(): RefundRetrySafety;

  createIntent(input: CreatePaymentIntentInput): Promise<CreatedPaymentIntent>;

  verifyEvent(input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    body: unknown;
  }): Promise<VerifiedPaymentEvent>;

  cancelIntent(providerIntentId: string): Promise<void>;

  refund(input: {
    paymentId: string;
    providerIntentId: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }): Promise<ProviderRefundResult>;
}
