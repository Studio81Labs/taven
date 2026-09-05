import { describe, expect, it } from "vitest";
import {
  initialPaymentReturnPresentation,
  paymentReturnPresentation,
  type CheckoutPaymentStatus,
} from "./payment-return";

describe("payment return presentation", () => {
  it.each(["CREATED", "PENDING"] satisfies CheckoutPaymentStatus[])(
    "keeps %s pending until provider truth arrives",
    (status) => {
      expect(paymentReturnPresentation(status)).toMatchObject({
        tone: "pending",
        refreshable: true,
        restartable: false,
      });
    },
  );

  it("treats only a captured payment as an accepted order", () => {
    expect(paymentReturnPresentation("CAPTURED")).toMatchObject({
      label: "PLATBA PŘIJATA",
      tone: "success",
      refreshable: false,
      restartable: false,
    });
  });

  it.each(["FAILED", "VOIDED"] satisfies CheckoutPaymentStatus[])(
    "allows a fresh attempt after %s",
    (status) => {
      expect(paymentReturnPresentation(status)).toMatchObject({
        tone: "failure",
        refreshable: true,
        restartable: true,
      });
    },
  );

  it.each([
    ["REFUND_PENDING", true],
    ["PARTIALLY_REFUNDED", true],
    ["REFUNDED", false],
  ] satisfies Array<[CheckoutPaymentStatus, boolean]>)(
    "renders %s as refund state",
    (status, refreshable) => {
      expect(paymentReturnPresentation(status)).toMatchObject({
        tone: "refund",
        refreshable,
        restartable: false,
      });
    },
  );

  it("does not trust provider return paths before loading stored state", () => {
    for (const kind of ["success", "cancelled", "pending"] as const) {
      expect(initialPaymentReturnPresentation(kind)).toMatchObject({
        tone: "pending",
        refreshable: false,
        restartable: false,
      });
    }
  });
});
