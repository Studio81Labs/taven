import { describe, expect, it } from "vitest";
import { Money } from "../primitives/money.js";
import {
  consumeComponentCredits,
  FinancialProjectionError,
  projectPayments,
} from "./financial.js";

const czk = (minor: bigint): Money => Money.of(minor, "CZK");

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof FinancialProjectionError ? error.code : undefined;
  }
  return undefined;
}

describe("payment projection", () => {
  it("projects settlement balances and excludes compensation captures", () => {
    expect(
      projectPayments(czk(100n), [
        {
          id: "paid",
          status: "partially_refunded",
          captured: czk(120n),
          refunded: czk(20n),
        },
        {
          id: "late",
          status: "refunded",
          captured: czk(50n),
          refunded: czk(50n),
          isCompensationCapture: true,
        },
      ]),
    ).toMatchObject({
      paymentStatus: "partially_refunded",
      capturedTotal: czk(120n),
      refundedTotal: czk(20n),
      netCaptured: czk(100n),
      amountDue: czk(0n),
      refundableBalance: czk(0n),
    });
  });

  it.each([
    [[], "unpaid"],
    [[{ id: "p", status: "captured", captured: czk(50n) }], "partially_paid"],
    [[{ id: "p", status: "captured", captured: czk(100n) }], "paid"],
    [
      [
        {
          id: "p",
          status: "partially_refunded",
          captured: czk(100n),
          refunded: czk(30n),
        },
      ],
      "partially_refunded",
    ],
    [
      [
        {
          id: "p",
          status: "refunded",
          captured: czk(100n),
          refunded: czk(100n),
        },
      ],
      "refunded",
    ],
  ] as const)("derives %s", (payments, expected) => {
    expect(projectPayments(czk(100n), payments).paymentStatus).toBe(expected);
  });

  it("rejects mixed currencies and over-refunds", () => {
    expect(
      errorCode(() =>
        projectPayments(czk(1n), [
          {
            id: "p",
            status: "captured",
            captured: Money.of(1n, "EUR"),
          },
        ]),
      ),
    ).toBe("CURRENCY_MISMATCH");
    expect(
      errorCode(() =>
        projectPayments(czk(1n), [
          {
            id: "p",
            status: "captured",
            captured: czk(1n),
            refunded: czk(2n),
          },
        ]),
      ),
    ).toBe("OVER_REFUND");
  });

  it("rejects duplicate payment identities", () => {
    const payment = { id: "p", status: "captured", captured: czk(1n) } as const;
    expect(errorCode(() => projectPayments(czk(2n), [payment, payment]))).toBe(
      "DUPLICATE_PAYMENT",
    );
  });
});

describe("component credits", () => {
  it("records consumed immutable allocation ids and contract remainder", () => {
    const first = consumeComponentCredits(
      czk(20n),
      [{ id: "express", remaining: czk(15n) }],
      { currency: "CZK", consumedAllocationIds: [] },
    );
    expect(first).toEqual({
      ledger: { currency: "CZK", consumedAllocationIds: ["express"] },
      credited: czk(15n),
      remainingContractValue: czk(5n),
    });
    expect(
      errorCode(() =>
        consumeComponentCredits(
          czk(20n),
          [{ id: "express", remaining: czk(15n) }],
          first.ledger,
        ),
      ),
    ).toBe("DUPLICATE_COMPONENT_CREDIT");
  });

  it("rejects credits that would make contract value negative", () => {
    expect(
      errorCode(() =>
        consumeComponentCredits(
          czk(10n),
          [{ id: "claim", remaining: czk(11n) }],
          { currency: "CZK", consumedAllocationIds: [] },
        ),
      ),
    ).toBe("NEGATIVE_RESULT");
  });
});
