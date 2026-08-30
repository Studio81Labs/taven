import { ConflictException } from "@nestjs/common";
import { QuoteRequestStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBusinessHours,
  applyTransition,
  QuotesService,
} from "./quotes.service";

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
    ).toBe("2026-09-01T00:30:00.000Z");
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
    const service = new QuotesService(prisma as never);

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
          priceBinding: {
            priceSnapshot: {
              currency: "CZK",
              contractTotalMinor: 1_000n,
              components: [],
              paymentSchedules: [],
            },
          },
        }),
      },
    };
    const service = new QuotesService(prisma as never);

    await expect(
      service.previewOffer(
        "22222222-2222-4222-8222-222222222222",
        `Bearer ${token}`,
      ),
    ).resolves.toMatchObject({
      quoteId: "22222222-2222-4222-8222-222222222222",
      contractTotalMinor: 1_000,
    });
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
