import { describe, expect, it } from "vitest";
import {
  approvedCheckoutDocuments,
  checkoutErrorMessage,
  paymentStatusPath,
  paymentReturnMatchesHandoff,
} from "./checkout-flow";

const local = {
  terms: "terms-v1",
  claims: "claims-v1",
  photoConsent: "photos-v1",
};

describe("checkout flow", () => {
  it("keeps checkout disabled for unavailable, mismatched, or draft documents", () => {
    expect(approvedCheckoutDocuments(undefined, local)).toBeNull();
    expect(
      approvedCheckoutDocuments(
        {
          available: true,
          provider: "sandbox",
          methods: ["CARD", "BANK_TRANSFER"],
          legalDocuments: {
            termsRevision: "terms-v0",
            claimPolicyRevision: "claims-v1",
            photoConsentRevision: "photos-v1",
          },
        },
        local,
      ),
    ).toBeNull();
    expect(
      approvedCheckoutDocuments(
        {
          available: true,
          provider: "sandbox",
          methods: ["CARD", "BANK_TRANSFER"],
          legalDocuments: {
            termsRevision: "terms-pending",
            claimPolicyRevision: "claims-v1",
            photoConsentRevision: null,
          },
        },
        { ...local, terms: "terms-pending" },
      ),
    ).toBeNull();
  });

  it("binds approved required documents and independently gates photo consent", () => {
    const capabilities = {
      available: true,
      provider: "comgate",
      methods: ["CARD", "BANK_TRANSFER"] as Array<"CARD" | "BANK_TRANSFER">,
      legalDocuments: {
        termsRevision: "terms-v1",
        claimPolicyRevision: "claims-v1",
        photoConsentRevision: "photo-consent-pending",
      },
    };
    expect(approvedCheckoutDocuments(capabilities, local)).toEqual({
      termsRevision: "terms-v1",
      claimPolicyRevision: "claims-v1",
      photoConsentRevision: null,
    });
  });

  it("maps recoverable API failures and creates an exact payment status URL", () => {
    for (const status of [409, 503]) {
      expect(checkoutErrorMessage(status)).toContain("zůstal");
    }
    expect(checkoutErrorMessage(410)).toContain("novou kalkulaci");
    expect(checkoutErrorMessage(410)).not.toContain("zůstal");
    expect(paymentStatusPath("pending", "session a", "payment/b")).toBe(
      "/checkout/payment/pending?sessionId=session+a&paymentId=payment%2Fb",
    );
    expect(paymentReturnMatchesHandoff("payment-a", "payment-a")).toBe(true);
    expect(paymentReturnMatchesHandoff("payment-a", "payment-b")).toBe(false);
    expect(paymentReturnMatchesHandoff(undefined, "payment-a")).toBe(false);
  });
});
