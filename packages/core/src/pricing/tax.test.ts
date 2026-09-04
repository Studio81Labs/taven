import { describe, expect, it } from "vitest";
import { Money } from "../primitives/money.js";
import { taxBreakdownFromGross, taxBreakdownFromNet } from "./tax.js";

describe("seller VAT policy", () => {
  it("keeps non-VAT-payer prices final without charging VAT", () => {
    expect(
      taxBreakdownFromNet(Money.of(10_000n, "CZK"), {
        regime: "NON_VAT_PAYER",
        vatRateBasisPoints: 0,
      }),
    ).toEqual({
      regime: "NON_VAT_PAYER",
      vatRateBasisPoints: 0,
      net: Money.of(10_000n, "CZK"),
      vat: Money.zero("CZK"),
      gross: Money.of(10_000n, "CZK"),
    });
  });

  it("rounds VAT half-up in minor units in both directions", () => {
    expect(
      taxBreakdownFromNet(Money.of(10_005n, "CZK"), {
        regime: "VAT_PAYER",
        vatRateBasisPoints: 2_100,
      }),
    ).toMatchObject({
      net: Money.of(10_005n, "CZK"),
      vat: Money.of(2_101n, "CZK"),
      gross: Money.of(12_106n, "CZK"),
    });
    expect(
      taxBreakdownFromGross(Money.of(12_106n, "CZK"), {
        regime: "VAT_PAYER",
        vatRateBasisPoints: 2_100,
      }),
    ).toMatchObject({
      net: Money.of(10_005n, "CZK"),
      vat: Money.of(2_101n, "CZK"),
    });
  });

  it("rejects inconsistent and unsupported tax policies", () => {
    expect(() =>
      taxBreakdownFromNet(Money.of(1n, "CZK"), {
        regime: "NON_VAT_PAYER",
        vatRateBasisPoints: 2_100,
      }),
    ).toThrow(/non-VAT payer/);
    expect(() =>
      taxBreakdownFromNet(Money.of(1n, "CZK"), {
        regime: "VAT_PAYER",
        vatRateBasisPoints: 0,
      }),
    ).toThrow(/VAT payer/);
  });
});
