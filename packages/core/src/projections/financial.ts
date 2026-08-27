import { DomainError } from "../primitives/errors.js";
import { Money } from "../primitives/money.js";

export type FinancialProjectionErrorCode =
  | "CURRENCY_MISMATCH"
  | "OVER_REFUND"
  | "DUPLICATE_PAYMENT"
  | "DUPLICATE_COMPONENT_CREDIT"
  | "NEGATIVE_RESULT";

export class FinancialProjectionError extends DomainError {
  override readonly name = "FinancialProjectionError";

  constructor(code: FinancialProjectionErrorCode, message: string) {
    super(code, message);
  }
}

export type CapturedPaymentStatus =
  "captured" | "refund_pending" | "partially_refunded" | "refunded";

export interface CapturedPayment {
  readonly id: string;
  readonly status: CapturedPaymentStatus;
  readonly captured: Money;
  readonly refunded?: Money;
  /** Late/capacity compensation captures never settle an Order. */
  readonly isCompensationCapture?: boolean;
  /** False for a capture received after the immutable cutoff. */
  readonly includedInSettlement?: boolean;
}

export type DerivedPaymentStatus =
  "unpaid" | "partially_paid" | "paid" | "partially_refunded" | "refunded";

export interface PaymentProjection {
  readonly paymentStatus: DerivedPaymentStatus;
  readonly capturedTotal: Money;
  readonly refundedTotal: Money;
  readonly netCaptured: Money;
  readonly amountDue: Money;
  readonly refundableBalance: Money;
}

function assertCurrency(value: Money, currency: string): void {
  if (value.currency !== currency) {
    throw new FinancialProjectionError(
      "CURRENCY_MISMATCH",
      `Expected ${currency}, received ${value.currency}.`,
    );
  }
}

/** Projects only captured money eligible for the immutable Order settlement. */
export function projectPayments(
  contractTotal: Money,
  payments: readonly CapturedPayment[],
): PaymentProjection {
  let capturedTotal = Money.zero(contractTotal.currency);
  let refundedTotal = Money.zero(contractTotal.currency);
  const paymentIds = new Set<string>();

  for (const payment of payments) {
    if (payment.id.trim().length === 0) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Payment IDs must not be blank.",
      );
    }
    if (paymentIds.has(payment.id)) {
      throw new FinancialProjectionError(
        "DUPLICATE_PAYMENT",
        `Payment ${payment.id} appears twice in the projection.`,
      );
    }
    paymentIds.add(payment.id);
    assertCurrency(payment.captured, contractTotal.currency);
    const refunded = payment.refunded ?? Money.zero(contractTotal.currency);
    assertCurrency(refunded, contractTotal.currency);
    if (refunded.compare(payment.captured) > 0) {
      throw new FinancialProjectionError(
        "OVER_REFUND",
        `Refund exceeds capture for payment ${payment.id}.`,
      );
    }
    if (
      (payment.status === "refunded" &&
        refunded.compare(payment.captured) !== 0) ||
      (payment.status === "partially_refunded" &&
        (refunded.minorUnits === 0n ||
          refunded.compare(payment.captured) >= 0)) ||
      (payment.status === "refund_pending" &&
        refunded.compare(payment.captured) >= 0) ||
      (payment.status === "captured" && refunded.minorUnits > 0n)
    ) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        `Payment ${payment.id} has inconsistent capture, refund, and status data.`,
      );
    }
    if (
      payment.isCompensationCapture ||
      payment.includedInSettlement === false
    ) {
      continue;
    }
    capturedTotal = capturedTotal.add(payment.captured);
    refundedTotal = refundedTotal.add(refunded);
  }

  const netCaptured = capturedTotal.subtract(refundedTotal);
  const paymentStatus: DerivedPaymentStatus =
    capturedTotal.minorUnits === 0n
      ? "unpaid"
      : netCaptured.minorUnits === 0n && refundedTotal.minorUnits > 0n
        ? "refunded"
        : refundedTotal.minorUnits > 0n
          ? "partially_refunded"
          : netCaptured.compare(contractTotal) >= 0
            ? "paid"
            : "partially_paid";

  return {
    paymentStatus,
    capturedTotal,
    refundedTotal,
    netCaptured,
    amountDue:
      contractTotal.compare(netCaptured) > 0
        ? contractTotal.subtract(netCaptured)
        : Money.zero(contractTotal.currency),
    refundableBalance:
      netCaptured.compare(contractTotal) > 0
        ? netCaptured.subtract(contractTotal)
        : Money.zero(contractTotal.currency),
  };
}

export interface ComponentAllocation {
  readonly id: string;
  readonly remaining: Money;
}

export interface ComponentCreditLedger {
  readonly currency: string;
  readonly consumedAllocationIds: readonly string[];
  /** Cumulative immutable credit amount represented by the consumed IDs. */
  readonly creditedTotal: Money;
}

export interface ComponentCreditResult {
  readonly ledger: ComponentCreditLedger;
  readonly credited: Money;
  readonly remainingContractValue: Money;
}

/**
 * Consumes immutable component allocations once and proves that the resulting
 * contract value cannot become negative.
 */
export function consumeComponentCredits(
  contractTotal: Money,
  allocations: readonly ComponentAllocation[],
  ledger: ComponentCreditLedger,
): ComponentCreditResult {
  if (ledger.currency !== contractTotal.currency) {
    throw new FinancialProjectionError(
      "CURRENCY_MISMATCH",
      "The component-credit ledger and contract must use one currency.",
    );
  }
  assertCurrency(ledger.creditedTotal, contractTotal.currency);
  const seen = new Set<string>();
  for (const id of ledger.consumedAllocationIds) {
    if (seen.has(id)) {
      throw new FinancialProjectionError(
        "DUPLICATE_COMPONENT_CREDIT",
        `Allocation ${id} appears twice in the credit ledger.`,
      );
    }
    seen.add(id);
  }

  let credited = Money.zero(contractTotal.currency);
  for (const allocation of allocations) {
    if (allocation.id.trim().length === 0) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Component allocation IDs must not be blank.",
      );
    }
    if (seen.has(allocation.id)) {
      throw new FinancialProjectionError(
        "DUPLICATE_COMPONENT_CREDIT",
        `Allocation ${allocation.id} was already credited.`,
      );
    }
    assertCurrency(allocation.remaining, contractTotal.currency);
    seen.add(allocation.id);
    credited = credited.add(allocation.remaining);
  }

  const cumulativeCredited = ledger.creditedTotal.add(credited);
  let remainingContractValue: Money;
  try {
    remainingContractValue = contractTotal.subtract(cumulativeCredited);
  } catch (error) {
    if (error instanceof DomainError && error.code === "NEGATIVE_RESULT") {
      throw new FinancialProjectionError(
        "NEGATIVE_RESULT",
        "Component credits exceed the remaining contract value.",
      );
    }
    throw error;
  }

  return {
    ledger: {
      currency: ledger.currency,
      consumedAllocationIds: [...seen],
      creditedTotal: cumulativeCredited,
    },
    credited,
    remainingContractValue,
  };
}
