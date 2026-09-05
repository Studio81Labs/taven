import { describe, expect, it } from "vitest";
import {
  initialPaymentReturnPresentation,
  paymentRestartMode,
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

  it("retries only failed payments on the accepted quote", () => {
    expect(paymentReturnPresentation("FAILED")).toMatchObject({
      tone: "failure",
      refreshable: true,
      restartable: true,
    });
    expect(paymentRestartMode("FAILED")).toBe("PAYMENT");
  });

  it("routes voided payments to a fresh quote", () => {
    expect(paymentReturnPresentation("VOIDED")).toMatchObject({
      tone: "failure",
      refreshable: false,
      restartable: true,
    });
    expect(paymentRestartMode("VOIDED")).toBe("QUOTE");
  });

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
