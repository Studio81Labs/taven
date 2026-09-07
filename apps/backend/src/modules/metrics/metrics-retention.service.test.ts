import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { MetricsRetentionService } from "./metrics-retention.service";

describe("MetricsRetentionService", () => {
  it("claims and removes one bounded batch of expired observations", async () => {
    let deleteWhere: unknown;
    const service = new MetricsRetentionService({
      $transaction: async (operation: (tx: unknown) => unknown) =>
        operation({
          $queryRaw: async () => [{ id: "event-a" }, { id: "event-b" }],
          businessEvent: {
            deleteMany: async ({ where }: { where: unknown }) => {
              deleteWhere = where;
              return { count: 2 };
            },
          },
        }),
    } as never);
    await expect(service.runOnce(2)).resolves.toBe(2);
    expect(deleteWhere).toEqual({ id: { in: ["event-a", "event-b"] } });
  });

  it("rejects an unbounded cleanup request", async () => {
    const service = new MetricsRetentionService({} as never);
    await expect(service.runOnce(0)).rejects.toThrow(BadRequestException);
  });
});
