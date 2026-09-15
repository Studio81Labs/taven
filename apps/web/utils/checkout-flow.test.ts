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
      contentHash: "a".repeat(64),
      effective: true,
    },
    claims: {
      revision: "claims-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      contentHash: "b".repeat(64),
      effective: true,
    },
    privacy: {
      revision: "privacy-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      contentHash: "c".repeat(64),
      effective: true,
    },
    prohibitedContent: {
      revision: "prohibited-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      contentHash: "d".repeat(64),
      effective: true,
    },
    retention: {
      revision: "retention-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      contentHash: "e".repeat(64),
      effective: true,
    },
    photoConsent: {
      revision: "photos-v1",
      status: "approved",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      contentHash: "f".repeat(64),
      effective: true,
    },
  },
};
const verified = {
  terms: true,
  claims: true,
  privacy: true,
  prohibitedContent: true,
  retention: true,
  photoConsent: true,
};

describe("checkout flow", () => {
  it("keeps checkout disabled for unavailable, mismatched, or draft documents", () => {
    expect(
      approvedCheckoutDocuments(undefined, local, availability, verified),
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
        verified,
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
        verified,
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
      approvedCheckoutDocuments(capabilities, local, availability, verified),
    ).toEqual({
      termsRevision: "terms-v1",
      claimPolicyRevision: "claims-v1",
      photoConsentRevision: null,
    });
    expect(
      approvedCheckoutDocuments(capabilities, local, availability, {
        ...verified,
        privacy: false,
      }),
    ).toBeNull();
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
        local,
        {
          ...availability,
          documents: {
            ...availability.documents,
            terms: { ...availability.documents.terms, effective: false },
          },
        },
        verified,
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
        verified,
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
