import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  assertBindingQuoteFlowsEnabled,
  assertCheckoutPaymentFlowEnabled,
  assertCheckoutPaymentFlowsEnabled,
  assertCheckoutPaymentMethodsAvailable,
  assertCheckoutRetryPaymentMethodsAvailable,
  assertCheckoutTermsRevisionCurrent,
  assertEffectiveCheckoutLegalDocuments,
  assertQuotePhotoUploadsEnabled,
  BINDING_QUOTE_FLOWS_ENV,
  CHECKOUT_CLAIM_WINDOW_DAYS_ENV,
  CHECKOUT_PAYMENT_FLOWS_ENV,
  QUOTE_PHOTO_UPLOADS_ENV,
} from "./launch-approval-gates";

const approvals = {
  schemaVersion: 1 as const,
  policyRevision: "test",
  evaluatedAt: "2026-01-01T00:00:00.000Z",
  documents: Object.fromEntries(
    [
      "terms",
      "claims",
      "privacy",
      "prohibitedContent",
      "retention",
      "photoConsent",
    ].map((key) => [
      key,
      {
        revision: `${key}-v1`,
        revisionId: `${key}-id`,
        status: "approved" as const,
        effectiveAt: "2026-01-01T00:00:00.000Z",
        contentHash: "a".repeat(64),
        effective: true,
      },
    ]),
  ),
} as never;

describe("launch approval gates", () => {
  it("keeps independent commercial switches fail-closed", () => {
    expect(() => assertBindingQuoteFlowsEnabled({})).toThrow(
      ServiceUnavailableException,
    );
    expect(() => assertQuotePhotoUploadsEnabled({})).toThrow(
      ServiceUnavailableException,
    );
    expect(() => assertCheckoutPaymentFlowsEnabled({})).toThrow(
      ServiceUnavailableException,
    );
  });

  it("does not make immutable checkout retries depend on the current Claim window", () => {
    const retryEnvironment = {
      [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
    };

    expect(() =>
      assertCheckoutPaymentFlowEnabled(retryEnvironment),
    ).not.toThrow();
    expect(() => assertCheckoutPaymentFlowsEnabled(retryEnvironment)).toThrow(
      ServiceUnavailableException,
    );
  });

  it("uses database legal selections rather than revision environment variables", () => {
    expect(() =>
      assertCheckoutPaymentFlowsEnabled({
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_CLAIM_WINDOW_DAYS_ENV]: "30",
        TAVEN_TERMS_REVISION: "different-v99",
        TAVEN_CLAIM_POLICY_REVISION: "different-v99",
      }),
    ).not.toThrow();
    expect(
      assertEffectiveCheckoutLegalDocuments(approvals, {
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_CLAIM_WINDOW_DAYS_ENV]: "30",
      }),
    ).toEqual({
      termsRevision: "terms-v1",
      claimPolicyRevision: "claims-v1",
      claimWindowDays: 30,
    });
  });

  it("still rejects a stale client-selected revision", () => {
    expect(() =>
      assertCheckoutTermsRevisionCurrent("terms-v0", "terms-v1"),
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      assertCheckoutTermsRevisionCurrent("terms-v1", "terms-v1"),
    ).not.toThrow();
  });

  it("allows a retry when at least one payment method remains available", () => {
    expect(() =>
      assertCheckoutRetryPaymentMethodsAvailable(["CARD"]),
    ).not.toThrow();
    expect(() => assertCheckoutRetryPaymentMethodsAvailable([])).toThrow(
      ServiceUnavailableException,
    );
    expect(() => assertCheckoutPaymentMethodsAvailable(["CARD"])).toThrow(
      ServiceUnavailableException,
    );
  });

  it("enables the unrelated switches only with explicit true", () => {
    expect(() =>
      assertBindingQuoteFlowsEnabled({ [BINDING_QUOTE_FLOWS_ENV]: "true" }),
    ).not.toThrow();
    expect(() =>
      assertQuotePhotoUploadsEnabled({ [QUOTE_PHOTO_UPLOADS_ENV]: "true" }),
    ).not.toThrow();
  });
});
