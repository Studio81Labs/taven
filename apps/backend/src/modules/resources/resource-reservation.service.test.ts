import { describe, expect, it, vi } from "vitest";
import { ResourceValidationError } from "./resource-errors";
import { ResourceReservationService } from "./resource-reservation.service";

const nodeId = "00000000-0000-4000-8000-000000000001";
const planId = "00000000-0000-4000-8000-000000000002";
const setId = "00000000-0000-4000-8000-000000000003";
const productionId = "00000000-0000-4000-8000-000000000004";
const paymentId = "00000000-0000-4000-8000-000000000005";
const expiresAt = new Date("2026-08-30T12:15:00.000Z");

describe("ResourceReservationService", () => {
  it("executes a single database-owned atomic reservation claim", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        phase_reservation_set_id: setId,
        phase_reservation_set_status: "RESERVED",
        expires_at: expiresAt,
      },
    ]);
    const service = new ResourceReservationService({
      $queryRaw: queryRaw,
    } as never);

    await expect(
      service.reserve({
        nodeId,
        phaseResourcePlanId: planId,
        reservationKey: "checkout-attempt-1",
      }),
    ).resolves.toEqual({
      phaseReservationSetId: setId,
      status: "RESERVED",
      expiresAt,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("delegates fresh-plan reacquisition to the persisted payment guard", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        phase_reservation_set_id: setId,
        phase_reservation_set_status: "RESERVED",
        expires_at: expiresAt,
      },
    ]);
    const service = new ResourceReservationService({
      $queryRaw: queryRaw,
    } as never);

    await expect(
      service.reacquireForCapture({
        previousPhaseReservationSetId: setId,
        nodeId,
        phaseResourcePlanId: planId,
        reservationKey: "checkout-retry-1",
        paymentId,
      }),
    ).resolves.toEqual({
      phaseReservationSetId: setId,
      status: "RESERVED",
      expiresAt,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("maps database constraint failures to a conflict without issuing retries", async () => {
    const queryRaw = vi.fn().mockRejectedValue({
      code: "P2010",
      meta: {
        code: "23P01",
        constraint: "capacity_reservations_no_active_overlap",
      },
    });
    const service = new ResourceReservationService({
      $queryRaw: queryRaw,
    } as never);

    await expect(service.releaseBeforePrint(setId)).rejects.toMatchObject({
      name: "ResourceConflictError",
      constraint: "capacity_reservations_no_active_overlap",
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects negative actual consumption before settlement", async () => {
    const queryRaw = vi.fn();
    const service = new ResourceReservationService({
      $queryRaw: queryRaw,
    } as never);

    await expect(
      service.settlePrintingProductionReservation(productionId, -1n),
    ).rejects.toBeInstanceOf(ResourceValidationError);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
