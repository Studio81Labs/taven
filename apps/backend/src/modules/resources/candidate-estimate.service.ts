import { Inject, Injectable } from "@nestjs/common";
import { Prisma, SliceKind } from "@prisma/client";
import type {
  CandidateEstimateJob,
  CandidateEstimateResult,
} from "@taven/slicer-contracts" with { "resolution-mode": "import" };
import { PrismaService } from "../../prisma/prisma.service";
import {
  ResourceConflictError,
  ResourceNotFoundError,
  ResourceValidationError,
} from "./resource-errors";

const CANDIDATE_DISPATCH_TYPE = "slicing.candidate-estimate.requested";
const CANDIDATE_SCHEMA_VERSION = 2;

export type CandidateEstimateDispatch = {
  nodeId: string;
  inventoryId: string;
  job: CandidateEstimateJob;
};

export type CandidateCapacityWindow = {
  startsAt: Date;
  endsAt: Date;
};

export type IngestCandidateEstimateInput = {
  result: CandidateEstimateResult;
  capacityWindows: readonly CandidateCapacityWindow[];
  expiresAt: Date;
};

export type CandidateIngestionResult =
  | {
      status: "failed";
      jobId: string;
      failureClass: string;
      code: string;
    }
  | {
      status: "succeeded";
      candidateResourceEstimateId: string;
      estimateKey: string;
      replayed: boolean;
    };

type DispatchPayload = {
  nodeId: string;
  inventoryId: string;
  job: CandidateEstimateJob;
};

type ObservedResourceRow = {
  observed_at: Date;
  remaining_milligrams: bigint;
  reserved_milligrams: bigint;
};

type CandidateResourceLockInput = {
  nodeId: string;
  inventoryId: string;
  machineId: string;
  machineProfileId: string;
  machineCalibrationId: string;
};

type CandidateTerminalReceiptRow = {
  outcome: "SUCCEEDED" | "FAILED";
  result_fingerprint_sha256: string;
  candidate_resource_estimate_id: string | null;
  estimate_key: string | null;
  failure_class: string | null;
  failure_code: string | null;
};

type CandidateDispatchOutboxRow = {
  id: string;
  message_type: string;
  aggregate_id: string;
  payload: Prisma.JsonValue;
};

