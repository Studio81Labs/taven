import { describe, expect, it } from "vitest";
import {
  approvedCheckoutDocuments,
  checkoutErrorMessage,
  paymentStatusPath,
  paymentReturnMatchesHandoff,
} from "./checkout-flow";
import type { LegalAvailability } from "./legal-availability";

function document(id: string, status: "approved" | "draft" = "approved") {
  const base = {
    id,
    path: `/${id}`,
    title: id,
    summary: id,
    sections: [],
  } as const;
  if (status === "draft") {
    return {
      ...base,
      status,
      effectiveAt: null,
      approvalEvidence: null,
    } as const;
  }
  return {
    ...base,
    status,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    approvalEvidence: "#38",
  } as const;
}

const local = {
  terms: document("terms-v1"),
  claims: document("claims-v1"),
  privacy: document("privacy-v1"),
  prohibitedContent: document("prohibited-v1"),
  retention: document("retention-v1"),
  photoConsent: document("photos-v1"),
};

const availability: LegalAvailability = {
  schemaVersion: 1,
  policyRevision: "test",
  evaluatedAt: "2026-01-01T00:00:00.000Z",
  documents: {
    terms: {
      revision: "terms-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      effective: true,
    },
    claims: {
      revision: "claims-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      effective: true,
    },
    privacy: {
      revision: "privacy-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      effective: true,
    },
    prohibitedContent: {
      revision: "prohibited-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      effective: true,
    },
    retention: {
      revision: "retention-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      effective: true,
    },
    photoConsent: {
      revision: "photos-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      effective: true,
    },
  },
};

describe("checkout flow", () => {
  it("keeps checkout disabled for unavailable, mismatched, or draft documents", () => {
    expect(
      approvedCheckoutDocuments(undefined, local, availability),
    ).toBeNull();
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
        availability,
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
        { ...local, terms: document("terms-pending", "draft") },
        availability,
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
    expect(
      approvedCheckoutDocuments(capabilities, local, availability),
    ).toEqual({
      termsRevision: "terms-v1",
      claimPolicyRevision: "claims-v1",
      photoConsentRevision: null,
    });
  });

  it("rejects approved terms before their effective date", () => {
    expect(
      approvedCheckoutDocuments(
        {
          available: true,
          provider: "sandbox",
          methods: ["CARD"],
          legalDocuments: {
            termsRevision: "terms-v1",
            claimPolicyRevision: "claims-v1",
            photoConsentRevision: null,
          },
        },
        {
          ...local,
          terms: {
            ...local.terms,
            status: "approved",
            effectiveAt: "2999-01-01T00:00:00.000Z",
            approvalEvidence: "#38",
          },
        },
        availability,
      ),
    ).toBeNull();
  });

  it("rejects checkout when any required server approval is unavailable", () => {
    expect(
      approvedCheckoutDocuments(
        {
          available: true,
          provider: "sandbox",
          methods: ["CARD"],
          legalDocuments: {
            termsRevision: "terms-v1",
            claimPolicyRevision: "claims-v1",
            photoConsentRevision: null,
          },
        },
        local,
        {
          ...availability,
          documents: {
            ...availability.documents,
            retention: {
              ...availability.documents.retention,
              effective: false,
            },
          },
        },
      ),
    ).toBeNull();
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
