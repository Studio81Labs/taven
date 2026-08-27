import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { Money, type RoundingMode } from "./money.js";

describe("Money", () => {
  it("uses immutable integer minor units and rejects invalid construction", () => {
    expect(Money.of(1250n, "CZK").minorUnits).toBe(1250n);
    expect(Object.isFrozen(Money.of(1, "CZK"))).toBe(true);
    for (const currency of ["CZK", "EUR", "USD", "JPY"]) {
      expect(Money.zero(currency).currency).toBe(currency);
    }
    expect(() => Money.of(1.5, "CZK")).toThrow(DomainError);
    expect(() => Money.of(-1, "CZK")).toThrow(/must not be negative/);
    expect(() => Money.of(1, "czk")).toThrow(/ISO 4217/);
    for (const currency of ["EUU", "AAA", "QAB", "ZZZ", "BGN", "XAU", "XXX"]) {
      expect(() => Money.of(1, currency)).toThrow(/ISO 4217/);
      expect(() => Money.zero(currency)).toThrow(/ISO 4217/);
    }
  });

  it("guards currency and negative results", () => {
    const amount = Money.of(10, "CZK");
    expect(() => amount.add(Money.of(1, "EUR"))).toThrow(
      expect.objectContaining({ code: "CURRENCY_MISMATCH" }),
    );
    expect(() => amount.subtract(Money.of(11, "CZK"))).toThrow(
      expect.objectContaining({ code: "NEGATIVE_RESULT" }),
    );
  });

  it.each([
    ["floor", 2n],
    ["toward-zero", 2n],
    ["ceil", 3n],
    ["half-up", 3n],
    ["half-even", 2n],
  ] as const)(
    "rounds rational multiplication with %s",
    (rounding, expected) => {
      expect(Money.of(5, "CZK").multiply(1, 2, rounding).minorUnits).toBe(
        expected,
      );
    },
  );

  it.each([
    ["half-up", 3n],
    ["half-even", 2n],
  ] as const)(
    "handles exact ties using %s",
    (rounding: RoundingMode, expected) => {
      expect(Money.of(5, "CZK").multiply(1, 2, rounding).minorUnits).toBe(
        expected,
      );
    },
  );
});
