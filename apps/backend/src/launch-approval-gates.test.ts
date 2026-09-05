import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  assertBindingQuoteFlowsEnabled,
  assertCheckoutAcceptanceRevisionsCurrent,
  assertCheckoutClaimPolicyRevisionCurrent,
  assertCheckoutPaymentFlowsEnabled,
  assertQuotePhotoUploadsEnabled,
  approvedCheckoutClaimPolicyRevision,
  approvedCheckoutTermsRevision,
  BINDING_QUOTE_FLOWS_ENV,
  CHECKOUT_CLAIM_POLICY_REVISION_ENV,
  CHECKOUT_PAYMENT_FLOWS_ENV,
  CHECKOUT_TERMS_REVISION_ENV,
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
        assertCheckoutPaymentFlowsEnabled("terms-v1-approved", {
          [CHECKOUT_PAYMENT_FLOWS_ENV]: value,
        }),
      ).toThrowError(ServiceUnavailableException);
    },
  );

  it("enables checkout payments only with an explicit true", () => {
    expect(() =>
      assertCheckoutPaymentFlowsEnabled("terms-v1-approved", {
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: "claims-v1-approved",
        [CHECKOUT_TERMS_REVISION_ENV]: "terms-v1-approved",
      }),
    ).not.toThrow();
  });

  it.each([undefined, "", "claim-policy-draft-v0", "claims-pending"])(
    "rejects unapproved checkout claim policy %s",
    (revision) => {
      expect(() =>
        assertCheckoutPaymentFlowsEnabled("terms-v1-approved", {
          [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
          [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: revision,
          [CHECKOUT_TERMS_REVISION_ENV]: "terms-v1-approved",
        }),
      ).toThrowError(ServiceUnavailableException);
    },
  );

  it.each([undefined, "", "terms-draft-v0", "terms-pending"])(
    "rejects unapproved checkout terms %s",
    (revision) => {
      expect(() =>
        assertCheckoutPaymentFlowsEnabled("terms-v1-approved", {
          [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
          [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: "claims-v1-approved",
          [CHECKOUT_TERMS_REVISION_ENV]: revision,
        }),
      ).toThrowError(ServiceUnavailableException);
    },
  );

  it("rejects a price binding with a different terms revision", () => {
    expect(() =>
      assertCheckoutPaymentFlowsEnabled("terms-v0", {
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: "claims-v1-approved",
        [CHECKOUT_TERMS_REVISION_ENV]: "terms-v1-approved",
      }),
    ).toThrowError(ServiceUnavailableException);
  });

  it.each([
    ["terms-v0", "claims-v1-approved"],
    ["terms-v1-approved", "claims-v0"],
  ])(
    "rejects immutable acceptance of terms %s and claim policy %s",
    (termsRevision, claimPolicyRevision) => {
      expect(() =>
        assertCheckoutAcceptanceRevisionsCurrent(
          { termsRevision, claimPolicyRevision },
          {
            termsRevision: "terms-v1-approved",
            claimPolicyRevision: "claims-v1-approved",
          },
        ),
      ).toThrowError(ServiceUnavailableException);
    },
  );

  it("allows missing or currently approved immutable acceptance", () => {
    expect(() =>
      assertCheckoutAcceptanceRevisionsCurrent(
        { termsRevision: null, claimPolicyRevision: null },
        {
          termsRevision: "terms-v1-approved",
          claimPolicyRevision: "claims-v1-approved",
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertCheckoutAcceptanceRevisionsCurrent(
        {
          termsRevision: "terms-v1-approved",
          claimPolicyRevision: "claims-v1-approved",
        },
        {
          termsRevision: "terms-v1-approved",
          claimPolicyRevision: "claims-v1-approved",
        },
      ),
    ).not.toThrow();
  });

  it("requires the checkout request to bind the approved claim policy", () => {
    expect(() =>
      assertCheckoutClaimPolicyRevisionCurrent(
        "claims-v0",
        "claims-v1-approved",
      ),
    ).toThrowError(ServiceUnavailableException);
    expect(() =>
      assertCheckoutClaimPolicyRevisionCurrent(
        "claims-v1-approved",
        "claims-v1-approved",
      ),
    ).not.toThrow();
  });

  it("returns the trimmed approved claim-policy revision", () => {
    expect(
      approvedCheckoutClaimPolicyRevision({
        [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: " claims-v1-approved ",
      }),
    ).toBe("claims-v1-approved");
  });

  it("returns the trimmed approved terms revision", () => {
    expect(
      approvedCheckoutTermsRevision({
        [CHECKOUT_TERMS_REVISION_ENV]: " terms-v1-approved ",
      }),
    ).toBe("terms-v1-approved");
  });
});
