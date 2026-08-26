import { DomainError } from "./errors.js";

export type RoundingMode =
  "floor" | "ceil" | "toward-zero" | "half-up" | "half-even";

export type MinorUnitInput = bigint | number;

function asNonNegativeInteger(value: MinorUnitInput, name: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new DomainError("INVALID_ARGUMENT", `${name} must be a safe integer`);
  }

  const integer = BigInt(value);
  if (integer < 0n) {
    throw new DomainError("NEGATIVE_RESULT", `${name} must not be negative`);
  }

  return integer;
}

function validateCurrency(currency: string): string {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError(
      "INVALID_CURRENCY",
      "currency must be a three-letter uppercase ISO 4217 code",
    );
  }
  return currency;
}

function roundedQuotient(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator === 0n) {
    throw new DomainError("DIVISION_BY_ZERO", "denominator must not be zero");
  }
  if (denominator < 0n) {
    throw new DomainError("INVALID_ARGUMENT", "denominator must be positive");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || mode === "floor" || mode === "toward-zero") {
    return quotient;
  }
  if (mode === "ceil") return quotient + 1n;

  const doubledRemainder = remainder * 2n;
  if (doubledRemainder > denominator) return quotient + 1n;
  if (doubledRemainder < denominator) return quotient;
  if (mode === "half-up") return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** Immutable money represented only by integer minor units. */
export class Money {
  readonly minorUnits: bigint;
  readonly currency: string;

  private constructor(minorUnits: bigint, currency: string) {
    this.minorUnits = minorUnits;
    this.currency = currency;
    Object.freeze(this);
  }

  static of(minorUnits: MinorUnitInput, currency: string): Money {
    return new Money(
      asNonNegativeInteger(minorUnits, "minorUnits"),
      validateCurrency(currency),
    );
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (other.minorUnits > this.minorUnits) {
      throw new DomainError(
        "NEGATIVE_RESULT",
        "subtraction would produce a negative money amount",
      );
    }
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  multiply(
    numerator: MinorUnitInput,
    denominator: MinorUnitInput,
    rounding: RoundingMode,
  ): Money {
    const safeNumerator = asNonNegativeInteger(numerator, "numerator");
    const safeDenominator = asNonNegativeInteger(denominator, "denominator");
    return new Money(
      roundedQuotient(
        this.minorUnits * safeNumerator,
        safeDenominator,
        rounding,
      ),
      this.currency,
    );
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minorUnits === other.minorUnits) return 0;
    return this.minorUnits < other.minorUnits ? -1 : 1;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        "CURRENCY_MISMATCH",
        `cannot combine ${this.currency} and ${other.currency}`,
      );
    }
  }
}
