import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  FulfilmentSlotResourceInput,
  ResourceCandidateEstimate,
  ResourceCapacityInterval,
  ResourceInventoryAvailability,
} from "@taven/core" with { "resolution-mode": "import" };
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  ResourceConflictError,
  ResourceNotFoundError,
  ResourceValidationError,
} from "./resource-errors";

const MINIMUM_RESERVABLE_MILLISECONDS = 15 * 60 * 1_000;
const ELIGIBILITY_TTL_MILLISECONDS = 30 * 60 * 1_000;

type SlotRow = {
  id: string;
  packing_unit_key: string;
  order_item_id: string;
  item_ordinal: number;
  model_geometry_id: string;
  print_config_revision_id: string;
  material: string;
  color: string | null;
  shipment_plan_id: string;
};

type CandidateRow = {
  id: string;
  estimate_key: string;
  node_id: string;
  machine_id: string;
  machine_profile_id: string;
  machine_calibration_id: string;
  inventory_id: string;
  shipment_plan_id: string;
  model_geometry_id: string;
  print_config_revision_id: string;
  material: string;
  color: string | null;
  quantity: number;
  required_material_milligrams: bigint;
  required_machine_seconds: bigint;
  expires_at: Date;
  interval_id: string;
  interval_index: number;
  starts_at: Date;
  ends_at: Date;
  remaining_milligrams: bigint;
  reserved_milligrams: bigint;
};

type OccupiedRow = {
  machine_id: string;
  starts_at: Date;
  ends_at: Date;
};

type PhaseRow = {
  node_exists: boolean;
  phase_status: string | null;
  observed_at: Date;
};

type PlanningRow = { planning_now: Date };

type PhaseScopeRow = { order_id: string };

export type CreateEligibilityPlanInput = {
  nodeId: string;
  orderPhaseId: string;
  /** Caller-owned idempotency identity for this exact planning attempt. */
  planKey: string;
  /** Optional planning-time horizon for every selected production interval. */
  capacityWindowSeconds?: bigint;
  /** Optional whole-plan production plate limit. */
  maximumPlateCount?: bigint;
};

export type EligibilityPlanResult = {
  eligibilitySnapshotId: string;
  phaseResourcePlanId: string;
  planKey: string;
  expiresAt: Date;
  candidateResourceEstimateIds: readonly string[];
};

function nonBlank(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 255) {
    throw new ResourceValidationError(
      `${name} must contain 1 through 255 characters`,
    );
  }
  return normalized;
}

function compatibleItemGroups(
  candidate: CandidateRow,
  slots: readonly SlotRow[],
): readonly SlotRow[][] {
  const byItem = new Map<string, SlotRow[]>();
  for (const slot of slots) {
    if (
      slot.shipment_plan_id !== candidate.shipment_plan_id ||
      slot.model_geometry_id !== candidate.model_geometry_id ||
      slot.print_config_revision_id !== candidate.print_config_revision_id ||
      slot.material !== candidate.material ||
      (slot.color !== null && slot.color !== candidate.color)
    ) {
      continue;
    }
    const itemSlots = byItem.get(slot.order_item_id) ?? [];
    itemSlots.push(slot);
    byItem.set(slot.order_item_id, itemSlots);
  }
  return [...byItem.values()]
    .filter((itemSlots) => itemSlots.length >= candidate.quantity)
    .map((itemSlots) =>
      [...itemSlots].sort(
        (left, right) =>
          left.packing_unit_key.localeCompare(right.packing_unit_key) ||
          left.id.localeCompare(right.id),
      ),
    )
    .sort(
      (left, right) =>
        left[0]!.item_ordinal - right[0]!.item_ordinal ||
        left[0]!.order_item_id.localeCompare(right[0]!.order_item_id),
    );
}

function plannerCandidate(
  candidate: CandidateRow,
  intervals: readonly ResourceCapacityInterval[],
  itemSlots: readonly SlotRow[],
): ResourceCandidateEstimate {
  const slotIds = itemSlots.map(({ id }) => id);
  return {
    id: candidate.id,
    estimateKey: candidate.estimate_key,
    plannerOptionId: `${candidate.id}:${itemSlots[0]!.order_item_id}`,
    nodeId: candidate.node_id,
    machineId: candidate.machine_id,
    machineProfileId: candidate.machine_profile_id,
    machineCalibrationId: candidate.machine_calibration_id,
    inventoryId: candidate.inventory_id,
    shipmentPlanId: candidate.shipment_plan_id,
    modelGeometryId: candidate.model_geometry_id,
    printConfigRevisionId: candidate.print_config_revision_id,
    material: candidate.material,
    color: candidate.color,
    requiredMaterialMilligrams: candidate.required_material_milligrams,
    requiredMachineSeconds: candidate.required_machine_seconds,
    expiresAt: candidate.expires_at,
    intervals,
    fulfilmentSlotIds: slotIds,
    fulfilmentSlotCount: candidate.quantity,
    source: "candidate",
  };
}

