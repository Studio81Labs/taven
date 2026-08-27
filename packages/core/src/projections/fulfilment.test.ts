import { describe, expect, it } from "vitest";
import { Money } from "../primitives/money.js";
import {
  isQcReady,
  isShipmentHandoffReady,
  projectOrderCompletion,
  projectSinglePhaseCompletion,
} from "./fulfilment.js";

describe("fulfilment projections", () => {
  it("requires an approved current leaf for every required slot before QC", () => {
    expect(
      isQcReady([
        {
          id: "a",
          currentJobLeafStatus: "qc_approved",
          hasOpenReplacement: false,
        },
        { id: "b", currentJobLeafStatus: "packed", hasOpenReplacement: false },
      ]),
    ).toBe(true);
    expect(
      isQcReady([
        {
          id: "a",
          currentJobLeafStatus: "qc_approved",
          hasOpenReplacement: true,
        },
      ]),
    ).toBe(false);
  });

  it("requires every shipment slot packed, unblocked, and financially settled", () => {
    const slots = [
      {
        id: "a",
        currentJobLeafStatus: "packed" as const,
        hasOpenReplacement: false,
      },
    ];
    expect(
      isShipmentHandoffReady(slots, {
        amountDue: Money.zero("CZK"),
        refundableBalance: Money.zero("CZK"),
      }),
    ).toBe(true);
    expect(
      isShipmentHandoffReady([{ ...slots[0], recoveryBlocked: true }], {
        amountDue: Money.zero("CZK"),
        refundableBalance: Money.zero("CZK"),
      }),
    ).toBe(false);
    expect(
      isShipmentHandoffReady([{ ...slots[0], hasOpenReplacement: true }], {
        amountDue: Money.zero("CZK"),
        refundableBalance: Money.zero("CZK"),
      }),
    ).toBe(false);
    expect(
      isShipmentHandoffReady(slots, {
        amountDue: Money.of(1n, "CZK"),
        refundableBalance: Money.zero("CZK"),
      }),
    ).toBe(false);
  });

  it.each([
    [
      [{ id: "a", hasOpenReplacement: false, outcome: "delivered" }],
      "completed",
    ],
    [
      [
        { id: "a", hasOpenReplacement: false, outcome: "delivered" },
        { id: "b", hasOpenReplacement: false, outcome: "cancelled_refunded" },
      ],
      "partially_fulfilled",
    ],
    [
      [{ id: "a", hasOpenReplacement: false, outcome: "cancelled_refunded" }],
      "refunded",
    ],
    [[{ id: "a", hasOpenReplacement: false, outcome: "pending" }], "pending"],
  ] as const)("projects completion barriers", (slots, expected) => {
    expect(projectOrderCompletion(slots)).toBe(expected);
  });

  it("maps an all-refunded slot result to the explicit single-phase state", () => {
    const slots = [
      { id: "a", hasOpenReplacement: false, outcome: "cancelled_refunded" },
    ] as const;
    expect(projectSinglePhaseCompletion(slots)).toBe("cancelled_refunded");
    expect(projectOrderCompletion(slots)).toBe("refunded");
  });
});
