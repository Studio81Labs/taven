import { describe, expect, it, vi } from "vitest";
import { BalancePaymentDeadlineService } from "./balance-payment-deadline.service";

describe("BalancePaymentDeadlineService", () => {
  it("runs the database-owned bounded expiry batch and returns its processed count", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        payment_id: "00000000-0000-4000-8000-000000000001",
        settlement_id: "00000000-0000-4000-8000-000000000002",
      },
      {
        payment_id: "00000000-0000-4000-8000-000000000003",
        settlement_id: "00000000-0000-4000-8000-000000000004",
      },
    ]);
    const service = new BalancePaymentDeadlineService({
      $queryRaw: queryRaw,
    } as never);

    await expect(service.runOnce(25)).resolves.toBe(2);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN, 1_001])(
    "rejects invalid batch limit %s before querying",
    async (limit) => {
      const queryRaw = vi.fn();
      const service = new BalancePaymentDeadlineService({
        $queryRaw: queryRaw,
      } as never);

      await expect(service.runOnce(limit)).rejects.toThrow(
        "balance payment deadline worker limit must be 1 through 1000",
      );
      expect(queryRaw).not.toHaveBeenCalled();
    },
  );
});
