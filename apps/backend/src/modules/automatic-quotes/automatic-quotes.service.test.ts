import { GoneException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../prisma/prisma.service";
import { AutomaticQuotesService } from "./automatic-quotes.service";

describe("AutomaticQuotesService", () => {
  it("filters configured delivery options when pricing is unavailable", async () => {
    const priceList = { findUnique: vi.fn().mockResolvedValue(null) };
    const service = new AutomaticQuotesService(
      { priceList } as unknown as PrismaService,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    const deliveryOptions = service as unknown as {
      deliveryOptions: (
        input: undefined,
        client: { priceList: typeof priceList },
        configuredOptions: readonly unknown[],
      ) => Promise<unknown[]>;
    };

    await expect(
      deliveryOptions.deliveryOptions(undefined, { priceList }, [
        {
          endpointType: "pickup_point",
          providerEndpointId: "configured-pickup",
          supportedCategoryIds: ["pickup"],
        },
      ]),
    ).resolves.toEqual([]);
  });

  it.each(["P2002", "23505"])(
    "retries a handoff issuance uniqueness race (%s)",
    async (code) => {
      const transaction = vi
        .fn()
        .mockRejectedValueOnce({ code })
        .mockResolvedValueOnce("canonical response");
      const service = new AutomaticQuotesService(
        { $transaction: transaction } as unknown as PrismaService,
        null as never,
        null as never,
        null as never,
        null as never,
      );

      const handoffIssuance = service as unknown as {
        serializableHandoffIssuance: (
          operation: () => Promise<string>,
        ) => Promise<string>;
      };

      await expect(
        handoffIssuance.serializableHandoffIssuance(async () => "issued"),
      ).resolves.toBe("canonical response");
      expect(transaction).toHaveBeenCalledTimes(2);
    },
  );

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
});
