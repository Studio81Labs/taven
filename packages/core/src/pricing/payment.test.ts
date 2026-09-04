import { describe, expect, it } from "vitest";
import { Money } from "../primitives/money.js";
import { grossUpPaymentSchedule } from "./payment.js";
import type { PaymentScheduleCapture } from "./types.js";

const czk = (minor: bigint) => Money.of(minor, "CZK");
const nonVatPayer = {
  regime: "NON_VAT_PAYER",
  vatRateBasisPoints: 0,
} as const;

describe("payment schedule gross-up", () => {
  it("finds the least one-capture total after percentage and fixed fees", () => {
    const result = grossUpPaymentSchedule(
      czk(33_500n),
      [
        {
          id: "full",
          sequence: 0,
          role: "FULL",
          shareBasisPoints: 10_000,
          feeRateBasisPoints: 150,
          feeFixed: czk(300n),
        },
      ],
      nonVatPayer,
    );
    expect(result.contractTotal).toEqual(czk(34_315n));
    expect(result.paymentFee).toEqual(czk(815n));
    expect(result.captures).toEqual([
      {
        id: "full",
        sequence: 0,
        role: "FULL",
        gross: czk(34_315n),
        fee: czk(815n),
      },
    ]);
    expect(
      result.contractTotal.minorUnits - result.paymentFee.minorUnits,
    ).toBeGreaterThanOrEqual(33_500n);
    expect(34_313n - (ceilFee(34_313n, 150n) + 300n)).toBeLessThan(33_500n);
  });

  it("charges the fixed fee for each deterministic DEPOSIT plus BALANCE capture", () => {
    const captures: readonly PaymentScheduleCapture[] = [
      {
        id: "deposit",
        sequence: 0,
        role: "DEPOSIT",
        shareBasisPoints: 4_000,
        feeRateBasisPoints: 150,
        feeFixed: czk(300n),
      },
      {
        id: "balance",
        sequence: 1,
        role: "BALANCE",
        shareBasisPoints: 6_000,
        feeRateBasisPoints: 150,
        feeFixed: czk(300n),
      },
    ];
    const result = grossUpPaymentSchedule(czk(10_000n), captures, nonVatPayer);
    expect(result.contractTotal.minorUnits).toBeGreaterThan(10_000n);
    expect(
      result.captures.reduce(
        (sum, capture) => sum + capture.gross.minorUnits,
        0n,
      ),
    ).toBe(result.contractTotal.minorUnits);
    expect(
      result.captures.reduce(
        (sum, capture) => sum + capture.fee.minorUnits,
        0n,
      ),
    ).toBe(result.paymentFee.minorUnits);
    expect(
      result.contractTotal.minorUnits - result.paymentFee.minorUnits,
    ).toBeGreaterThanOrEqual(10_000n);
    expect(result.captures.map((capture) => capture.id)).toEqual([
      "deposit",
      "balance",
    ]);
  });

  it("reconciles VAT and provider fees for split captures", () => {
    const captures: readonly PaymentScheduleCapture[] = [
      {
        id: "deposit",
        sequence: 0,
        role: "DEPOSIT",
        shareBasisPoints: 4_000,
        feeRateBasisPoints: 150,
        feeFixed: czk(300n),
      },
      {
        id: "balance",
        sequence: 1,
        role: "BALANCE",
        shareBasisPoints: 6_000,
        feeRateBasisPoints: 250,
        feeFixed: czk(150n),
      },
    ];
    for (const subtotal of [1n, 10_000n, 33_500n, 1_000_000n]) {
      const result = grossUpPaymentSchedule(czk(subtotal), captures, {
        regime: "VAT_PAYER",
        vatRateBasisPoints: 2_100,
      });
      expect(result.tax.net.add(result.tax.vat)).toEqual(result.contractTotal);
      expect(result.tax.net.minorUnits - result.paymentFee.minorUnits).toBe(
        subtotal,
      );
      expect(
        result.captures.reduce(
          (sum, capture) => sum + capture.gross.minorUnits,
          0n,
        ),
      ).toBe(result.contractTotal.minorUnits);
    }
  });

  it("uses canonical sequence as the stable share-rounding tie-break", () => {
    const result = grossUpPaymentSchedule(
      czk(1n),
      [
        {
          id: "z",
          sequence: 0,
          role: "DEPOSIT",
          shareBasisPoints: 5_000,
          feeRateBasisPoints: 0,
          feeFixed: czk(0n),
        },
        {
          id: "a",
          sequence: 1,
          role: "BALANCE",
          shareBasisPoints: 5_000,
          feeRateBasisPoints: 0,
          feeFixed: czk(0n),
        },
      ],
      nonVatPayer,
    );
    expect(result.contractTotal).toEqual(czk(2n));
    expect(result.captures).toEqual([
      { id: "z", sequence: 0, role: "DEPOSIT", gross: czk(1n), fee: czk(0n) },
      { id: "a", sequence: 1, role: "BALANCE", gross: czk(1n), fee: czk(0n) },
    ]);
  });

  it("rejects noncanonical schedule shapes", () => {
    expect(() =>
      grossUpPaymentSchedule(
        czk(1n),
        [
          {
            id: "full",
            sequence: 0,
            role: "FULL",
            shareBasisPoints: 5_000,
            feeRateBasisPoints: 0,
            feeFixed: czk(0n),
          },
          {
            id: "balance",
            sequence: 1,
            role: "BALANCE",
            shareBasisPoints: 5_000,
            feeRateBasisPoints: 0,
            feeFixed: czk(0n),
          },
        ],
        nonVatPayer,
      ),
    ).toThrow(/must be FULL:0 or DEPOSIT:0 plus BALANCE:1/);

    expect(() =>
      grossUpPaymentSchedule(
        czk(1n),
        [
          {
            id: "deposit",
            sequence: 1,
            role: "DEPOSIT",
            shareBasisPoints: 5_000,
            feeRateBasisPoints: 0,
            feeFixed: czk(0n),
          },
          {
            id: "balance",
            sequence: 0,
            role: "BALANCE",
            shareBasisPoints: 5_000,
            feeRateBasisPoints: 0,
            feeFixed: czk(0n),
          },
        ],
        nonVatPayer,
      ),
    ).toThrow(/DEPOSIT:0 plus BALANCE:1/);
  });
});

function ceilFee(gross: bigint, basisPoints: bigint): bigint {
  return (gross * basisPoints + 9_999n) / 10_000n;
}