@Injectable()
export class EligibilityPlanService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Persists one deterministic complete plan, or no rows when none exists. */
  async createCompletePlan(
    input: CreateEligibilityPlanInput,
  ): Promise<EligibilityPlanResult> {
    const planKey = nonBlank(input.planKey, "planKey");
    if (
      input.capacityWindowSeconds !== undefined &&
      (input.capacityWindowSeconds <= 0n ||
        input.capacityWindowSeconds >
          BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)))
    ) {
      throw new ResourceValidationError(
        "capacityWindowSeconds must be a positive safe duration",
      );
    }
    if (
      input.maximumPlateCount !== undefined &&
      (input.maximumPlateCount <= 0n ||
        input.maximumPlateCount > BigInt(Number.MAX_SAFE_INTEGER))
    ) {
      throw new ResourceValidationError(
        "maximumPlateCount must be a positive safe integer",
      );
    }
    const planAdvisoryKey = `eligibility-plan:${planKey}`;
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${planAdvisoryKey}, 0)
            )::text
          `;
          const existing = await transaction.phaseResourcePlan.findUnique({
            where: { planKey },
            include: { eligibilitySnapshot: true, jobs: true },
          });
          if (existing) {
            if (
              existing.nodeId !== input.nodeId ||
              existing.orderPhaseId !== input.orderPhaseId
            ) {
              throw new ResourceConflictError(
                "plan key belongs to a different node or order phase",
                "phase_resource_plans_plan_key_key",
              );
            }
            if (input.maximumPlateCount !== undefined) {
              const plateRows = await transaction.$queryRaw<
                Array<{ plate_count: bigint }>
              >`
                SELECT count(candidate_interval.id) AS plate_count
                FROM phase_resource_plan_jobs plan_job
                JOIN candidate_capacity_intervals candidate_interval
                  ON candidate_interval.candidate_resource_estimate_id =
                     plan_job.candidate_resource_estimate_id
                 AND candidate_interval.node_id = plan_job.node_id
                WHERE plan_job.phase_resource_plan_id = ${existing.id}::uuid
                  AND plan_job.node_id = ${existing.nodeId}::uuid
              `;
              const plateCount = plateRows[0]?.plate_count ?? 0n;
              if (plateCount === 0n || plateCount > input.maximumPlateCount) {
                throw new ResourceConflictError(
                  "existing complete plan exceeds the production plate limit",
                  "phase_resource_plan_plate_limit_check",
                );
              }
            }
            return {
              eligibilitySnapshotId: existing.eligibilitySnapshotId,
              phaseResourcePlanId: existing.id,
              planKey,
              expiresAt: existing.expiresAt,
              candidateResourceEstimateIds: existing.jobs
                .map(
                  ({ candidateResourceEstimateId }) =>
                    candidateResourceEstimateId,
                )
                .sort(),
            };
          }

          const phaseScope = await transaction.$queryRaw<PhaseScopeRow[]>`
            SELECT order_id
            FROM order_phases
            WHERE id = ${input.orderPhaseId}::uuid
          `;
          const orderId = phaseScope[0]?.order_id;
          if (!orderId) {
            throw new ResourceNotFoundError("order phase was not found");
          }
          await transaction.$queryRaw`
            SELECT taven_lock_automatic_order_session(${orderId}::uuid)::text
          `;

          const phaseRows = await transaction.$queryRaw<PhaseRow[]>`
            SELECT EXISTS (
                     SELECT 1 FROM nodes
                     WHERE id = ${input.nodeId}::uuid AND active
                   ) AS node_exists,
                   phase.status::text AS phase_status,
                   clock_timestamp() AS observed_at
            FROM order_phases phase
            WHERE phase.id = ${input.orderPhaseId}::uuid
            FOR UPDATE OF phase
          `;
          const phase = phaseRows[0];
          if (!phase)
            throw new ResourceNotFoundError("order phase was not found");
          if (!phase.node_exists) {
            throw new ResourceNotFoundError(
              "active production node was not found",
            );
          }
          if (phase.phase_status !== "QUOTED") {
            throw new ResourceConflictError(
              "initial eligibility requires a quoted order phase",
              "order_phase_resource_planning_state_check",
            );
          }

          const slots = await transaction.$queryRaw<SlotRow[]>`
            SELECT slot.id, slot.packing_unit_key, slot.order_item_id,
                   item.ordinal AS item_ordinal, item.model_geometry_id,
                   item.print_config_revision_id, item.material::text AS material,
                   item.color, allocation.shipment_plan_id
            FROM fulfilment_slots slot
            JOIN order_items item
              ON item.id = slot.order_item_id AND item.order_id = slot.order_id
            JOIN shipment_plan_fulfilment_slots allocation
              ON allocation.fulfilment_slot_id = slot.id
            JOIN order_active_price_bindings active_binding
              ON active_binding.order_id = slot.order_id
             AND active_binding.order_price_binding_id = allocation.order_price_binding_id
            JOIN shipment_plans shipment_plan
              ON shipment_plan.id = allocation.shipment_plan_id
             AND shipment_plan.order_phase_id = slot.order_phase_id
             AND shipment_plan.order_price_binding_id = active_binding.order_price_binding_id
            WHERE slot.order_phase_id = ${input.orderPhaseId}::uuid
              AND slot.outcome = 'PENDING'
            ORDER BY slot.packing_unit_key, slot.id
            FOR UPDATE OF slot
          `;
          if (slots.length === 0) {
            throw new ResourceConflictError(
              "order phase has no required fulfilment slots",
            );
          }
          const planningRows = await transaction.$queryRaw<PlanningRow[]>`
            SELECT clock_timestamp() AS planning_now
          `;
          const planningNow = planningRows[0]?.planning_now;
          if (!planningNow) {
            throw new ResourceConflictError(
              "resource planning clock was unavailable",
            );
          }
          const capacityEndsAt = input.capacityWindowSeconds
            ? new Date(
                planningNow.getTime() +
                  Number(input.capacityWindowSeconds * 1_000n),
              )
            : null;
          const candidates = await transaction.$queryRaw<CandidateRow[]>`
            SELECT candidate.id, candidate.estimate_key, candidate.node_id,
                   candidate.machine_id, candidate.machine_profile_id,
                   candidate.machine_calibration_id, candidate.inventory_id,
                   candidate.shipment_plan_id, candidate.model_geometry_id,
                   candidate.print_config_revision_id,
                   inventory.material::text AS material, inventory.color,
                   candidate.quantity, candidate.required_material_milligrams,
                   candidate.required_machine_seconds, candidate.expires_at,
                   candidate_interval.id AS interval_id,
                   candidate_interval.interval_index,
                   candidate_interval.starts_at, candidate_interval.ends_at,
                   inventory.remaining_milligrams,
                   inventory.reserved_milligrams
            FROM candidate_resource_estimates candidate
            JOIN shipment_plans shipment_plan
              ON shipment_plan.id = candidate.shipment_plan_id
             AND shipment_plan.order_phase_id = ${input.orderPhaseId}::uuid
            JOIN order_active_price_bindings active_binding
              ON active_binding.order_id = shipment_plan.order_id
             AND active_binding.order_price_binding_id = shipment_plan.order_price_binding_id
            JOIN inventories inventory
              ON inventory.id = candidate.inventory_id
             AND inventory.node_id = candidate.node_id
             AND inventory.machine_id = candidate.machine_id
             AND inventory.status = 'AVAILABLE'
            JOIN machines machine
              ON machine.id = candidate.machine_id
             AND machine.node_id = candidate.node_id
             AND machine.status = 'ACTIVE'
            JOIN nodes node
              ON node.id = candidate.node_id
             AND node.active
            JOIN machine_profiles profile
              ON profile.id = candidate.machine_profile_id
             AND profile.machine_capability_id = machine.machine_capability_id
             AND profile.nozzle_diameter_micrometers = machine.installed_nozzle_micrometers
             AND profile.material = inventory.material
             AND profile.state = 'ACTIVE'
            JOIN machine_calibrations calibration
              ON calibration.id = candidate.machine_calibration_id
             AND calibration.node_id = candidate.node_id
             AND calibration.machine_id = candidate.machine_id
             AND calibration.state = 'ACTIVE'
            JOIN print_config_revisions config
              ON config.id = candidate.print_config_revision_id
             AND config.quality = profile.quality
            JOIN model_geometries geometry
              ON geometry.id = candidate.model_geometry_id
             AND geometry.deleted_at IS NULL
            JOIN model_files source
              ON source.id = geometry.source_model_file_id
             AND source.deleted_at IS NULL
            JOIN candidate_capacity_intervals candidate_interval
              ON candidate_interval.candidate_resource_estimate_id = candidate.id
             AND candidate_interval.node_id = candidate.node_id
            WHERE candidate.node_id = ${input.nodeId}::uuid
              AND candidate.expires_at > ${planningNow}
              AND (
                    ${capacityEndsAt}::timestamptz IS NULL
                    OR NOT EXISTS (
                      SELECT 1
                      FROM candidate_capacity_intervals deadline_interval
                      WHERE deadline_interval.candidate_resource_estimate_id = candidate.id
                        AND deadline_interval.node_id = candidate.node_id
                        AND deadline_interval.ends_at > ${capacityEndsAt}::timestamptz
                    )
                  )
              AND (
                    source.retention_hold <> 'NONE'
                    OR source.source_delete_after > (
                      SELECT MAX(horizon.ends_at)
                      FROM candidate_capacity_intervals horizon
                      WHERE horizon.candidate_resource_estimate_id = candidate.id
                        AND horizon.node_id = candidate.node_id
                    )
                  )
              AND taven_geometry_fits_machine_capability(
                    candidate.model_geometry_id,
                    machine.machine_capability_id
                  )
            ORDER BY candidate.estimate_key, candidate.id,
                     candidate_interval.interval_index, candidate_interval.id
          `;
          const byCandidate = new Map<
            string,
            { row: CandidateRow; intervals: ResourceCapacityInterval[] }
          >();
          for (const candidate of candidates) {
            const grouped = byCandidate.get(candidate.id) ?? {
              row: candidate,
              intervals: [],
            };
            grouped.intervals.push({
              id: candidate.interval_id,
              nodeId: candidate.node_id,
              machineId: candidate.machine_id,
              startsAt: candidate.starts_at,
              endsAt: candidate.ends_at,
            });
            byCandidate.set(candidate.id, grouped);
          }

          const plannerCandidates: ResourceCandidateEstimate[] = [];
          for (const { row, intervals } of byCandidate.values()) {
            for (const itemGroup of compatibleItemGroups(row, slots)) {
              plannerCandidates.push(
                plannerCandidate(row, intervals, itemGroup),
              );
            }
          }
          const inventory = [
            ...new Map(
              [...byCandidate.values()].map(({ row }) => [
                row.inventory_id,
                {
                  id: row.inventory_id,
                  nodeId: row.node_id,
                  machineId: row.machine_id,
                  remainingMilligrams: row.remaining_milligrams,
                  reservedMilligrams: row.reserved_milligrams,
                } satisfies ResourceInventoryAvailability,
              ]),
            ).values(),
          ];
          const occupiedRows = await transaction.$queryRaw<OccupiedRow[]>`
            SELECT machine_id, starts_at, ends_at
            FROM capacity_reservations
            WHERE node_id = ${input.nodeId}::uuid
              AND status IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
            ORDER BY machine_id, starts_at, ends_at, id
          `;
          const requiredSlots: FulfilmentSlotResourceInput[] = slots.map(
            (slot) => ({
              id: slot.id,
              shipmentPlanId: slot.shipment_plan_id,
              modelGeometryId: slot.model_geometry_id,
              printConfigRevisionId: slot.print_config_revision_id,
              material: slot.material,
              color: slot.color,
            }),
          );
          const { selectCompleteResourcePlan } = await import("@taven/core");
          const selected = selectCompleteResourcePlan({
            requiredFulfilmentSlots: requiredSlots,
            candidates: plannerCandidates,
            inventory,
            occupiedCapacity: occupiedRows.map((row) => ({
              machineId: row.machine_id,
              startsAt: row.starts_at,
              endsAt: row.ends_at,
            })),
            ...(input.maximumPlateCount === undefined
              ? {}
              : {
                  maximumCapacityIntervalCount: Number(input.maximumPlateCount),
                }),
            now: planningNow,
          });
          if (!selected) {
            throw new ResourceConflictError(
              "no complete machine-specific resource plan covers the phase",
              "complete_phase_resource_plan_required",
            );
          }
          const actualPlanningRows = await transaction.$queryRaw<PlanningRow[]>`
            SELECT clock_timestamp() AS planning_now
          `;
          const actualPlanningNow = actualPlanningRows[0]?.planning_now;
          if (!actualPlanningNow) {
            throw new ResourceConflictError(
              "resource planning clock was unavailable",
            );
          }
          const candidateExpiry = selected.candidates.reduce(
            (earliest, candidate) =>
              candidate.expiresAt < earliest ? candidate.expiresAt : earliest,
            new Date(
              actualPlanningNow.getTime() + ELIGIBILITY_TTL_MILLISECONDS,
            ),
          );
          const expiresAt = new Date(
            Math.min(
              candidateExpiry.getTime(),
              actualPlanningNow.getTime() + ELIGIBILITY_TTL_MILLISECONDS,
            ),
          );
          if (
            expiresAt.getTime() <=
            actualPlanningNow.getTime() + MINIMUM_RESERVABLE_MILLISECONDS
          ) {
            throw new ResourceConflictError(
              "complete plan does not remain valid for the payment reservation TTL",
              "phase_resource_plan_reservation_horizon_check",
            );
          }

          const requiredSlotIds = requiredSlots.map(({ id }) => id).sort();
          const selectedCandidateIds = [
            ...selected.candidateResourceEstimateIds,
          ].sort();
          const snapshotHash = createHash("sha256")
            .update(
              JSON.stringify({
                nodeId: input.nodeId,
                orderPhaseId: input.orderPhaseId,
                planKey,
                capacityEndsAt: capacityEndsAt?.toISOString() ?? null,
                maximumPlateCount: input.maximumPlateCount?.toString() ?? null,
                requiredSlotIds,
                selectedCandidateIds,
              }),
            )
            .digest("hex");
          const snapshot = await transaction.eligibilitySnapshot.create({
            data: {
              nodeId: input.nodeId,
              orderPhaseId: input.orderPhaseId,
              requiredFulfilmentSlotIds:
                requiredSlotIds as Prisma.InputJsonArray,
              eligibleCandidateEstimateIds:
                selectedCandidateIds as Prisma.InputJsonArray,
              snapshotHash,
              calculatedAt: actualPlanningNow,
              expiresAt,
            },
          });
          const plan = await transaction.phaseResourcePlan.create({
            data: {
              nodeId: input.nodeId,
              orderPhaseId: input.orderPhaseId,
              eligibilitySnapshotId: snapshot.id,
              planKey,
              expiresAt,
            },
          });
          for (const [index, candidateId] of selectedCandidateIds.entries()) {
            const planJob = await transaction.phaseResourcePlanJob.create({
              data: {
                nodeId: input.nodeId,
                phaseResourcePlanId: plan.id,
                candidateResourceEstimateId: candidateId,
                plannedJobKey: `planned:${createHash("sha256")
                  .update(`${planKey}\0${index}\0${candidateId}`)
                  .digest("hex")}`,
              },
            });
            const assignments = selected.assignments.filter(
              ({ candidateResourceEstimateId }) =>
                candidateResourceEstimateId === candidateId,
            );
            await transaction.phaseResourcePlanSlot.createMany({
              data: assignments.map(({ fulfilmentSlotId }) => ({
                nodeId: input.nodeId,
                phaseResourcePlanId: plan.id,
                phaseResourcePlanJobId: planJob.id,
                fulfilmentSlotId,
              })),
            });
          }
          await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
          return {
            eligibilitySnapshotId: snapshot.id,
            phaseResourcePlanId: plan.id,
            planKey,
            expiresAt,
            candidateResourceEstimateIds: selectedCandidateIds,
          };
        },
        // The plan-key fence serializes identical idempotency attempts before
        // the lookup. Read Committed is intentional here: a Serializable
        // snapshot can be established before a waiter acquires that fence,
        // leaving an exact retry with a stale pre-winner snapshot. The key,
        // order-session, phase, and participant row locks provide the needed
        // write serialization without that stale-snapshot failure mode.
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (
        error instanceof ResourceConflictError ||
        error instanceof ResourceNotFoundError ||
        error instanceof ResourceValidationError
      ) {
        throw error;
      }
      if (error && typeof error === "object" && "code" in error) {
        throw new ResourceConflictError(
          "resource plan conflicts with current phase or capacity state",
          typeof error.code === "string" ? error.code : undefined,
        );
      }
      throw error;
    }
  }
}
