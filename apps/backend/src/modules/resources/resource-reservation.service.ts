import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  ResourceConflictError,
  ResourceNotFoundError,
  ResourceValidationError,
} from "./resource-errors";

export type PhaseReservationSetStatus =
  "RESERVED" | "HELD" | "SETTLED" | "RELEASED" | "EXPIRED";

export type CreatePhaseReservationInput = {
  nodeId: string;
  phaseResourcePlanId: string;
  reservationKey: string;
};

export type ReacquirePhaseReservationForCaptureInput =
  CreatePhaseReservationInput & {
    previousPhaseReservationSetId: string;
    paymentId: string;
  };

export type PhaseReservationResult = {
  phaseReservationSetId: string;
  status: PhaseReservationSetStatus;
  expiresAt: Date;
};

type ReservationRow = {
  phase_reservation_set_id: string;
  phase_reservation_set_status: PhaseReservationSetStatus;
  expires_at: Date;
};

type SettlementRow = {
  phase_reservation_set_status: PhaseReservationSetStatus;
};

function nonBlank(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ResourceValidationError(`${name} must not be blank`);
  }
  return normalized;
}

function prismaConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("meta" in error)) return;
  const meta = error.meta;
  if (!meta || typeof meta !== "object") return;
  if ("constraint" in meta && typeof meta.constraint === "string") {
    return meta.constraint;
  }
  return;
}

function rawDatabaseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("meta" in error)) return;
  const meta = error.meta;
  if (!meta || typeof meta !== "object") return;
  if ("code" in meta && typeof meta.code === "string") return meta.code;
  return;
}

function reservationWriteError(error: unknown): never {
  if (
    error instanceof ResourceConflictError ||
    error instanceof ResourceNotFoundError ||
    error instanceof ResourceValidationError
  ) {
    throw error;
  }

  const prismaCode =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const databaseCode = rawDatabaseCode(error);
  const constraint = prismaConstraint(error);

  if (prismaCode === "P2003" || databaseCode === "23503") {
    throw new ResourceNotFoundError("reservation resource was not found");
  }
  if (databaseCode === "22003" || databaseCode === "22023") {
    throw new ResourceValidationError("reservation request is invalid");
  }
  if (
    prismaCode === "P2002" ||
    prismaCode === "P2010" ||
    databaseCode === "23505" ||
    databaseCode === "23514" ||
    databaseCode === "23P01"
  ) {
    throw new ResourceConflictError(
      "reservation conflicts with the current resource state",
      constraint,
    );
  }
  throw error;
}

function toReservationResult(row: ReservationRow): PhaseReservationResult {
  return {
    phaseReservationSetId: row.phase_reservation_set_id,
    status: row.phase_reservation_set_status,
    expiresAt: row.expires_at,
  };
}

/**
 * Internal orchestration API for executing an immutable PhaseResourcePlan.
 *
 * Each operation delegates to one database function: the database is the
 * transaction boundary for child creation, inventory accounting, capacity
 * exclusion, and deferred set-completeness checks.
 */
@Injectable()
export class ResourceReservationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async reserve(
    input: CreatePhaseReservationInput,
  ): Promise<PhaseReservationResult> {
    const reservationKey = nonBlank(input.reservationKey, "reservationKey");
    try {
      const rows = await this.prisma.$queryRaw<ReservationRow[]>`
        SELECT
          phase_reservation_set_id,
          phase_reservation_set_status,
          expires_at
        FROM taven_create_phase_reservation(
          ${input.nodeId}::uuid,
          ${input.phaseResourcePlanId}::uuid,
          ${reservationKey}
        )
      `;
      const row = rows[0];
      if (!row) throw new Error("reservation creation returned no result");
      return toReservationResult(row);
    } catch (error) {
      return reservationWriteError(error);
    }
  }

  /**
   * The database locks and verifies the persisted Payment authorization and
   * immutable capture window; caller-supplied booleans or timestamps are not
   * trusted as payment evidence.
   */
  async reacquireForCapture(
    input: ReacquirePhaseReservationForCaptureInput,
  ): Promise<PhaseReservationResult> {
    const reservationKey = nonBlank(input.reservationKey, "reservationKey");

    try {
      const rows = await this.prisma.$queryRaw<ReservationRow[]>`
        SELECT
          phase_reservation_set_id,
          phase_reservation_set_status,
          expires_at
        FROM taven_reacquire_phase_reservation_for_capture(
          ${input.previousPhaseReservationSetId}::uuid,
          ${input.nodeId}::uuid,
          ${input.phaseResourcePlanId}::uuid,
          ${reservationKey},
          ${input.paymentId}::uuid
        )
      `;
      const row = rows[0];
      if (!row) throw new Error("reservation reacquisition returned no result");
      return toReservationResult(row);
    } catch (error) {
      return reservationWriteError(error);
    }
  }

  /** Releases every pre-print child of a set; printing or consumed work is rejected. */
  async releaseBeforePrint(phaseReservationSetId: string): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ released: boolean }>>`
        SELECT taven_release_phase_reservation_set(
          ${phaseReservationSetId}::uuid
        ) AS released
      `;
      return rows[0]?.released ?? false;
    } catch (error) {
      return reservationWriteError(error);
    }
  }

  /** Releases one failed held/scheduled production group and keeps siblings intact. */
  async releaseProductionBeforePrint(
    productionReservationId: string,
  ): Promise<PhaseReservationSetStatus> {
    try {
      const rows = await this.prisma.$queryRaw<SettlementRow[]>`
        SELECT taven_release_production_reservation_before_print(
          ${productionReservationId}::uuid
        ) AS phase_reservation_set_status
      `;
      const status = rows[0]?.phase_reservation_set_status;
      if (!status) throw new Error("production release returned no result");
      return status;
    } catch (error) {
      return reservationWriteError(error);
    }
  }

  /**
   * Records the actual material consumed while printing. Inventory's trigger
   * releases the reserved remainder, while completed capacity is removed from
   * the active capacity-exclusion range.
   */
  async settlePrintingProductionReservation(
    productionReservationId: string,
    actualConsumedMilligrams: bigint,
  ): Promise<PhaseReservationSetStatus> {
    if (actualConsumedMilligrams < 0n) {
      throw new ResourceValidationError(
        "actualConsumedMilligrams must be non-negative",
      );
    }
    try {
      const rows = await this.prisma.$queryRaw<SettlementRow[]>`
        SELECT taven_settle_printing_production_reservation(
          ${productionReservationId}::uuid,
          ${actualConsumedMilligrams}
        ) AS phase_reservation_set_status
      `;
      const status = rows[0]?.phase_reservation_set_status;
      if (!status) throw new Error("production settlement returned no result");
      return status;
    } catch (error) {
      return reservationWriteError(error);
    }
  }
}
