import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  it("keeps base reacquisition validation and fencing ahead of its mutation locks", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260830223000_resource_reservation_execution/migration.sql",
      ),
      "utf8",
    );
    const reacquire = migration.slice(
      migration.indexOf(
        "CREATE FUNCTION taven_reacquire_phase_reservation_for_capture(",
      ),
    );
    const validation = reacquire.indexOf(
      "IF target_reservation_key IS NULL OR btrim(target_reservation_key) = ''",
    );
    const reservationFence = reacquire.indexOf(
      "PERFORM pg_advisory_xact_lock(hashtextextended(target_reservation_key, 0));",
    );
    const orderLock = reacquire.indexOf(
      "PERFORM taven_lock_automatic_order_session(target_order_id);",
    );
    const identityValidation = reacquire.indexOf(
      "IS DISTINCT FROM previous_phase_reservation_set_id",
    );
    const replayReturn = reacquire.indexOf(
      'SELECT existing_replacement_set."id",',
    );

    expect(validation).toBeGreaterThanOrEqual(0);
    expect(reservationFence).toBeGreaterThan(validation);
    expect(identityValidation).toBeGreaterThan(reservationFence);
    expect(replayReturn).toBeGreaterThan(identityValidation);
    expect(orderLock).toBeGreaterThan(reservationFence);
  });

  it("locks the checkout envelope before release and reacquisition resources", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260904220000_checkout_payment_capture/migration.sql",
      ),
      "utf8",
    );
    const release = migration.slice(
      migration.indexOf(
        "CREATE FUNCTION taven_release_checkout_phase_reservation_set(",
      ),
      migration.indexOf(
        "-- Preserve the reservation-key fence as the first blocking lock",
      ),
    );
    const reacquire = migration.slice(
      migration.indexOf(
        "CREATE FUNCTION taven_reacquire_phase_reservation_for_capture(",
      ),
      migration.indexOf("-- Close one initial checkout attempt"),
    );

    expect(
      release.indexOf("taven_lock_checkout_payment_envelope"),
    ).toBeLessThan(release.indexOf("FOR UPDATE OF reservation_set"));
    expect(release.indexOf("FOR UPDATE OF reservation_set")).toBeLessThan(
      release.indexOf("taven_release_phase_reservation_set"),
    );
    expect(reacquire.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      reacquire.indexOf("taven_lock_checkout_payment_envelope"),
    );
    expect(
      reacquire.indexOf("taven_lock_checkout_payment_envelope"),
    ).toBeLessThan(
      reacquire.indexOf(
        "taven_reacquire_phase_reservation_after_checkout_lock",
      ),
    );
  });

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

  it("uses the checkout lock envelope for pre-capture release", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ released: true }]);
    const service = new ResourceReservationService({
      $queryRaw: queryRaw,
    } as never);

    await expect(service.releaseBeforeCapture(paymentId, setId)).resolves.toBe(
      true,
    );
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
