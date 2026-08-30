import { describe, expect, it } from "vitest";
import { Money } from "../primitives/money.js";
import {
  ceilDivide,
  floorDivide,
  moneyFromRational,
  multiplyMoneyRational,
  multiplyRational,
} from "./arithmetic.js";

describe("pricing arithmetic", () => {
  it("uses exact bigint floor and ceiling boundaries", () => {
    expect(floorDivide(10n, 3n)).toBe(3n);
    expect(ceilDivide(10n, 3n)).toBe(4n);
    expect(
      multiplyRational(1_001n, { numerator: 15n, denominator: 1_000n }, "ceil"),
    ).toBe(16n);
    expect(
      multiplyRational(
        1_001n,
        { numerator: 15n, denominator: 1_000n },
        "floor",
      ),
    ).toBe(15n);
  });

  it("converts rate costs without a floating-point intermediate", () => {
    expect(
      moneyFromRational("CZK", 1_000_000_000_000_001n, {
        numerator: 3n,
        denominator: 10n,
      }).minorUnits,
    ).toBe(300_000_000_000_001n);
    expect(
      multiplyMoneyRational(
        Money.of(5n, "CZK"),
        { numerator: 1n, denominator: 2n },
        "half-up",
      ).minorUnits,
    ).toBe(3n);
  });

  it("rejects negative and zero-denominator pricing inputs", () => {
    expect(() => ceilDivide(-1n, 1n)).toThrow(/must not be negative/);
    expect(() => floorDivide(1n, 0n)).toThrow(/denominator must be positive/);
    expect(() =>
      multiplyRational(1n, { numerator: 1n, denominator: 0n }, "ceil"),
    ).toThrow(/denominator must be positive/);
  });
});
