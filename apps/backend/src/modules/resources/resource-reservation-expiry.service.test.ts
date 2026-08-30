import { describe, expect, it, vi } from "vitest";
import { ResourceReservationExpiryService } from "./resource-reservation-expiry.service";

describe("ResourceReservationExpiryService", () => {
  it("runs one bounded skip-locked database expiry sweep", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        { phase_reservation_set_id: "00000000-0000-4000-8000-000000000001" },
        { phase_reservation_set_id: "00000000-0000-4000-8000-000000000002" },
      ]);
    const service = new ResourceReservationExpiryService({
      $queryRaw: queryRaw,
    } as never);

    await expect(service.runOnce(25)).resolves.toBe(2);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN, 1_001])(
    "rejects invalid batch limit %s before querying",
    async (limit) => {
      const queryRaw = vi.fn();
      const service = new ResourceReservationExpiryService({
        $queryRaw: queryRaw,
      } as never);

      await expect(service.runOnce(limit)).rejects.toThrow(
        "resource reservation expiry worker limit must be 1 through 1000",
      );
      expect(queryRaw).not.toHaveBeenCalled();
    },
  );
});
