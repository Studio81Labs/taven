import { ConflictException } from "@nestjs/common";
import { QuoteRequestStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBusinessHours,
  applyTransition,
  QuotesService,
} from "./quotes.service";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";

afterEach(() => vi.restoreAllMocks());

describe("quote-request SLA", () => {
  it("adds 24 weekday hours without counting the weekend", () => {
    expect(
      addBusinessHours(new Date("2026-08-28T10:30:00.000Z"), 24).toISOString(),
    ).toBe("2026-08-31T10:30:00.000Z");
  });

  it("starts counting when a weekend submission reaches Monday", () => {
    expect(
      addBusinessHours(new Date("2026-08-29T10:30:00.000Z"), 24).toISOString(),
    ).toBe("2026-09-01T00:00:00.000Z");
    expect(
      addBusinessHours(new Date("2026-08-30T23:59:59.999Z"), 24).toISOString(),
    ).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("quote capability expiry clock", () => {
  const token = "q".repeat(43);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const observedAt = new Date("2026-08-30T20:00:00.000Z");
  const future = new Date("2026-08-30T20:30:00.000Z");

  it("uses PostgreSQL time for request expiry and SLA breach", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-08-30T22:00:00.000Z").getTime(),
    );
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ now: observedAt }]),
      quoteRequest: {
        findUnique: vi.fn().mockResolvedValue({
          id: "11111111-1111-4111-8111-111111111111",
          publicReference: "QR-111111111111",
          status: "NEW",
          description: "A valid request description",
          purpose: null,
          measurements: null,
          requestedDate: null,
          contactSnapshot: { name: "Customer", email: "test@example.test" },
          attribution: null,
          slaDueAt: future,
          slaRespondedAt: null,
          quoteSession: { expiresAt: future, publicTokenHash: tokenHash },
          customer: null,
        }),
      },
      photoAsset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new QuotesService(prisma as never, {} as never);

    await expect(
      service.getRequest(
        "11111111-1111-4111-8111-111111111111",
        `Bearer ${token}`,
      ),
    ).resolves.toMatchObject({
      requestId: "11111111-1111-4111-8111-111111111111",
      slaBreached: false,
    });
  });

  it("uses PostgreSQL time for offer preview expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-08-30T22:00:00.000Z").getTime(),
    );
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ now: observedAt }]),
      quote: {
        findUnique: vi.fn().mockResolvedValue({
          id: "22222222-2222-4222-8222-222222222222",
          publicTokenHash: tokenHash,
          version: 1,
          summary: "Valid offer",
          termsRevision: "terms-v1",
          termsSnapshot: {},
          promisedDate: null,
          expiresAt: future,
          quoteRequest: { status: "QUOTED" },
          items: [],
          deliveryDestination: {
            providerEndpointId: "test-endpoint",
            endpointType: "DELIVERY",
            addressSnapshot: { country: "CZ" },
            capabilitySnapshot: { carrier: "test" },
          },
          shipmentPlans: [
            {
              category: "STANDARD",
              plannedVolumeCubicMm: 1n,
              plannedWeightMilligrams: 1n,
              shippingAmountMinor: 0n,
              packagingAmountMinor: 0n,
              handlingAmountMinor: 0n,
              allocationSnapshot: {
                packingUnits: [],
                details: {},
              },
            },
          ],
          priceBinding: {
            priceSnapshot: {
              currency: "CZK",
              contractTotalMinor: 1_000n,
              taxRegime: "NON_VAT_PAYER",
              vatRateBasisPoints: 0,
              netAmountMinor: 1_000n,
              vatAmountMinor: 0n,
              components: [],
              paymentSchedules: [],
            },
          },
        }),
      },
    };
    const service = new QuotesService(prisma as never, {} as never);

    await expect(
      service.previewOffer(
        "22222222-2222-4222-8222-222222222222",
        `Bearer ${token}`,
      ),
    ).resolves.toMatchObject({
      quoteId: "22222222-2222-4222-8222-222222222222",
      contractTotalMinor: 1_000,
      taxRegime: "NON_VAT_PAYER",
      netAmountMinor: 1_000,
      vatAmountMinor: 0,
    });
  });
});

describe("operator quote-request page", () => {
  it("hydrates attachments through the page transaction", async () => {
    const observedAt = new Date("2026-09-08T21:00:00.000Z");
    const requestId = "11111111-1111-4111-8111-111111111111";
    const transactionAttachments = { findMany: vi.fn().mockResolvedValue([]) };
    const rootAttachments = { findMany: vi.fn() };
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ now: observedAt }])
        .mockResolvedValueOnce([{ id: requestId }]),
      quoteRequest: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: requestId,
            publicReference: "QR-111111111111",
            status: QuoteRequestStatus.NEW,
            description: "A valid request description",
            purpose: null,
            measurements: null,
            requestedDate: null,
            contactSnapshot: { name: "Customer", email: "test@example.test" },
            attribution: null,
            slaDueAt: new Date("2026-09-09T21:00:00.000Z"),
            slaRespondedAt: null,
            createdAt: observedAt,
            quoteSession: null,
            customer: null,
            quote: null,
            automaticQuoteHandoff: null,
            photoPublicationConsentGrantedAt: null,
          },
        ]),
      },
      photoAsset: transactionAttachments,
    };
    const prisma = {
      $transaction: vi.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
      photoAsset: rootAttachments,
    };
    const service = new QuotesService(prisma as never, {} as never);

    await service.listRequestsPage(
      {
        operatorId: "22222222-2222-4222-8222-222222222222",
        role: "VIEWER",
        permissions: [OPERATOR_PERMISSIONS.OPERATIONS_READ],
        nodeIds: ["33333333-3333-4333-8333-333333333333"],
        authenticationMethod: "DEVELOPMENT_PASSWORD",
        sessionId: "44444444-4444-4444-8444-444444444444",
      },
      { limit: 1 },
    );

    expect(transactionAttachments.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scopeId: requestId }),
      }),
    );
    expect(rootAttachments.findMany).not.toHaveBeenCalled();
  });
});

describe("quote transition error mapping", () => {
  const request = {
    id: "11111111-1111-4111-8111-111111111111",
    status: QuoteRequestStatus.NEW,
    currentStateCommandKey: "create-request",
    currentStateResultId: "22222222-2222-4222-8222-222222222222",
  };

  it("maps expected domain transition failures to conflict", async () => {
    await expect(
      applyTransition(
        request,
        QuoteRequestStatus.ACCEPTED,
        "invalid-transition",
        undefined,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("lets unexpected programming failures propagate", async () => {
    await expect(
      applyTransition(
        {
          ...request,
          status: 42 as unknown as QuoteRequestStatus,
        },
        QuoteRequestStatus.IN_REVIEW,
        "unexpected-failure",
        undefined,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
