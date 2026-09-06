import { describe, expect, it, vi } from "vitest";
import {
  CHECKOUT_CLAIM_POLICY_REVISION_ENV,
  CHECKOUT_CLAIM_WINDOW_DAYS_ENV,
  CHECKOUT_PAYMENT_FLOWS_ENV,
  CHECKOUT_PHOTO_CONSENT_REVISION_ENV,
  CHECKOUT_TERMS_REVISION_ENV,
} from "../../launch-approval-gates";
import {
  checkoutContactSnapshotMatches,
  PaymentsService,
  publicSiteUrl,
} from "./payments.service";

describe("checkout contact snapshot compatibility", () => {
  const input = {
    email: "ada@example.test",
    fullName: "Ada Lovelace",
    billing: {
      name: "Ada Lovelace",
      addressLine1: "Nová 12",
      city: "Brno",
      postalCode: "602 00",
      countryCode: "CZ",
    },
  };

  it("preserves pre-migration contact-only checkout retries", () => {
    expect(
      checkoutContactSnapshotMatches(
        { email: input.email, fullName: input.fullName },
        input,
      ),
    ).toBe(true);
  });

  it("requires exact billing evidence for version 2 snapshots", () => {
    const snapshot = { version: 2, ...input };
    expect(checkoutContactSnapshotMatches(snapshot, input)).toBe(true);
    expect(
      checkoutContactSnapshotMatches(snapshot, {
        ...input,
        billing: { ...input.billing, city: "Praha" },
      }),
    ).toBe(false);
  });
});

describe("payment capabilities", () => {
  it("hides provider methods while checkout is disabled", async () => {
    const capabilities = vi.fn().mockResolvedValue({
      provider: "comgate",
      methods: ["CARD", "BANK_TRANSFER"],
    });
    const service = new PaymentsService(
      {} as never,
      { capabilities } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.capabilities({})).resolves.toEqual({
      available: false,
      provider: "disabled",
      methods: [],
      legalDocuments: null,
    });
    expect(capabilities).not.toHaveBeenCalled();

    for (const env of [
      { [CHECKOUT_PAYMENT_FLOWS_ENV]: "true" },
      {
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_TERMS_REVISION_ENV]: "terms-pending",
        [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: "claims-v1-approved",
        [CHECKOUT_CLAIM_WINDOW_DAYS_ENV]: "30",
      },
      {
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_TERMS_REVISION_ENV]: "terms-v1-approved",
        [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: "claims-draft-v1",
      },
    ]) {
      await expect(service.capabilities(env)).resolves.toEqual({
        available: false,
        provider: "disabled",
        methods: [],
        legalDocuments: null,
      });
    }
    expect(capabilities).not.toHaveBeenCalled();

    await expect(
      service.capabilities({
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_TERMS_REVISION_ENV]: "terms-v1-approved",
        [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: "claims-v1-approved",
        [CHECKOUT_CLAIM_WINDOW_DAYS_ENV]: "30",
      }),
    ).resolves.toEqual({
      available: true,
      provider: "comgate",
      methods: ["CARD", "BANK_TRANSFER"],
      legalDocuments: {
        claimPolicyRevision: "claims-v1-approved",
        photoConsentRevision: null,
        termsRevision: "terms-v1-approved",
      },
    });
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it("hides incomplete provider methods while checkout cannot launch", async () => {
    const capabilities = vi.fn().mockResolvedValue({
      provider: "comgate",
      methods: ["CARD"],
    });
    const service = new PaymentsService(
      {} as never,
      { capabilities } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.capabilities({
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_TERMS_REVISION_ENV]: "terms-v1-approved",
        [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: "claims-v1-approved",
        [CHECKOUT_CLAIM_WINDOW_DAYS_ENV]: "30",
      }),
    ).resolves.toEqual({
      available: false,
      provider: "disabled",
      methods: [],
      legalDocuments: null,
    });
  });

  it("publishes an optional approved photo-consent revision", async () => {
    const service = new PaymentsService(
      {} as never,
      {
        capabilities: vi.fn().mockResolvedValue({
          provider: "comgate",
          methods: ["CARD", "BANK_TRANSFER"],
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.capabilities({
        [CHECKOUT_PAYMENT_FLOWS_ENV]: "true",
        [CHECKOUT_TERMS_REVISION_ENV]: "terms-v1-approved",
        [CHECKOUT_CLAIM_POLICY_REVISION_ENV]: "claims-v1-approved",
        [CHECKOUT_CLAIM_WINDOW_DAYS_ENV]: "30",
        [CHECKOUT_PHOTO_CONSENT_REVISION_ENV]: "photos-v1-approved",
      }),
    ).resolves.toMatchObject({
      legalDocuments: { photoConsentRevision: "photos-v1-approved" },
    });
  });
});

describe("provider event verification time", () => {
  it("uses database time when the provider has no occurrence timestamp", async () => {
    const observedAt = new Date("2026-09-04T12:00:00Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ observed_at: observedAt }])
      .mockResolvedValueOnce([{ outcome: "PENDING" }]);
    const service = new PaymentsService(
      {
        $transaction: vi.fn(
          async (
            work: (transaction: {
              payment: { findFirst: () => Promise<{ id: string }> };
            }) => unknown,
          ) =>
            work({
              payment: {
                findFirst: async () => ({
                  id: "00000000-0000-4000-8000-000000000001",
                }),
              },
            }),
        ),
        $queryRaw: queryRaw,
      } as never,
      {
        providerName: () => "comgate",
        locateEvent: () => ({
          providerTransactionId: "comgate-payment-1",
          merchantReference: "00000000-0000-4000-8000-000000000001",
        }),
        verifyEvent: vi.fn().mockResolvedValue({
          provider: "comgate",
          providerEventId: "comgate:event-1",
          providerTransactionId: "comgate-payment-1",
          merchantReference: "00000000-0000-4000-8000-000000000001",
          status: "PENDING",
          amountMinor: 12_300n,
          currency: "CZK",
          occurredAt: null,
          evidence: { source: "authenticated-status-api" },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.consumeProviderEvent("comgate", {}, {}),
    ).resolves.toEqual({ outcome: "PENDING" });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[1]?.[7]).toBe(observedAt);
  });
});

describe("payment return site URL", () => {
  it("requires an explicitly configured HTTPS origin in production", () => {
    expect(() => publicSiteUrl({ NODE_ENV: "production" })).toThrow(
      "TAVEN_PUBLIC_SITE_URL is required in production",
    );
    expect(() =>
      publicSiteUrl({
        NODE_ENV: "production",
        TAVEN_PUBLIC_SITE_URL: "http://taven.cz",
      }),
    ).toThrow("TAVEN_PUBLIC_SITE_URL must use HTTPS in production");
    expect(
      publicSiteUrl({
        NODE_ENV: "production",
        TAVEN_PUBLIC_SITE_URL: "https://taven.cz/",
      }),
    ).toBe("https://taven.cz");
  });

  it("retains HTTP support for local development", () => {
    expect(publicSiteUrl({})).toBe("http://localhost:3000");
    expect(
      publicSiteUrl({ TAVEN_PUBLIC_SITE_URL: "http://127.0.0.1:3000/" }),
    ).toBe("http://127.0.0.1:3000");
  });
});
