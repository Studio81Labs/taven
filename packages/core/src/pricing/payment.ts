import { DomainError } from "../primitives/errors.js";
import { Money } from "../primitives/money.js";
import { ceilDivide } from "./arithmetic.js";
import {
  taxBreakdownFromGross,
  validateSellerTaxPolicy,
  type SellerTaxPolicy,
} from "./tax.js";
import type {
  GrossedUpPaymentCapture,
  PaymentScheduleCapture,
  PaymentScheduleGrossUp,
} from "./types.js";

const SHARE_BASIS_POINTS = 10_000;
const MAX_EXACT_GROSS_UP_CANDIDATES = 10_000n;

interface GrossCaptureMinor {
  readonly definition: PaymentScheduleCapture;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      `${name} must be a non-negative safe integer`,
    );
  }
}

function compareCaptureTie(
  left: PaymentScheduleCapture,
  right: PaymentScheduleCapture,
): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validateSchedule(
  subtotal: Money,
  captures: readonly PaymentScheduleCapture[],
): void {
  if (captures.length !== 1 && captures.length !== 2) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "payment schedule must contain one FULL or DEPOSIT plus BALANCE captures",
    );
  }

  const ids = new Set<string>();
  const sequences = new Set<number>();
  const roles = new Set<string>();
  let shares = 0;
  for (const capture of captures) {
    if (capture.id.trim().length === 0) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "payment capture ID must not be blank",
      );
    }
    if (ids.has(capture.id)) {
      throw new DomainError(
        "DUPLICATE_PAYMENT",
        "payment capture IDs must be unique",
      );
    }
    ids.add(capture.id);
    assertSafeNonNegativeInteger(capture.sequence, "payment capture sequence");
    if (sequences.has(capture.sequence)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "payment capture sequences must be unique",
      );
    }
    sequences.add(capture.sequence);
    if (roles.has(capture.role)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "payment capture roles must be unique",
      );
    }
    roles.add(capture.role);
    assertSafeNonNegativeInteger(
      capture.shareBasisPoints,
      "payment capture share basis points",
    );
    assertSafeNonNegativeInteger(
      capture.feeRateBasisPoints,
      "payment fee basis points",
    );
    if (
      capture.shareBasisPoints <= 0 ||
      capture.feeRateBasisPoints >= SHARE_BASIS_POINTS
    ) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "payment shares must be positive and fee rate must be below 10000 basis points",
      );
    }
    if (capture.feeFixed.currency !== subtotal.currency) {
      throw new DomainError(
        "CURRENCY_MISMATCH",
        "payment fees must use the quote currency",
      );
    }
    shares += capture.shareBasisPoints;
  }

  const full = captures.find((capture) => capture.role === "FULL");
  const deposit = captures.find((capture) => capture.role === "DEPOSIT");
  const balance = captures.find((capture) => capture.role === "BALANCE");
  const validShape =
    (captures.length === 1 && roles.size === 1 && full?.sequence === 0) ||
    (captures.length === 2 &&
      deposit?.sequence === 0 &&
      balance?.sequence === 1);
  if (!validShape || shares !== SHARE_BASIS_POINTS) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "payment schedule must be FULL:0 or DEPOSIT:0 plus BALANCE:1 with shares totaling 10000 basis points",
    );
  }
}

function allocateGrossMinor(
  total: bigint,
  captures: readonly PaymentScheduleCapture[],
): readonly { definition: PaymentScheduleCapture; grossMinor: bigint }[] {
  const values = captures.map((definition) => {
    const numerator = total * BigInt(definition.shareBasisPoints);
    return {
      definition,
      grossMinor: numerator / BigInt(SHARE_BASIS_POINTS),
      remainder: numerator % BigInt(SHARE_BASIS_POINTS),
    };
  });
  let remainder =
    total - values.reduce((sum, value) => sum + value.grossMinor, 0n);
  for (const value of [...values].sort((left, right) => {
    if (left.remainder !== right.remainder)
      return left.remainder > right.remainder ? -1 : 1;
    return compareCaptureTie(left.definition, right.definition);
  })) {
    if (remainder === 0n) break;
    value.grossMinor += 1n;
    remainder -= 1n;
  }
  return values.map(({ definition, grossMinor }) => ({
    definition,
    grossMinor,
  }));
}

function evaluateTotal(
  total: bigint,
  captures: readonly PaymentScheduleCapture[],
): readonly GrossCaptureMinor[] {
  return allocateGrossMinor(total, captures).map(
    ({ definition, grossMinor }) => ({
      definition,
      grossMinor,
      feeMinor:
        ceilDivide(
          grossMinor * BigInt(definition.feeRateBasisPoints),
          BigInt(SHARE_BASIS_POINTS),
        ) + definition.feeFixed.minorUnits,
    }),
  );
}

