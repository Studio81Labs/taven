import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import { SlicingResultIngestionService } from "./slicing-result-ingestion.service";

describe("slicing result ingestion", () => {
  it("requires manual reconciliation while refund work is pending or suspended", async () => {
    const queryRaw = vi.fn(
      (strings: TemplateStringsArray): Promise<Array<{ safe: boolean }>> => {
        expect(strings.join("?")).toContain(
          "refund.status IN ('PENDING', 'SUSPENDED')",
        );
        return Promise.resolve([{ safe: false }]);
      },
    );
    const transaction = {
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;
    const service = new SlicingResultIngestionService(
      {} as unknown as PrismaService,
    ) as unknown as {
      canCancelPreProductionOrder(
        transaction: Prisma.TransactionClient,
        orderId: string,
        failedJobId: string,
      ): Promise<boolean>;
    };

    await expect(
      service.canCancelPreProductionOrder(
        transaction,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).resolves.toBe(false);
    expect(queryRaw).toHaveBeenCalledOnce();
  });
});
