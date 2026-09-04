import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  assertBindingQuoteFlowsEnabled,
  assertCheckoutPaymentFlowsEnabled,
  assertQuotePhotoUploadsEnabled,
  BINDING_QUOTE_FLOWS_ENV,
  CHECKOUT_PAYMENT_FLOWS_ENV,
  QUOTE_PHOTO_UPLOADS_ENV,
} from "./launch-approval-gates";

describe("launch approval gates", () => {
  it.each([undefined, "", "false", "TRUE", " true ", "approved"])(
    "keeps binding flows disabled for %s",
    (value) => {
      expect(() =>
        assertBindingQuoteFlowsEnabled({
          [BINDING_QUOTE_FLOWS_ENV]: value,
        }),
      ).toThrowError(ServiceUnavailableException);
    },
  );

  it("enables binding flows only with an explicit true", () => {
    expect(() =>
      assertBindingQuoteFlowsEnabled({
        [BINDING_QUOTE_FLOWS_ENV]: "true",
      }),
    ).not.toThrow();
  });

  it.each([undefined, "", "false", "TRUE", " true ", "approved"])(
    "keeps quote photo uploads disabled for %s",
    (value) => {
      expect(() =>
        assertQuotePhotoUploadsEnabled({
          [QUOTE_PHOTO_UPLOADS_ENV]: value,
        }),
      ).toThrowError(ServiceUnavailableException);
    },
  );

  it("returns a stable public error for disabled photo uploads", () => {
    let error: unknown;
    try {
      assertQuotePhotoUploadsEnabled({});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      code: "LAUNCH_APPROVAL_REQUIRED",
      message:
        "Quote photo uploads are unavailable until their retention policy is approved",
    });
  });

  it.each([undefined, "", "false", "TRUE", " true ", "approved"])(
    "keeps checkout payments disabled for %s",
    (value) => {
      expect(() =>
        assertCheckoutPaymentFlowsEnabled({
          [CHECKOUT_PAYMENT_FLOWS_ENV]: value,
        }),
      ).toThrowError(ServiceUnavailableException);
    },
  );

  it("enables checkout payments only with an explicit true", () => {
    expect(() =>
      assertCheckoutPaymentFlowsEnabled({
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
      }),
    ).not.toThrow();
  });
});
