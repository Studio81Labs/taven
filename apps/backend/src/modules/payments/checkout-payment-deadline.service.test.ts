import { describe, expect, it, vi } from "vitest";
import { CheckoutPaymentDeadlineService } from "./checkout-payment-deadline.service";

describe("CheckoutPaymentDeadlineService", () => {
  it("delegates a bounded expiry batch to the database", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        { payment_id: "00000000-0000-4000-8000-000000000001" },
        { payment_id: "00000000-0000-4000-8000-000000000002" },
      ]);
    const service = new CheckoutPaymentDeadlineService({
      $queryRaw: queryRaw,
    } as never);
    await expect(service.runOnce(25)).resolves.toBe(2);
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.NaN, 1_001])(
    "rejects invalid limit %s",
    async (limit) => {
      const queryRaw = vi.fn();
      const service = new CheckoutPaymentDeadlineService({
        $queryRaw: queryRaw,
      } as never);
      await expect(service.runOnce(limit)).rejects.toThrow("1 through 1000");
      expect(queryRaw).not.toHaveBeenCalled();
    },
  );
});
