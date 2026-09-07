import { GoneException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../prisma/prisma.service";
import { AutomaticQuotesService } from "./automatic-quotes.service";

type HandoffSnapshotPreparer = {
  prepareHandoffSnapshot: () => Promise<{
    sourceVersion: string;
    snapshot: null;
  }>;
};

describe("AutomaticQuotesService", () => {
  it("uses the locked transaction's database clock to reject expired observations", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const token = "a".repeat(43);
    const databaseNow = new Date("2026-09-07T12:00:00.000Z");
    const upsert = vi.fn();
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: sessionId }])
        .mockResolvedValueOnce([{ observed_at: databaseNow }]),
      quoteSession: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: sessionId,
          publicTokenHash: createHash("sha256").update(token).digest("hex"),
          status: "OPEN",
          expiresAt: new Date("2026-09-07T11:59:59.999Z"),
        }),
      },
      automaticOrderOrigin: { findUnique: vi.fn() },
      businessEvent: { upsert },
    };
    const prisma = {
      $transaction: (operation: (client: typeof transaction) => unknown) =>
        operation(transaction),
    };
    const service = new AutomaticQuotesService(
      prisma as unknown as PrismaService,
      null as never,
      null as never,
      null as never,
      null as never,
    );

    await expect(
      service.recordObservation(
        sessionId,
        { eventType: "quote.viewed" },
        `Bearer ${token}`,
      ),
    ).rejects.toBeInstanceOf(GoneException);

    expect(transaction.automaticOrderOrigin.findUnique).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("uses the locked transaction's database clock to allow an active source handoff", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const token = "b".repeat(43);
    const databaseNow = new Date("2026-09-07T12:00:00.000Z");
    const capabilityKey =
      "test-automatic-quote-capability-key-at-least-32-characters";
    const capabilityKeyId = createHash("sha256")
      .update("taven-quote-capability-key\0")
      .update(capabilityKey)
      .digest("hex");
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: sessionId }])
        .mockResolvedValueOnce([{ observed_at: databaseNow }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ observed_at: databaseNow }])
        .mockResolvedValueOnce([{ id: "handoff-id" }])
        .mockResolvedValueOnce([{ observed_at: databaseNow }]),
      quoteSession: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: sessionId,
          publicTokenHash: createHash("sha256").update(token).digest("hex"),
          capabilityKeyId,
          status: "OPEN",
          expiresAt: new Date("2026-09-07T12:00:01.000Z"),
        }),
      },
      idempotencyRecord: { findFirst: vi.fn().mockResolvedValue(null) },
      automaticQuoteHandoffCapability: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "handoff-id",
          consumedAt: null,
          expiresAt: new Date("2026-09-07T12:00:10.000Z"),
        }),
      },
    };
    const prisma = {
      $transaction: (operation: (client: typeof transaction) => unknown) =>
        operation(transaction),
    };
    const previousCapabilityKey = process.env.TAVEN_QUOTE_CAPABILITY_KEY;
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date("2026-09-07T12:00:02.000Z").getTime());
    process.env.TAVEN_QUOTE_CAPABILITY_KEY = capabilityKey;
    try {
      const service = new AutomaticQuotesService(
        prisma as unknown as PrismaService,
        null as never,
        null as never,
        null as never,
        null as never,
      );
      vi.spyOn(
        service as unknown as HandoffSnapshotPreparer,
        "prepareHandoffSnapshot",
      ).mockResolvedValue({
        sourceVersion: "unchanged-source",
        snapshot: null,
      });

      await expect(
        service.createHandoffCapability(
          sessionId,
          `Bearer ${token}`,
          "handoff-clock-skew",
        ),
      ).resolves.toMatchObject({
        expiresAt: "2026-09-07T12:00:10.000Z",
      });
    } finally {
      clock.mockRestore();
      if (previousCapabilityKey === undefined) {
        delete process.env.TAVEN_QUOTE_CAPABILITY_KEY;
      } else {
        process.env.TAVEN_QUOTE_CAPABILITY_KEY = previousCapabilityKey;
      }
    }
  });
});