function satisfies(
  subtotalMinor: bigint,
  total: bigint,
  captures: readonly PaymentScheduleCapture[],
  taxPolicy: SellerTaxPolicy,
  currency: string,
): boolean {
  const evaluated = evaluateTotal(total, captures);
  if (evaluated.some((capture) => capture.grossMinor <= 0n)) return false;
  const fees = evaluated.reduce((sum, capture) => sum + capture.feeMinor, 0n);
  const tax = taxBreakdownFromGross(Money.of(total, currency), taxPolicy);
  return (
    tax.net.minorUnits >= fees && tax.net.minorUnits - fees >= subtotalMinor
  );
}

function candidateRange(
  subtotalMinor: bigint,
  captures: readonly PaymentScheduleCapture[],
  taxPolicy: SellerTaxPolicy,
): { readonly firstPossible: bigint; readonly guaranteed: bigint } {
  const basis = BigInt(SHARE_BASIS_POINTS);
  const taxDenominator = basis + BigInt(taxPolicy.vatRateBasisPoints);
  const weightedFeeRates = captures.reduce(
    (sum, capture) =>
      sum +
      BigInt(capture.shareBasisPoints) * BigInt(capture.feeRateBasisPoints),
    0n,
  );
  const slopeNumerator =
    basis * basis * basis - taxDenominator * weightedFeeRates;
  if (slopeNumerator <= 0n) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "combined tax and payment fee rates leave no sustainable net proceeds",
    );
  }

  const slopeDenominator = taxDenominator * basis * basis;
  const twiceBasis = 2n * basis;
  const fixedFees = captures.reduce(
    (sum, capture) => sum + capture.feeFixed.minorUnits,
    0n,
  );
  const feeRates = captures.reduce(
    (sum, capture) => sum + BigInt(capture.feeRateBasisPoints),
    0n,
  );

  // VAT contributes at most half a minor unit of rounding error. Each capture
  // can differ from its ideal share by less than one minor unit, followed by
  // less than one minor unit of fee-ceiling error. These rational envelopes
  // bound the only interval where the exact rounded result can first succeed.
  const upperErrorScaled = basis + 2n * feeRates;
  const lowerErrorScaled =
    basis + 2n * BigInt(captures.length) * basis + 2n * feeRates;
  const targetScaled = (subtotalMinor + fixedFees) * twiceBasis;
  const firstPossibleTarget = targetScaled - upperErrorScaled;
  const firstPossible =
    firstPossibleTarget <= 0n
      ? 0n
      : ceilDivide(
          slopeDenominator * firstPossibleTarget,
          slopeNumerator * twiceBasis,
        );
  const guaranteedByMargin = ceilDivide(
    slopeDenominator * (targetScaled + lowerErrorScaled),
    slopeNumerator * twiceBasis,
  );
  const guaranteedPositiveCaptures = captures.reduce(
    (minimum, capture) =>
      minimum > ceilDivide(basis, BigInt(capture.shareBasisPoints))
        ? minimum
        : ceilDivide(basis, BigInt(capture.shareBasisPoints)),
    1n,
  );
  return {
    firstPossible,
    guaranteed:
      guaranteedByMargin > guaranteedPositiveCaptures
        ? guaranteedByMargin
        : guaranteedPositiveCaptures,
  };
}

/**
 * Returns the least tax-inclusive total that covers the pre-tax subtotal after
 * each planned payment capture's percentage and fixed fee. A rational error
 * envelope narrows the exact bigint search without assuming that independently
 * rounded VAT and fees form a monotone predicate.
 */
export function grossUpPaymentSchedule(
  subtotal: Money,
  captures: readonly PaymentScheduleCapture[],
  taxPolicy: SellerTaxPolicy,
): PaymentScheduleGrossUp {
  validateSchedule(subtotal, captures);
  validateSellerTaxPolicy(taxPolicy);

  const range = candidateRange(subtotal.minorUnits, captures, taxPolicy);
  if (
    range.guaranteed - range.firstPossible + 1n >
    MAX_EXACT_GROSS_UP_CANDIDATES
  ) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "combined tax and payment fee rates exceed the safe exact-search bound",
    );
  }
  let total = range.firstPossible;
  while (total <= range.guaranteed) {
    if (
      satisfies(
        subtotal.minorUnits,
        total,
        captures,
        taxPolicy,
        subtotal.currency,
      )
    )
      break;
    total += 1n;
  }
  if (total > range.guaranteed) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "payment schedule cannot cover the requested subtotal",
    );
  }

  const evaluated = evaluateTotal(total, captures);
  const grossedCaptures: readonly GrossedUpPaymentCapture[] = [...evaluated]
    .sort((left, right) => compareCaptureTie(left.definition, right.definition))
    .map((capture) => ({
      id: capture.definition.id,
      sequence: capture.definition.sequence,
      role: capture.definition.role,
      gross: Money.of(capture.grossMinor, subtotal.currency),
      fee: Money.of(capture.feeMinor, subtotal.currency),
    }));
  const feeMinor = evaluated.reduce(
    (sum, capture) => sum + capture.feeMinor,
    0n,
  );
  const contractTotal = Money.of(total, subtotal.currency);
  return {
    contractTotal,
    paymentFee: Money.of(feeMinor, subtotal.currency),
    tax: taxBreakdownFromGross(contractTotal, taxPolicy),
    captures: grossedCaptures,
  };
}
