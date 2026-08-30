import { DomainError } from "../primitives/errors.js";
import { Money, type RoundingMode } from "../primitives/money.js";
import type { Rational } from "./types.js";

function assertNonNegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new DomainError("NEGATIVE_RESULT", `${name} must not be negative`);
  }
}

/** Exact floor division for non-negative integer operands. */
export function floorDivide(numerator: bigint, denominator: bigint): bigint {
  assertNonNegative(numerator, "numerator");
  if (denominator <= 0n) {
    throw new DomainError("DIVISION_BY_ZERO", "denominator must be positive");
  }
  return numerator / denominator;
}

/** Exact ceiling division for non-negative integer operands. */
export function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  assertNonNegative(numerator, "numerator");
  if (denominator <= 0n) {
    throw new DomainError("DIVISION_BY_ZERO", "denominator must be positive");
  }
  return (numerator + denominator - 1n) / denominator;
}

export function assertRational(value: Rational, name = "rational"): void {
  assertNonNegative(value.numerator, `${name} numerator`);
  if (value.denominator <= 0n) {
    throw new DomainError(
      "DIVISION_BY_ZERO",
      `${name} denominator must be positive`,
    );
  }
}

/** Multiplies a non-negative integer by a rational without using floats. */
export function multiplyRational(
  value: bigint,
  rate: Rational,
  rounding: "floor" | "ceil",
): bigint {
  assertNonNegative(value, "value");
  assertRational(rate, "rate");
  const numerator = value * rate.numerator;
  return rounding === "ceil"
    ? ceilDivide(numerator, rate.denominator)
    : floorDivide(numerator, rate.denominator);
}

/** Converts a rational cost to Money at an explicitly selected boundary. */
export function moneyFromRational(
  currency: string,
  quantity: bigint,
  rate: Rational,
  rounding: "floor" | "ceil" = "ceil",
): Money {
  return Money.of(multiplyRational(quantity, rate, rounding), currency);
}

/** Uses Money's complete rounding modes while keeping the pricing API bigint-only. */
export function multiplyMoneyRational(
  money: Money,
  rate: Rational,
  rounding: RoundingMode,
): Money {
  assertRational(rate, "rate");
  return money.multiply(rate.numerator, rate.denominator, rounding);
}

export function sumMoney(currency: string, values: readonly Money[]): Money {
  return values.reduce((sum, value) => sum.add(value), Money.zero(currency));
}