async function parseDispatchPayload(value: unknown): Promise<DispatchPayload> {
  if (!value || typeof value !== "object") {
    throw new ResourceConflictError("candidate dispatch payload is missing");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.nodeId !== "string" ||
    typeof payload.inventoryId !== "string"
  ) {
    throw new ResourceConflictError("candidate dispatch context is invalid");
  }
  try {
    const { CandidateEstimateJobSchema } =
      await import("@taven/slicer-contracts");
    return {
      nodeId: payload.nodeId,
      inventoryId: payload.inventoryId,
      job: CandidateEstimateJobSchema.parse(payload.job),
    };
  } catch (error) {
    throw new ResourceConflictError(
      `persisted candidate dispatch is invalid: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown validation error";
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ResourceValidationError(`${name} must be a valid Date`);
  }
}

function windowsOverlap(
  left: CandidateCapacityWindow,
  right: CandidateCapacityWindow,
): boolean {
  return left.startsAt < right.endsAt && right.startsAt < left.endsAt;
}

function validateCapacityWindows(
  windows: readonly CandidateCapacityWindow[],
  plateSeconds: readonly bigint[],
  observedAt: Date,
): void {
  if (windows.length !== plateSeconds.length || windows.length === 0) {
    throw new ResourceValidationError(
      "capacity windows must contain exactly one interval per result plate",
    );
  }
  windows.forEach((window, index) => {
    assertValidDate(window.startsAt, `capacityWindows[${index}].startsAt`);
    assertValidDate(window.endsAt, `capacityWindows[${index}].endsAt`);
    if (window.startsAt <= observedAt || window.endsAt <= window.startsAt) {
      throw new ResourceValidationError(
        "candidate capacity windows must be future, positive half-open intervals",
      );
    }
    const durationMilliseconds = BigInt(
      window.endsAt.getTime() - window.startsAt.getTime(),
    );
    if (durationMilliseconds < plateSeconds[index]! * 1_000n) {
      throw new ResourceValidationError(
        `capacity window ${index} is shorter than its machine-specific plate estimate`,
      );
    }
  });
  for (let left = 0; left < windows.length; left += 1) {
    for (let right = left + 1; right < windows.length; right += 1) {
      if (windowsOverlap(windows[left]!, windows[right]!)) {
        throw new ResourceValidationError(
          "candidate capacity windows must not overlap",
        );
      }
    }
  }
}

function isPrismaConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    ["P2002", "P2003", "P2010"].includes(error.code),
  );
}

function constraintOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("meta" in error)) return;
  const meta = error.meta;
  if (!meta || typeof meta !== "object") return;
  if ("constraint" in meta && typeof meta.constraint === "string") {
    return meta.constraint;
  }
  if ("target" in meta) {
    return Array.isArray(meta.target)
      ? meta.target.join(",")
      : typeof meta.target === "string"
        ? meta.target
        : undefined;
  }
  return;
}

@Injectable()
export class CandidateEstimateService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Persists the exact queue dispatch before it can be published. */
  async dispatch(
    input: CandidateEstimateDispatch,
  ): Promise<CandidateEstimateJob> {
    let job: CandidateEstimateJob;
    try {
      const { CandidateEstimateJobSchema } =
        await import("@taven/slicer-contracts");
      job = CandidateEstimateJobSchema.parse(input.job);
    } catch (error) {
      throw new ResourceValidationError(
        `candidate estimate job is invalid: ${errorMessage(error)}`,
      );
    }
    const payload = {
      nodeId: input.nodeId,
      inventoryId: input.inventoryId,
      job,
    } satisfies DispatchPayload;
    const { slicingDispatchAttemptKey } =
      await import("@taven/slicer-contracts");
    const attemptDeduplicationKey = slicingDispatchAttemptKey(
      job.idempotencyKey,
      job.attempt,
    );

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${job.idempotencyKey}, 0)
          )::text
        `;
        const existing = await this.findDispatchForAttempt(
          transaction,
          job.idempotencyKey,
          job.attempt,
          attemptDeduplicationKey,
        );
        if (existing) {
          const persisted = await parseDispatchPayload(existing.payload);
          if (
            existing.message_type !== CANDIDATE_DISPATCH_TYPE ||
            existing.aggregate_id !== job.jobId ||
            persisted.job.attempt !== job.attempt ||
            !(await this.hasSameDispatchEffect(persisted, payload))
          ) {
            throw new ResourceConflictError(
              "candidate dispatch attempt belongs to different inputs",
              "outbox_messages_deduplication_key_key",
            );
          }
          return persisted.job;
        }

        if (job.attempt > 1) {
          const previousAttempt = job.attempt - 1;
          const previous = await this.findDispatchForAttempt(
            transaction,
            job.idempotencyKey,
            previousAttempt,
            slicingDispatchAttemptKey(job.idempotencyKey, previousAttempt),
          );
          if (!previous) {
            throw new ResourceConflictError(
              "candidate dispatch retry must immediately follow a persisted attempt",
              "candidate_estimate_dispatch_attempt_sequence_check",
            );
          }
          const previousPayload = await parseDispatchPayload(previous.payload);
          const previousTerminal = await this.findTerminalReceipt(
            transaction,
            previous.id,
          );
          if (
            !(await this.hasSameDispatchEffect(previousPayload, payload)) ||
            previousTerminal?.outcome !== "FAILED" ||
            previousTerminal.failure_class !== "retryable_infrastructure"
          ) {
            throw new ResourceConflictError(
              "candidate dispatch retry requires the previous exact attempt to fail retryably",
              "candidate_estimate_dispatch_retry_check",
            );
          }
        }

        await transaction.$executeRaw`
          INSERT INTO arrangement_revisions (id, content_sha256)
          VALUES (
            ${job.input.arrangementRevision.revisionId}::uuid,
            ${job.input.arrangementRevision.contentSha256}
          )
          ON CONFLICT (id) DO NOTHING
        `;

        const resource = await transaction.$queryRaw<
          Array<{ exists: boolean }>
        >`
          SELECT EXISTS (
            SELECT 1
            FROM inventories inventory
            JOIN machines machine
              ON machine.id = inventory.machine_id
             AND machine.node_id = inventory.node_id
            JOIN nodes node
              ON node.id = machine.node_id
            JOIN machine_profiles profile
              ON profile.id = ${job.input.machineProfile.revisionId}::uuid
             AND profile.machine_capability_id = machine.machine_capability_id
            JOIN machine_calibrations calibration
              ON calibration.id = ${job.input.machineCalibration.revisionId}::uuid
             AND calibration.node_id = machine.node_id
             AND calibration.machine_id = machine.id
            JOIN revision_identities profile_revision
              ON profile_revision.id = profile.id
            JOIN revision_identities calibration_revision
              ON calibration_revision.id = calibration.id
            JOIN revision_identities config_revision
              ON config_revision.id = ${job.input.printConfig.revisionId}::uuid
            JOIN arrangement_revisions arrangement_revision
              ON arrangement_revision.id = ${job.input.arrangementRevision.revisionId}::uuid
            JOIN print_config_revisions config
              ON config.id = config_revision.id
            JOIN model_geometries geometry
              ON geometry.id = ${job.input.geometry.modelGeometryId}::uuid
            JOIN model_files source
              ON source.id = geometry.source_model_file_id
            JOIN shipment_plans shipment_plan
              ON shipment_plan.id = ${job.input.shipmentPlanId}::uuid
            WHERE inventory.id = ${input.inventoryId}::uuid
              AND inventory.node_id = ${input.nodeId}::uuid
              AND machine.id = ${job.input.machineId}::uuid
              AND node.active
              AND machine.status = 'ACTIVE'
              AND inventory.status = 'AVAILABLE'
              AND profile.state = 'ACTIVE'
              AND calibration.state = 'ACTIVE'
              AND profile.nozzle_diameter_micrometers = machine.installed_nozzle_micrometers
              AND profile.material = inventory.material
              AND profile.quality = config.quality
              AND profile.slicer_engine = ${job.input.machineProfile.slicerEngine}
              AND profile.slicer_version = ${job.input.machineProfile.slicerVersion}
              AND geometry.source_model_file_id = ${job.input.geometry.sourceModelFileId}::uuid
              AND geometry.canonical_object_key = ${job.input.geometry.canonicalObjectKey}
              AND geometry.geometry_hash = ${job.input.geometry.geometrySha256}
              AND geometry.deleted_at IS NULL
              AND source.content_hash = ${job.input.geometry.sourceContentSha256}
              AND source.deleted_at IS NULL
              AND (
                    source.retention_hold <> 'NONE'
                    OR source.source_delete_after > clock_timestamp()
                  )
              AND taven_geometry_fits_machine_capability(
                    geometry.id,
                    machine.machine_capability_id
                  )
              AND profile_revision.digest = ${job.input.machineProfile.contentSha256}
              AND calibration_revision.digest = ${job.input.machineCalibration.contentSha256}
              AND config_revision.digest = ${job.input.printConfig.contentSha256}
              AND arrangement_revision.content_sha256 = ${job.input.arrangementRevision.contentSha256}
          ) AS exists
        `;
        if (!resource[0]?.exists) {
          throw new ResourceNotFoundError(
            "candidate dispatch resources do not match persisted revisions",
          );
        }
        await transaction.outboxMessage.create({
          data: {
            deduplicationKey: attemptDeduplicationKey,
            aggregateType: "CandidateEstimateDispatch",
            aggregateId: job.jobId,
            messageType: CANDIDATE_DISPATCH_TYPE,
            schemaVersion: CANDIDATE_SCHEMA_VERSION,
            payload: payload as unknown as Prisma.InputJsonObject,
          },
        });
        return job;
      });
    } catch (error) {
      if (
        error instanceof ResourceConflictError ||
        error instanceof ResourceNotFoundError ||
        error instanceof ResourceValidationError
      ) {
        throw error;
      }
      if (isPrismaConflict(error)) {
        throw new ResourceConflictError(
          "candidate dispatch conflicts with persisted state",
          constraintOf(error),
        );
      }
      throw error;
    }
  }

  /** Validates a worker result against its persisted dispatch and stores it once. */
  async ingest(
    input: IngestCandidateEstimateInput,
  ): Promise<CandidateIngestionResult> {
    assertValidDate(input.expiresAt, "expiresAt");
    let attemptDeduplicationKey: string;
    try {
      const { slicingDispatchAttemptKey } =
        await import("@taven/slicer-contracts");
      attemptDeduplicationKey = slicingDispatchAttemptKey(
        input.result.idempotencyKey,
        input.result.attempt,
      );
    } catch (error) {
      throw new ResourceValidationError(
        `candidate result dispatch identity is invalid: ${errorMessage(error)}`,
      );
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const dispatchRow = await this.findDispatchForAttempt(
          transaction,
          input.result.idempotencyKey,
          input.result.attempt,
          attemptDeduplicationKey,
        );
        if (
          !dispatchRow ||
          dispatchRow.message_type !== CANDIDATE_DISPATCH_TYPE
        ) {
          throw new ResourceNotFoundError(
            "persisted candidate estimate dispatch was not found",
          );
        }
        const dispatch = await parseDispatchPayload(dispatchRow.payload);
        let result: CandidateEstimateResult;
        let resultFingerprint: string;
        try {
          const { slicingResultFingerprint, slicingResultForJobSchema } =
            await import("@taven/slicer-contracts");
          const parsed = slicingResultForJobSchema(dispatch.job).parse(
            input.result,
          );
          if (parsed.kind !== "candidate_estimate") {
            throw new Error("result is not a candidate estimate");
          }
          result = parsed;
          resultFingerprint = slicingResultFingerprint(result);
        } catch (error) {
          throw new ResourceValidationError(
            `candidate result does not match its persisted dispatch: ${errorMessage(error)}`,
          );
        }

        const terminal = await this.findTerminalReceipt(
          transaction,
          dispatchRow.id,
        );
        if (terminal) {
          if (terminal.result_fingerprint_sha256 !== resultFingerprint) {
            throw new ResourceConflictError(
              "candidate dispatch already has a different terminal result",
              "candidate_estimate_terminal_results_pkey",
            );
          }
          if (terminal.outcome === "FAILED") {
            if (!terminal.failure_class || !terminal.failure_code) {
              throw new ResourceConflictError(
                "candidate dispatch terminal failure receipt is incomplete",
                "candidate_estimate_terminal_results_outcome_shape_check",
              );
            }
            return {
              status: "failed",
              jobId: result.jobId,
              failureClass: terminal.failure_class,
              code: terminal.failure_code,
            };
          }
          if (
            !terminal.candidate_resource_estimate_id ||
            !terminal.estimate_key
          ) {
            throw new ResourceConflictError(
              "candidate dispatch terminal success receipt is incomplete",
              "candidate_estimate_terminal_results_outcome_shape_check",
            );
          }
          return {
            status: "succeeded",
            candidateResourceEstimateId:
              terminal.candidate_resource_estimate_id,
            estimateKey: terminal.estimate_key,
            replayed: true,
          };
        }
        const orderScope = await transaction.$queryRaw<
          Array<{ order_id: string }>
        >`
          SELECT order_id
          FROM shipment_plans
          WHERE id = ${dispatch.job.input.shipmentPlanId}::uuid
        `;
        const orderId = orderScope[0]?.order_id;
        if (!orderId) {
          throw new ResourceNotFoundError(
            "candidate dispatch shipment plan was not found",
          );
        }
        await transaction.$queryRaw`
          SELECT taven_lock_automatic_order_session(${orderId}::uuid)::text
        `;

        if (result.outcome.status === "failed") {
          await this.recordFailedTerminalReceipt(
            transaction,
            dispatchRow.id,
            resultFingerprint,
            result.outcome.failureClass,
            result.outcome.code,
          );
          return {
            status: "failed",
            jobId: result.jobId,
            failureClass: result.outcome.failureClass,
            code: result.outcome.code,
          };
        }

        const {
          buildCandidateResourceEstimateKey,
          buildMachineOccupancySliceCacheKey,
          RevisionRef,
          Sha256Digest,
        } = await import("@taven/core");
        const estimateKey = buildCandidateResourceEstimateKey({
          geometryHash: Sha256Digest.parse(
            dispatch.job.input.geometry.geometrySha256,
          ),
          modelGeometryId: dispatch.job.input.geometry.modelGeometryId,
          geometrySelectionHash: Sha256Digest.parse(
            dispatch.job.input.geometry.selectionSha256,
          ),
          machineProfileRevision: RevisionRef.create(
            "machine-profile",
            dispatch.job.input.machineProfile.revisionId,
          ),
          machineCalibrationRevision: RevisionRef.create(
            "machine-calibration",
            dispatch.job.input.machineCalibration.revisionId,
          ),
          printConfigRevision: RevisionRef.create(
            "print-config",
            dispatch.job.input.printConfig.revisionId,
          ),
          arrangementRevision: RevisionRef.create(
            "arrangement",
            dispatch.job.input.arrangementRevision.revisionId,
          ),
          partsPerPlate: dispatch.job.input.partsPerPlate,
          quantity: dispatch.job.input.quantity,
          shipmentPlanId: dispatch.job.input.shipmentPlanId,
          dispatchJobId: result.jobId,
        });
        const existing = await transaction.candidateResourceEstimate.findUnique(
          { where: { estimateKey } },
        );
        if (existing) {
          const snapshot = existing.resourceSnapshot as Record<string, unknown>;
          if (
            snapshot.dispatchJobId !== result.jobId ||
            existing.nodeId !== dispatch.nodeId ||
            existing.inventoryId !== dispatch.inventoryId
          ) {
            throw new ResourceConflictError(
              "candidate estimate key belongs to a different dispatch",
              "candidate_resource_estimates_estimate_key_key",
            );
          }
          await this.recordSucceededTerminalReceipt(
            transaction,
            dispatchRow.id,
            resultFingerprint,
            existing.id,
          );
          return {
            status: "succeeded",
            candidateResourceEstimateId: existing.id,
            estimateKey,
            replayed: true,
          };
        }

        const observed = await this.lockCandidateResources(transaction, {
          nodeId: dispatch.nodeId,
          inventoryId: dispatch.inventoryId,
          machineId: dispatch.job.input.machineId,
          machineProfileId: dispatch.job.input.machineProfile.revisionId,
          machineCalibrationId:
            dispatch.job.input.machineCalibration.revisionId,
        });
        if (input.expiresAt <= observed.observed_at) {
          throw new ResourceValidationError(
            "candidate estimate must expire after calculation",
          );
        }
        const plateSeconds = result.outcome.plates.map(
          ({ estimatedPrintSeconds }) => BigInt(estimatedPrintSeconds),
        );
        validateCapacityWindows(
          input.capacityWindows,
          plateSeconds,
          observed.observed_at,
        );
        const requiredMaterialMilligrams = result.outcome.plates.reduce(
          (total, plate) => total + BigInt(plate.estimatedMaterialMilligrams),
          0n,
        );
        const requiredMachineSeconds = plateSeconds.reduce(
          (total, seconds) => total + seconds,
          0n,
        );

        const sliceIds: string[] = [];
        for (const occupancy of result.outcome.occupancySlices) {
          const cacheKey = buildMachineOccupancySliceCacheKey({
            geometryHash: Sha256Digest.parse(
              dispatch.job.input.geometry.geometrySha256,
            ),
            modelGeometryId: dispatch.job.input.geometry.modelGeometryId,
            geometrySelectionHash: Sha256Digest.parse(
              dispatch.job.input.geometry.selectionSha256,
            ),
            machineProfileRevision: RevisionRef.create(
              "machine-profile",
              dispatch.job.input.machineProfile.revisionId,
            ),
            machineCalibrationRevision: RevisionRef.create(
              "machine-calibration",
              dispatch.job.input.machineCalibration.revisionId,
            ),
            printConfigRevision: RevisionRef.create(
              "print-config",
              dispatch.job.input.printConfig.revisionId,
            ),
            arrangementRevision: RevisionRef.create(
              "arrangement",
              dispatch.job.input.arrangementRevision.revisionId,
            ),
            partsPerPlate: occupancy.partsPerPlate,
          });
          const existingSlice = await transaction.sliceResult.findUnique({
            where: { cacheKey },
          });
          const expected = {
            kind: SliceKind.ANALYSIS,
            modelGeometryId: dispatch.job.input.geometry.modelGeometryId,
            printConfigRevisionId: dispatch.job.input.printConfig.revisionId,
            machineProfileId: dispatch.job.input.machineProfile.revisionId,
            machineCalibrationId:
              dispatch.job.input.machineCalibration.revisionId,
            arrangementRevisionId:
              dispatch.job.input.arrangementRevision.revisionId,
            partsPerPlate: occupancy.partsPerPlate,
            artifactObjectKey: occupancy.artifact.objectKey,
            artifactHash: occupancy.artifact.sha256,
            estimatedPrintSeconds: BigInt(occupancy.estimatedPrintSeconds),
            estimatedMaterialMilligrams: BigInt(
              occupancy.estimatedMaterialMilligrams,
            ),
            slicerEngine: result.engine.name,
            slicerVersion: result.engine.version,
          } as const;
          if (existingSlice) {
            const mismatch = Object.entries(expected).some(([key, value]) => {
              const existingValue =
                existingSlice[key as keyof typeof existingSlice];
              return existingValue !== value;
            });
            if (mismatch) {
              throw new ResourceConflictError(
                "machine occupancy cache key belongs to different immutable metrics",
                "slice_results_cache_key_key",
              );
            }
            sliceIds.push(existingSlice.id);
          } else {
            const created = await transaction.sliceResult.create({
              data: { cacheKey, ...expected },
            });
            sliceIds.push(created.id);
          }
        }
        const primarySliceResultId = sliceIds[0];
        if (!primarySliceResultId) {
          throw new ResourceValidationError(
            "candidate result has no machine occupancy metrics",
          );
        }
        const resourceSnapshot = {
          contractVersion: result.contractVersion,
          dispatchJobId: result.jobId,
          inputFingerprintSha256: result.inputFingerprintSha256,
          inventoryId: dispatch.inventoryId,
          inventoryRemainingMilligrams:
            observed.remaining_milligrams.toString(),
          inventoryReservedMilligrams: observed.reserved_milligrams.toString(),
          machineId: dispatch.job.input.machineId,
          machineProfileRevisionId:
            dispatch.job.input.machineProfile.revisionId,
          machineCalibrationRevisionId:
            dispatch.job.input.machineCalibration.revisionId,
          printConfigRevisionId: dispatch.job.input.printConfig.revisionId,
          arrangementRevisionId:
            dispatch.job.input.arrangementRevision.revisionId,
          capacityWindows: input.capacityWindows.map((window, index) => ({
            intervalIndex: index,
            startsAt: window.startsAt.toISOString(),
            endsAt: window.endsAt.toISOString(),
          })),
        } satisfies Prisma.InputJsonObject;
        const candidate = await transaction.candidateResourceEstimate.create({
          data: {
            nodeId: dispatch.nodeId,
            estimateKey,
            modelGeometryId: dispatch.job.input.geometry.modelGeometryId,
            primarySliceResultId,
            tailSliceResultId: sliceIds[1] ?? null,
            printConfigRevisionId: dispatch.job.input.printConfig.revisionId,
            machineProfileId: dispatch.job.input.machineProfile.revisionId,
            machineCalibrationId:
              dispatch.job.input.machineCalibration.revisionId,
            machineId: dispatch.job.input.machineId,
            inventoryId: dispatch.inventoryId,
            shipmentPlanId: dispatch.job.input.shipmentPlanId,
            arrangementRevisionId:
              dispatch.job.input.arrangementRevision.revisionId,
            quantity: dispatch.job.input.quantity,
            partsPerPlate: dispatch.job.input.partsPerPlate,
            requiredMaterialMilligrams,
            requiredMachineSeconds,
            resourceSnapshot,
            calculatedAt: observed.observed_at,
            expiresAt: input.expiresAt,
          },
        });
        await transaction.candidateCapacityInterval.createMany({
          data: input.capacityWindows.map((window, intervalIndex) => ({
            nodeId: dispatch.nodeId,
            candidateResourceEstimateId: candidate.id,
            intervalIndex,
            startsAt: window.startsAt,
            endsAt: window.endsAt,
          })),
        });
        await this.recordSucceededTerminalReceipt(
          transaction,
          dispatchRow.id,
          resultFingerprint,
          candidate.id,
        );
        return {
          status: "succeeded",
          candidateResourceEstimateId: candidate.id,
          estimateKey,
          replayed: false,
        };
      });
    } catch (error) {
      if (
        error instanceof ResourceConflictError ||
        error instanceof ResourceNotFoundError ||
        error instanceof ResourceValidationError
      ) {
        throw error;
      }
      if (isPrismaConflict(error)) {
        throw new ResourceConflictError(
          "candidate ingestion conflicts with persisted resource state",
          constraintOf(error),
        );
      }
      throw error;
    }
  }

  private async findDispatchForAttempt(
    transaction: Prisma.TransactionClient,
    idempotencyKey: string,
    attempt: number,
    attemptDeduplicationKey: string,
  ): Promise<CandidateDispatchOutboxRow | undefined> {
    const rows = await transaction.$queryRaw<CandidateDispatchOutboxRow[]>`
      SELECT id, message_type, aggregate_id, payload
      FROM outbox_messages
      WHERE deduplication_key = ${attemptDeduplicationKey}
         OR (
           ${attempt} = 1
           AND deduplication_key = ${idempotencyKey}
         )
      ORDER BY CASE
        WHEN deduplication_key = ${attemptDeduplicationKey} THEN 0
        ELSE 1
      END
      FOR UPDATE
    `;
    if (rows.length > 1) {
      throw new ResourceConflictError(
        "candidate dispatch has conflicting persisted identities for one attempt",
        "candidate_estimate_dispatch_attempt_identity_check",
      );
    }
    return rows[0];
  }

  /**
   * Takes resource locks in the same order as taven_create_phase_reservation.
   * The slice-result trigger also takes a profile lock, so inventory must never
   * be acquired before this sequence.
   */
  private async lockCandidateResources(
    transaction: Prisma.TransactionClient,
    resources: CandidateResourceLockInput,
  ): Promise<ObservedResourceRow> {
    const profileRows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT profile.id
      FROM machine_profiles profile
      WHERE profile.id = ${resources.machineProfileId}::uuid
      FOR UPDATE
    `;
    if (!profileRows[0]) {
      throw new ResourceNotFoundError(
        "candidate machine profile is no longer available",
      );
    }

    const machineRows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT machine.id
      FROM machines machine
      WHERE machine.id = ${resources.machineId}::uuid
        AND machine.node_id = ${resources.nodeId}::uuid
      FOR UPDATE
    `;
    if (!machineRows[0]) {
      throw new ResourceNotFoundError(
        "candidate machine is no longer available in the dispatched node",
      );
    }

    const calibrationRows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT calibration.id
      FROM machine_calibrations calibration
      WHERE calibration.id = ${resources.machineCalibrationId}::uuid
        AND calibration.node_id = ${resources.nodeId}::uuid
        AND calibration.machine_id = ${resources.machineId}::uuid
      FOR UPDATE
    `;
    if (!calibrationRows[0]) {
      throw new ResourceNotFoundError(
        "candidate machine calibration is no longer available on the dispatched machine",
      );
    }

    const observedRows = await transaction.$queryRaw<ObservedResourceRow[]>`
      SELECT clock_timestamp() AS observed_at,
             inventory.remaining_milligrams,
             inventory.reserved_milligrams
      FROM inventories inventory
      WHERE inventory.id = ${resources.inventoryId}::uuid
        AND inventory.node_id = ${resources.nodeId}::uuid
        AND inventory.machine_id = ${resources.machineId}::uuid
      FOR UPDATE
    `;
    const observed = observedRows[0];
    if (!observed) {
      throw new ResourceNotFoundError(
        "candidate inventory is no longer available in the dispatched node",
      );
    }
    return observed;
  }

  private async hasSameDispatchEffect(
    persisted: DispatchPayload,
    attempted: DispatchPayload,
  ): Promise<boolean> {
    if (
      persisted.nodeId !== attempted.nodeId ||
      persisted.inventoryId !== attempted.inventoryId
    ) {
      return false;
    }
    const { slicingJobEffectFingerprint } =
      await import("@taven/slicer-contracts");
    return (
      slicingJobEffectFingerprint(persisted.job) ===
      slicingJobEffectFingerprint(attempted.job)
    );
  }

  private async findTerminalReceipt(
    transaction: Prisma.TransactionClient,
    dispatchId: string,
  ): Promise<CandidateTerminalReceiptRow | undefined> {
    const rows = await transaction.$queryRaw<CandidateTerminalReceiptRow[]>`
      SELECT receipt.outcome::text AS outcome,
             receipt.result_fingerprint_sha256,
             receipt.candidate_resource_estimate_id,
             candidate.estimate_key,
             receipt.failure_class,
             receipt.failure_code
      FROM candidate_estimate_terminal_results receipt
      LEFT JOIN candidate_resource_estimates candidate
        ON candidate.id = receipt.candidate_resource_estimate_id
      WHERE receipt.outbox_message_id = ${dispatchId}::uuid
    `;
    return rows[0];
  }

  private async recordFailedTerminalReceipt(
    transaction: Prisma.TransactionClient,
    dispatchId: string,
    resultFingerprint: string,
    failureClass: string,
    failureCode: string,
  ): Promise<void> {
    await transaction.$executeRaw`
      INSERT INTO candidate_estimate_terminal_results (
        outbox_message_id,
        result_fingerprint_sha256,
        outcome,
        failure_class,
        failure_code
      ) VALUES (
        ${dispatchId}::uuid,
        ${resultFingerprint},
        'FAILED'::candidate_estimate_terminal_outcome,
        ${failureClass},
        ${failureCode}
      )
    `;
  }

  private async recordSucceededTerminalReceipt(
    transaction: Prisma.TransactionClient,
    dispatchId: string,
    resultFingerprint: string,
    candidateResourceEstimateId: string,
  ): Promise<void> {
    await transaction.$executeRaw`
      INSERT INTO candidate_estimate_terminal_results (
        outbox_message_id,
        result_fingerprint_sha256,
        outcome,
        candidate_resource_estimate_id
      ) VALUES (
        ${dispatchId}::uuid,
        ${resultFingerprint},
        'SUCCEEDED'::candidate_estimate_terminal_outcome,
        ${candidateResourceEstimateId}::uuid
      )
    `;
  }
}
