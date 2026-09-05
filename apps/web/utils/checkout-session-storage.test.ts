import { describe, expect, it } from "vitest";
import {
  clearCheckoutSession,
  checkoutRequestFingerprint,
  finalizeCapturedCheckoutStorage,
  loadCheckoutSession,
  recoverableCheckoutDraft,
  redactCheckoutCustomerInput,
  saveCheckoutSession,
  type StoredCheckoutSession,
} from "./checkout-session-storage";
import {
  loadPaymentReturnSession,
  loadQuoteSession,
  saveQuoteSession,
} from "./quote-session-storage";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const stored: StoredCheckoutSession = {
  sessionId: "session-a",
  draft: {
    acceptClaimPolicy: true,
    acceptTerms: true,
    acknowledgeWithdrawalException: true,
    billing: {
      name: "Ada Lovelace",
      addressLine1: "Nová 12",
      city: "Brno",
      postalCode: "602 00",
      countryCode: "CZ",
    },
    email: "ada@example.test",
    fullName: "Ada Lovelace",
    method: "CARD",
    photoPublicationConsent: false,
  },
  command: {
    idempotencyKey: "checkout-command-1",
    paymentId: "payment-a",
    requestFingerprint: "fingerprint-a",
  },
};

describe("checkout session storage", () => {
  it("round-trips recoverable checkout input for the exact quote session", () => {
    const storage = new MemoryStorage();
    expect(saveCheckoutSession(storage, stored)).toBe(true);
    expect(loadCheckoutSession(storage, "session-a")).toEqual(stored);
    expect(loadCheckoutSession(storage, "session-b")).toBeUndefined();
  });

  it("retains the exact payment handoff while redacting customer input", () => {
    const storage = new MemoryStorage();
    saveCheckoutSession(storage, stored);
    expect(redactCheckoutCustomerInput(storage, "session-a")).toBe(true);
    expect(loadCheckoutSession(storage, "session-a")).toEqual({
      sessionId: "session-a",
      command: stored.command,
    });
    expect([...storage.values.values()][0]).not.toContain("ada@example.test");
  });

  it("finalizes captured checkout storage without dropping payment credentials", () => {
    const storage = new MemoryStorage();
    saveQuoteSession(storage, {
      expiresAt: "2030-01-01T00:00:00.000Z",
      filename: "part.stl",
      publicReference: "TAV-123",
      sessionId: "session-a",
      sessionToken: "secret-capability",
    });
    saveCheckoutSession(storage, stored);

    finalizeCapturedCheckoutStorage(storage, "session-a", "payment-a");

    expect(loadQuoteSession(storage, Date.parse("2029-01-01"))).toBeUndefined();
    expect(loadPaymentReturnSession(storage)).toMatchObject({
      capturedPaymentId: "payment-a",
      sessionId: "session-a",
      sessionToken: "secret-capability",
    });
    expect(loadCheckoutSession(storage, "session-a")).toEqual({
      sessionId: "session-a",
      command: stored.command,
    });
  });

  it("uses a canonical request fingerprint for safe idempotent retries", () => {
    expect(checkoutRequestFingerprint({ b: 2, a: { d: 4, c: 3 } })).toBe(
      checkoutRequestFingerprint({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(checkoutRequestFingerprint({ a: 1 })).not.toBe(
      checkoutRequestFingerprint({ a: 2 }),
    );
  });

  it("never treats restored checkboxes as fresh legal acceptance", () => {
    expect(recoverableCheckoutDraft(stored.draft!)).toMatchObject({
      acceptClaimPolicy: false,
      acceptTerms: false,
      acknowledgeWithdrawalException: false,
      photoPublicationConsent: false,
      email: "ada@example.test",
    });
  });

  it("removes malformed or cross-session state", () => {
    const storage = new MemoryStorage();
    storage.setItem("taven:checkout-session:v1", "not-json");
    expect(loadCheckoutSession(storage, "session-a")).toBeUndefined();
    expect(storage.values.size).toBe(0);
  });

  it("clears checkout state when starting a fresh quote", () => {
    const storage = new MemoryStorage();
    saveCheckoutSession(storage, stored);
    expect(clearCheckoutSession(storage)).toBe(true);
    expect(loadCheckoutSession(storage, "session-a")).toBeUndefined();
  });
});
