import { Inject, Injectable } from "@nestjs/common";
import {
  JobFailureStage,
  JobStatus,
  PreflightSeverity,
  SliceKind,
  type Prisma,
} from "@prisma/client";
import type {
  ModelInspectionResult,
  ProductionSliceResult,
  ReferenceSliceResult,
  SlicingJob,
  SlicingResult,
} from "@taven/slicer-contracts" with { "resolution-mode": "import" };
import { PrismaService } from "../../prisma/prisma.service";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../storage/object-storage.port";

type Transaction = Prisma.TransactionClient;

type PersistableFinding = Extract<
  ModelInspectionResult["outcome"],
  { status: "succeeded" }
>["findings"][number];

type PersistedGeometryIdentity = {
  sourceModelFileId: string;
  sourceContentSha256: string;
  modelGeometryId: string;
  canonicalObjectKey: string;
  geometrySha256: string;
};

type SliceExpectation = {
  kind: SliceKind;
  modelGeometryId: string;
  printConfigRevisionId: string;
  referenceProfileId: string | null;
  machineProfileId: string | null;
  machineCalibrationId: string | null;
  arrangementRevisionId: string | null;
  packageQuantity: number | null;
  packagePlateCount: number | null;
  partsPerPlate: number;
  artifactObjectKey: string;
  artifactHash: string;
  estimatedPrintSeconds: bigint;
  estimatedMaterialMilligrams: bigint;
  slicerEngine: string;
  slicerVersion: string;
};

type UploadedArtifact = {
  objectKey: string;
  owner: "modelGeometry" | "sliceResult";
};

const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

const severity = {
  info: PreflightSeverity.INFO,
  warning: PreflightSeverity.WARNING,
  blocking: PreflightSeverity.BLOCKING,
} as const;

export class PermanentSlicingResultIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSlicingResultIngestionError";
  }
}

function cleanupArtifactObjectKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = (value as Record<string, unknown>)["cleanupArtifactObjectKey"];
  return typeof key === "string" ? key : null;
}

function staleProductionResult(
  result: ProductionSliceResult,
  reason: string,
): Prisma.InputJsonObject {
  return {
    status: "stale",
    reason,
    ...(result.outcome.status === "succeeded"
      ? { cleanupArtifactObjectKey: result.outcome.artifact.objectKey }
      : {}),
  };
}

function uploadedArtifacts(result: SlicingResult): UploadedArtifact[] {
  if (result.outcome.status !== "succeeded") return [];
  if (result.kind === "model_inspection") {
    return result.outcome.canonicalGeometry
      ? [
          {
            objectKey: result.outcome.canonicalGeometry.canonicalObjectKey,
            owner: "modelGeometry",
          },
        ]
      : [];
  }
  if (result.kind === "reference_slice" || result.kind === "production_slice") {
    return [
      {
        objectKey: result.outcome.artifact.objectKey,
        owner: "sliceResult",
      },
    ];
  }
  if (result.kind === "candidate_estimate") {
    return result.outcome.occupancySlices.map(({ artifact }) => ({
      objectKey: artifact.objectKey,
      owner: "sliceResult",
    }));
  }
  return [];
}

@Injectable()
export class SlicingResultIngestionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
  ) {}

  async ingest(input: {
    dispatchId: string;
    job: SlicingJob;
    result: SlicingResult;
    resultFingerprintSha256: string;
  }): Promise<void> {
    let cleanupObjectKey: string | null;
    try {
      cleanupObjectKey = await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${input.dispatchId}, 0))::text
      `;
        const messageType = `slicing.${input.result.kind}.result-received`;
        const existingReceipt = await transaction.outboxMessage.findFirst({
          where: {
            aggregateType: "SlicingDispatchResult",
            aggregateId: input.dispatchId,
            messageType,
          },
        });
        if (existingReceipt) {
          const payload = existingReceipt.payload as Record<string, unknown>;
          if (
            payload.resultFingerprintSha256 !== input.resultFingerprintSha256
          ) {
            throw new PermanentSlicingResultIngestionError(
              "slicing dispatch already has a different terminal result",
            );
          }
          return cleanupArtifactObjectKey(
            (payload["materialization"] as unknown) ?? null,
          );
        }

        let materialization: Prisma.InputJsonObject = { status: "recorded" };
        if (input.result.kind === "model_inspection") {
          materialization = await this.ingestInspection(
            transaction,
            input.result,
            input.resultFingerprintSha256,
          );
        } else if (input.result.kind === "reference_slice") {
          materialization = await this.ingestReference(
            transaction,
            input.result,
            input.resultFingerprintSha256,
          );
        } else if (input.result.kind === "production_slice") {
          materialization = await this.ingestProduction(
            transaction,
            input.result,
            input.dispatchId,
          );
        }

        await transaction.outboxMessage.create({
          data: {
            deduplicationKey: `slicer-result:v2:${input.dispatchId}:${input.resultFingerprintSha256}`,
            aggregateType: "SlicingDispatchResult",
            aggregateId: input.dispatchId,
            messageType,
            schemaVersion: input.result.contractVersion,
            payload: {
              dispatchId: input.dispatchId,
              jobId: input.job.jobId,
              resultFingerprintSha256: input.resultFingerprintSha256,
              materialization,
              result: input.result as unknown as Prisma.InputJsonObject,
            },
          },
        });
        return cleanupArtifactObjectKey(materialization);
      });
    } catch (error) {
      if (error instanceof PermanentSlicingResultIngestionError) {
        await this.deleteUnownedUploadedArtifacts(input.result);
      }
      throw error;
    }
    if (cleanupObjectKey) {
      await this.objects.deleteObjects([cleanupObjectKey]);
    }
  }

  async deleteUnownedUploadedArtifacts(result: SlicingResult): Promise<void> {
    const artifacts = [
      ...new Map(
        uploadedArtifacts(result).map((artifact) => [
          artifact.objectKey,
          artifact,
        ]),
      ).values(),
    ];
    const unownedKeys: string[] = [];
    for (const artifact of artifacts) {
      const owner =
        artifact.owner === "modelGeometry"
          ? await this.prisma.modelGeometry.findUnique({
              where: { canonicalObjectKey: artifact.objectKey },
              select: { id: true },
            })
          : await this.prisma.sliceResult.findUnique({
              where: { artifactObjectKey: artifact.objectKey },
              select: { id: true },
            });
      if (!owner) unownedKeys.push(artifact.objectKey);
    }
    if (unownedKeys.length > 0) await this.objects.deleteObjects(unownedKeys);
  }

  private async ingestInspection(
    transaction: Transaction,
    result: ModelInspectionResult,
    resultFingerprintSha256: string,
  ): Promise<Prisma.InputJsonObject> {
    const source = await transaction.modelFile.findFirst({
      where: {
        id: result.input.source.modelFileId,
        storageObjectKey: result.input.source.objectKey,
        contentHash: result.input.source.contentSha256,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!source) {
      throw new PermanentSlicingResultIngestionError(
        "inspection result source no longer matches its persisted model file",
      );
    }
    if (result.outcome.status === "failed") {
      return {
        status: "failed",
        failureClass: result.outcome.failureClass,
        failureCode: result.outcome.code,
      };
    }

    let modelGeometryId: string | null = null;
    if (result.input.operation.mode === "canonicalize_selection") {
      const artifact = result.outcome.canonicalGeometry;
      if (!artifact) {
        throw new PermanentSlicingResultIngestionError(
          "canonical inspection result has no geometry artifact",
        );
      }
      const aggregateVolumeCubicMicrometers = result.outcome.bodies.reduce(
        (total, body) => total + BigInt(body.volumeCubicMicrometers),
        0n,
      );
      if (aggregateVolumeCubicMicrometers > MAX_SIGNED_INT64) {
        throw new PermanentSlicingResultIngestionError(
          "canonical geometry aggregate volume exceeds PostgreSQL bigint",
        );
      }
      const expected = {
        id: artifact.modelGeometryId,
        sourceModelFileId: result.input.source.modelFileId,
        sourceSelector: JSON.stringify({
          bodyIds: artifact.bodyIds,
          selectionSha256: artifact.selectionSha256,
          appliedUnitConversion: artifact.appliedUnitConversion,
        }),
        canonicalObjectKey: artifact.canonicalObjectKey,
        geometryHash: artifact.geometrySha256,
        canonicalizerRevision: result.input.canonicalizerRevision,
        volumeCubicMicrometers: aggregateVolumeCubicMicrometers,
        boundsXMicrometers: BigInt(
          result.outcome.metrics.boundingBox.xMicrometers,
        ),
        boundsYMicrometers: BigInt(
          result.outcome.metrics.boundingBox.yMicrometers,
        ),
        boundsZMicrometers: BigInt(
          result.outcome.metrics.boundingBox.zMicrometers,
        ),
        triangleCount: result.outcome.bodies.reduce(
          (total, body) => total + body.triangleCount,
          0,
        ),
      } as const;
      const existing = await transaction.modelGeometry.findMany({
        where: {
          OR: [
            { id: expected.id },
            { canonicalObjectKey: expected.canonicalObjectKey },
          ],
        },
      });
      if (existing.length > 1) {
        throw new PermanentSlicingResultIngestionError(
          "canonical geometry ID and object key belong to different rows",
        );
      }
      if (existing[0]) {
        for (const [key, value] of Object.entries(expected)) {
          if (existing[0][key as keyof (typeof existing)[0]] !== value) {
            throw new PermanentSlicingResultIngestionError(
              "canonical geometry conflicts with immutable persisted geometry",
            );
          }
        }
      } else {
        await transaction.modelGeometry.create({ data: expected });
      }
      modelGeometryId = expected.id;
    }

    await this.ingestFindings(transaction, {
      modelFileId: result.input.source.modelFileId,
      modelGeometryId,
      inspectionRevision: result.input.inspectionRevision,
      findings: result.outcome.findings,
      resultFingerprintSha256,
    });
    return {
      status: "materialized",
      ...(modelGeometryId ? { modelGeometryId } : {}),
      findingCount: result.outcome.findings.length,
    };
  }

  private async ingestReference(
    transaction: Transaction,
    result: ReferenceSliceResult,
    resultFingerprintSha256: string,
  ): Promise<Prisma.InputJsonObject> {
    if (result.outcome.status === "failed") {
      return {
        status: "failed",
        failureClass: result.outcome.failureClass,
        failureCode: result.outcome.code,
      };
    }
    await this.assertGeometry(transaction, result.input.geometry);
    const [profile, printConfig] = await Promise.all([
      transaction.referenceProfile.findFirst({
        where: {
          id: result.input.referenceProfile.revisionId,
          state: "ACTIVE",
          slicerEngine: result.input.referenceProfile.slicerEngine,
          slicerVersion: result.input.referenceProfile.slicerVersion,
        },
        select: { id: true },
      }),
      transaction.printConfigRevision.findFirst({
        where: {
          id: result.input.printConfig.revisionId,
        },
        select: { id: true },
      }),
    ]);
    if (!profile || !printConfig) {
      throw new PermanentSlicingResultIngestionError(
        "reference result no longer matches persisted profile revisions",
      );
    }
    const { buildReferenceSliceCacheKey, RevisionRef, Sha256Digest } =
      await import("@taven/core");
    const cacheKey = buildReferenceSliceCacheKey({
      geometryHash: Sha256Digest.parse(result.input.geometry.geometrySha256),
      modelGeometryId: result.input.geometry.modelGeometryId,
      geometrySelectionHash: Sha256Digest.parse(
        result.input.geometry.selectionSha256,
      ),
      referenceProfileRevision: RevisionRef.create(
        "reference-profile",
        result.input.referenceProfile.revisionId,
      ),
      printConfigRevision: RevisionRef.create(
        "print-config",
        result.input.printConfig.revisionId,
      ),
      partsPerPlate: result.input.partsPerPlate,
    });
    const slice = await this.createOrVerifySlice(transaction, cacheKey, {
      kind: SliceKind.REFERENCE,
      modelGeometryId: result.input.geometry.modelGeometryId,
      printConfigRevisionId: result.input.printConfig.revisionId,
      referenceProfileId: result.input.referenceProfile.revisionId,
      machineProfileId: null,
      machineCalibrationId: null,
      arrangementRevisionId: null,
      packageQuantity: null,
      packagePlateCount: null,
      partsPerPlate: result.input.partsPerPlate,
      artifactObjectKey: result.outcome.artifact.objectKey,
      artifactHash: result.outcome.artifact.sha256,
      estimatedPrintSeconds: BigInt(
        result.outcome.metrics.estimatedPrintSeconds,
      ),
      estimatedMaterialMilligrams: BigInt(
        result.outcome.metrics.estimatedMaterialMilligrams,
      ),
      slicerEngine: result.engine.name,
      slicerVersion: result.engine.version,
    });
    await this.ingestFindings(transaction, {
      modelFileId: result.input.geometry.sourceModelFileId,
      modelGeometryId: result.input.geometry.modelGeometryId,
      inspectionRevision: result.inputFingerprintSha256,
      findings: result.outcome.findings,
      resultFingerprintSha256,
    });
    return {
      status: "materialized",
      sliceResultId: slice.id,
      findingCount: result.outcome.findings.length,
    };
  }

  private async ingestProduction(
    transaction: Transaction,
    result: ProductionSliceResult,
    dispatchId: string,
  ): Promise<Prisma.InputJsonObject> {
    const identity = await transaction.job.findUnique({
      where: { id: result.jobId },
      select: { orderId: true },
    });
    if (!identity) {
      return staleProductionResult(result, "job-no-longer-exists");
    }
    await transaction.$queryRaw`
      SELECT id FROM orders WHERE id = ${identity.orderId}::uuid FOR UPDATE
    `;
    if (result.outcome.status === "failed") {
      await this.lockCancellationTopology(transaction, identity.orderId);
    } else {
      await transaction.$queryRaw`
        SELECT id FROM jobs WHERE id = ${result.jobId}::uuid FOR UPDATE
      `;
      await transaction.$queryRaw`
        SELECT id FROM production_reservations
        WHERE id = ${result.input.productionReservationId}::uuid
        FOR UPDATE
      `;
    }
    const job = await transaction.job.findUnique({
      where: { id: result.jobId },
      select: {
        id: true,
        orderId: true,
        status: true,
        productionSliceResultId: true,
        productionArtifactHash: true,
        productionReservations: {
          where: { id: result.input.productionReservationId },
          select: {
            id: true,
            status: true,
            jobId: true,
            machineId: true,
            printConfigRevisionId: true,
            machineProfileId: true,
            machineCalibrationId: true,
            productionSliceResultId: true,
            phaseResourcePlanJob: {
              select: {
                candidateResourceEstimate: {
                  select: {
                    modelGeometryId: true,
                    arrangementRevisionId: true,
                    quantity: true,
                    partsPerPlate: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const reservation = job?.productionReservations[0];
    const candidate =
      reservation?.phaseResourcePlanJob.candidateResourceEstimate;
    if (
      !job ||
      !reservation ||
      !candidate ||
      reservation.jobId !== result.jobId ||
      reservation.machineId !== result.input.machineId ||
      reservation.printConfigRevisionId !==
        result.input.printConfig.revisionId ||
      reservation.machineProfileId !== result.input.machineProfile.revisionId ||
      reservation.machineCalibrationId !==
        result.input.machineCalibration.revisionId ||
      candidate.modelGeometryId !== result.input.geometry.modelGeometryId ||
      candidate.arrangementRevisionId !==
        result.input.arrangementRevision.revisionId ||
      candidate.quantity !== result.input.quantity ||
      candidate.partsPerPlate !== result.input.partsPerPlate
    ) {
      return staleProductionResult(result, "production-inputs-changed");
    }
    if (result.outcome.status === "failed") {
      if (job.status === JobStatus.ACCEPTED) {
        const canCancel = await this.canCancelPreProductionOrder(
          transaction,
          job.orderId,
          job.id,
        );
        if (!canCancel) {
          return {
            status: "manual_reconciliation_required",
            reason: "order-no-longer-pre-production",
            failureClass: result.outcome.failureClass,
            failureCode: result.outcome.code,
          };
        }
        await this.failProduction(transaction, {
          dispatchId,
          jobId: job.id,
          orderId: job.orderId,
          failureReason: `${result.outcome.failureClass}/${result.outcome.code}: ${result.outcome.message}`,
        });
        return {
          status: "failed",
          failureClass: result.outcome.failureClass,
          failureCode: result.outcome.code,
        };
      }
      return { status: "stale", reason: "job-no-longer-accepted" };
    }
    if (
      job.status !== JobStatus.ACCEPTED ||
      reservation.status !== "HELD" ||
      reservation.productionSliceResultId !== null
    ) {
      if (
        job.status === JobStatus.GCODE_READY &&
        job.productionArtifactHash === result.outcome.artifact.sha256 &&
        job.productionSliceResultId === reservation.productionSliceResultId
      ) {
        return {
          status: "materialized",
          sliceResultId: job.productionSliceResultId!,
        };
      }
      return staleProductionResult(result, "reservation-no-longer-held");
    }
    await this.assertGeometry(transaction, result.input.geometry);
    const { buildProductionPackageKey, RevisionRef, Sha256Digest } =
      await import("@taven/core");
    const cacheKey = buildProductionPackageKey({
      geometryHash: Sha256Digest.parse(result.input.geometry.geometrySha256),
      modelGeometryId: result.input.geometry.modelGeometryId,
      geometrySelectionHash: Sha256Digest.parse(
        result.input.geometry.selectionSha256,
      ),
      machineProfileRevision: RevisionRef.create(
        "machine-profile",
        result.input.machineProfile.revisionId,
      ),
      machineCalibrationRevision: RevisionRef.create(
        "machine-calibration",
        result.input.machineCalibration.revisionId,
      ),
      printConfigRevision: RevisionRef.create(
        "print-config",
        result.input.printConfig.revisionId,
      ),
      arrangementRevision: RevisionRef.create(
        "arrangement",
        result.input.arrangementRevision.revisionId,
      ),
      partsPerPlate: result.input.partsPerPlate,
      quantity: result.input.quantity,
      acceptedJobId: result.input.acceptedJobId,
    });
    const slice = await this.createOrVerifySlice(transaction, cacheKey, {
      kind: SliceKind.PRODUCTION,
      modelGeometryId: result.input.geometry.modelGeometryId,
      printConfigRevisionId: result.input.printConfig.revisionId,
      referenceProfileId: null,
      machineProfileId: result.input.machineProfile.revisionId,
      machineCalibrationId: result.input.machineCalibration.revisionId,
      arrangementRevisionId: result.input.arrangementRevision.revisionId,
      packageQuantity: result.input.quantity,
      packagePlateCount: result.outcome.metrics.plateCount,
      partsPerPlate: result.input.partsPerPlate,
      artifactObjectKey: result.outcome.artifact.objectKey,
      artifactHash: result.outcome.artifact.sha256,
      estimatedPrintSeconds: BigInt(
        result.outcome.metrics.estimatedPrintSeconds,
      ),
      estimatedMaterialMilligrams: BigInt(
        result.outcome.metrics.estimatedMaterialMilligrams,
      ),
      slicerEngine: result.engine.name,
      slicerVersion: result.engine.version,
    });
    const bound = await transaction.productionReservation.updateMany({
      where: {
        id: reservation.id,
        jobId: job.id,
        status: "HELD",
        productionSliceResultId: null,
      },
      data: { productionSliceResultId: slice.id },
    });
    if (bound.count !== 1) {
      throw new Error("production reservation changed while binding G-code");
    }
    const ready = await transaction.job.updateMany({
      where: {
        id: job.id,
        status: JobStatus.ACCEPTED,
        productionSliceResultId: null,
        productionArtifactHash: null,
        gcodeReadyAt: null,
      },
      data: {
        status: JobStatus.GCODE_READY,
        gcodeReadyAt: new Date(),
        productionSliceResultId: slice.id,
        productionArtifactHash: result.outcome.artifact.sha256,
      },
    });
    if (ready.count !== 1) {
      throw new Error("production Job changed while sealing G-code");
    }
    return { status: "materialized", sliceResultId: slice.id };
  }

  private async lockCancellationTopology(
    transaction: Transaction,
    orderId: string,
  ): Promise<void> {
    await transaction.$queryRaw`
      SELECT payment.id FROM payments payment
      WHERE payment.order_id = ${orderId}::uuid
      ORDER BY payment.id
      FOR UPDATE OF payment
    `;
    await transaction.$queryRaw`
      SELECT refund.id
      FROM refund_transactions refund
      JOIN payments payment ON payment.id = refund.payment_id
      WHERE payment.order_id = ${orderId}::uuid
      ORDER BY refund.id
      FOR UPDATE OF refund
    `;
    await transaction.$queryRaw`
      SELECT inventory_reservation.id
      FROM inventory_reservations inventory_reservation
      JOIN production_reservations production
        ON production.id = inventory_reservation.production_reservation_id
       AND production.node_id = inventory_reservation.node_id
      JOIN phase_resource_plans resource_plan
        ON resource_plan.id = production.phase_resource_plan_id
       AND resource_plan.node_id = production.node_id
      JOIN order_phases phase ON phase.id = resource_plan.order_phase_id
      WHERE phase.order_id = ${orderId}::uuid
      ORDER BY inventory_reservation.id
      FOR UPDATE OF inventory_reservation
    `;
    await transaction.$queryRaw`
      SELECT capacity_reservation.id
      FROM capacity_reservations capacity_reservation
      JOIN production_reservations production
        ON production.id = capacity_reservation.production_reservation_id
       AND production.node_id = capacity_reservation.node_id
      JOIN phase_resource_plans resource_plan
        ON resource_plan.id = production.phase_resource_plan_id
       AND resource_plan.node_id = production.node_id
      JOIN order_phases phase ON phase.id = resource_plan.order_phase_id
      WHERE phase.order_id = ${orderId}::uuid
      ORDER BY capacity_reservation.id
      FOR UPDATE OF capacity_reservation
    `;
    await transaction.$queryRaw`
      SELECT production.id
      FROM production_reservations production
      JOIN phase_resource_plans resource_plan
        ON resource_plan.id = production.phase_resource_plan_id
       AND resource_plan.node_id = production.node_id
      JOIN order_phases phase ON phase.id = resource_plan.order_phase_id
      WHERE phase.order_id = ${orderId}::uuid
      ORDER BY production.id
      FOR UPDATE OF production
    `;
    await transaction.$queryRaw`
      SELECT reservation_set.id
      FROM phase_reservation_sets reservation_set
      JOIN phase_resource_plans resource_plan
        ON resource_plan.id = reservation_set.phase_resource_plan_id
       AND resource_plan.node_id = reservation_set.node_id
      JOIN order_phases phase ON phase.id = resource_plan.order_phase_id
      WHERE phase.order_id = ${orderId}::uuid
      ORDER BY reservation_set.id
      FOR UPDATE OF reservation_set
    `;
    await transaction.$queryRaw`
      SELECT job.id FROM jobs job
      WHERE job.order_id = ${orderId}::uuid
      ORDER BY job.id
      FOR UPDATE OF job
    `;
    await transaction.$queryRaw`
      SELECT shipment.id FROM shipments shipment
      WHERE shipment.order_id = ${orderId}::uuid
      ORDER BY shipment.id
      FOR UPDATE OF shipment
    `;
    await transaction.$queryRaw`
      SELECT fulfilment_slot.id FROM fulfilment_slots fulfilment_slot
      WHERE fulfilment_slot.order_id = ${orderId}::uuid
      ORDER BY fulfilment_slot.id
      FOR UPDATE OF fulfilment_slot
    `;
    await transaction.$queryRaw`
      SELECT phase.id FROM order_phases phase
      WHERE phase.order_id = ${orderId}::uuid
      ORDER BY phase.id
      FOR UPDATE OF phase
    `;
  }

  private async canCancelPreProductionOrder(
    transaction: Transaction,
    orderId: string,
    failedJobId: string,
  ): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ safe: boolean }>>`
      SELECT (
        target_order.status IN ('CONFIRMED', 'IN_PRODUCTION')
        AND NOT EXISTS (
          SELECT 1 FROM order_phases phase
          WHERE phase.order_id = target_order.id
            AND phase.status NOT IN ('QUOTED', 'ACTIVE', 'IN_PRODUCTION')
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs job
          WHERE job.order_id = target_order.id
            AND job.id <> ${failedJobId}::uuid
            AND job.status NOT IN ('CREATED', 'ACCEPTED', 'GCODE_READY', 'CANCELLED')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM production_reservations production
          JOIN phase_resource_plans resource_plan
            ON resource_plan.id = production.phase_resource_plan_id
           AND resource_plan.node_id = production.node_id
          JOIN order_phases phase ON phase.id = resource_plan.order_phase_id
          WHERE phase.order_id = target_order.id
            AND production.status IN ('PRINTING', 'CONSUMED')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM inventory_reservations inventory_reservation
          JOIN production_reservations production
            ON production.id = inventory_reservation.production_reservation_id
           AND production.node_id = inventory_reservation.node_id
          JOIN phase_resource_plans resource_plan
            ON resource_plan.id = production.phase_resource_plan_id
           AND resource_plan.node_id = production.node_id
          JOIN order_phases phase ON phase.id = resource_plan.order_phase_id
          WHERE phase.order_id = target_order.id
            AND inventory_reservation.status = 'CONSUMED'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM capacity_reservations capacity_reservation
          JOIN production_reservations production
            ON production.id = capacity_reservation.production_reservation_id
           AND production.node_id = capacity_reservation.node_id
          JOIN phase_resource_plans resource_plan
            ON resource_plan.id = production.phase_resource_plan_id
           AND resource_plan.node_id = production.node_id
          JOIN order_phases phase ON phase.id = resource_plan.order_phase_id
          WHERE phase.order_id = target_order.id
            AND capacity_reservation.status IN ('PRINTING', 'COMPLETED')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM phase_reservation_sets reservation_set
          JOIN phase_resource_plans resource_plan
            ON resource_plan.id = reservation_set.phase_resource_plan_id
           AND resource_plan.node_id = reservation_set.node_id
          JOIN order_phases phase ON phase.id = resource_plan.order_phase_id
          WHERE phase.order_id = target_order.id
            AND reservation_set.status = 'SETTLED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM shipments shipment
          WHERE shipment.order_id = target_order.id
            AND shipment.status NOT IN ('PLANNED', 'CANCELLED')
        )
        AND NOT EXISTS (
          SELECT 1 FROM fulfilment_slots fulfilment_slot
          WHERE fulfilment_slot.order_id = target_order.id
            AND fulfilment_slot.outcome NOT IN ('PENDING', 'CANCELLED')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM refund_transactions refund
          JOIN payments payment ON payment.id = refund.payment_id
          WHERE payment.order_id = target_order.id
            AND refund.status IN ('PENDING', 'SUSPENDED')
        )
      ) AS safe
      FROM orders target_order
      WHERE target_order.id = ${orderId}::uuid
    `;
    return rows[0]?.safe === true;
  }

  private async failProduction(
    transaction: Transaction,
    input: {
      dispatchId: string;
      jobId: string;
      orderId: string;
      failureReason: string;
    },
  ): Promise<void> {
    const failedAt = new Date();
    await transaction.job.update({
      where: { id: input.jobId },
      data: {
        status: JobStatus.FAILED,
        failedAt,
        failureStage: JobFailureStage.GCODE,
        failureReason: input.failureReason,
      },
    });

    await transaction.$executeRaw`
      UPDATE payments
      SET status = CASE
            WHEN status IN ('CREATED', 'PENDING') THEN 'VOIDED'::payment_status
            ELSE status
          END,
          capture_authorized = false,
          capture_cutoff_at = coalesce(capture_cutoff_at, ${failedAt}),
          updated_at = ${failedAt}
      WHERE order_id = ${input.orderId}::uuid
        AND captured_amount_minor IS NULL
        AND status IN ('CREATED', 'PENDING', 'FAILED', 'VOIDED')
    `;
    const capturedPayments = await transaction.payment.findMany({
      where: {
        orderId: input.orderId,
        capturedAmountMinor: { not: null },
      },
      select: {
        id: true,
        provider: true,
        status: true,
        capturedAmountMinor: true,
        refunds: {
          where: { status: "SUCCEEDED" },
          select: { amountMinor: true },
        },
      },
      orderBy: { id: "asc" },
    });
    for (const payment of capturedPayments) {
      const succeeded = payment.refunds.reduce(
        (total, refund) => total + refund.amountMinor,
        0n,
      );
      const remaining = payment.capturedAmountMinor! - succeeded;
      if (remaining <= 0n) continue;
      await transaction.refundTransaction.create({
        data: {
          paymentId: payment.id,
          provider: payment.provider,
          idempotencyKey: `production-failure:${input.dispatchId}:${payment.id}`,
          amountMinor: remaining,
          reason: "PRODUCTION_FAILURE",
          status: "PENDING",
          requestedAt: failedAt,
        },
      });
      await transaction.payment.update({
        where: { id: payment.id },
        data: { status: "REFUND_PENDING", updatedAt: failedAt },
      });
    }

    await transaction.$executeRaw`
      UPDATE inventory_reservations inventory_reservation
      SET status = 'RELEASED', updated_at = ${failedAt}
      FROM production_reservations production,
           phase_resource_plans resource_plan,
           order_phases phase
      WHERE inventory_reservation.production_reservation_id = production.id
        AND inventory_reservation.node_id = production.node_id
        AND production.phase_resource_plan_id = resource_plan.id
        AND production.node_id = resource_plan.node_id
        AND resource_plan.order_phase_id = phase.id
        AND phase.order_id = ${input.orderId}::uuid
        AND inventory_reservation.status IN ('RESERVED', 'HELD', 'ALLOCATED')
    `;
    await transaction.$executeRaw`
      UPDATE capacity_reservations capacity_reservation
      SET status = 'RELEASED', updated_at = ${failedAt}
      FROM production_reservations production,
           phase_resource_plans resource_plan,
           order_phases phase
      WHERE capacity_reservation.production_reservation_id = production.id
        AND capacity_reservation.node_id = production.node_id
        AND production.phase_resource_plan_id = resource_plan.id
        AND production.node_id = resource_plan.node_id
        AND resource_plan.order_phase_id = phase.id
        AND phase.order_id = ${input.orderId}::uuid
        AND capacity_reservation.status IN ('RESERVED', 'HELD', 'SCHEDULED')
    `;
    await transaction.$executeRaw`
      UPDATE production_reservations production
      SET status = 'RELEASED', updated_at = ${failedAt}
      FROM phase_resource_plans resource_plan,
           order_phases phase
      WHERE production.phase_resource_plan_id = resource_plan.id
        AND production.node_id = resource_plan.node_id
        AND resource_plan.order_phase_id = phase.id
        AND phase.order_id = ${input.orderId}::uuid
        AND production.status IN ('RESERVED', 'HELD', 'SCHEDULED')
    `;
    await transaction.$executeRaw`
      UPDATE phase_reservation_sets reservation_set
      SET status = 'RELEASED', updated_at = ${failedAt}
      FROM phase_resource_plans resource_plan,
           order_phases phase
      WHERE reservation_set.phase_resource_plan_id = resource_plan.id
        AND reservation_set.node_id = resource_plan.node_id
        AND resource_plan.order_phase_id = phase.id
        AND phase.order_id = ${input.orderId}::uuid
        AND reservation_set.status IN ('BUILDING', 'RESERVED', 'HELD')
    `;
    await transaction.$executeRaw`
      UPDATE jobs
      SET status = 'CANCELLED', cancelled_at = ${failedAt},
          cancellation_reason = 'ORDER_CANCELLED', updated_at = ${failedAt}
      WHERE order_id = ${input.orderId}::uuid
        AND status IN ('CREATED', 'ACCEPTED', 'GCODE_READY')
    `;
    await transaction.$executeRaw`
      UPDATE shipments
      SET status = 'CANCELLED', cancelled_at = ${failedAt}, updated_at = ${failedAt}
      WHERE order_id = ${input.orderId}::uuid AND status = 'PLANNED'
    `;
    await transaction.$executeRaw`
      UPDATE fulfilment_slots
      SET outcome = 'CANCELLED', updated_at = ${failedAt}
      WHERE order_id = ${input.orderId}::uuid AND outcome = 'PENDING'
    `;
    await transaction.$executeRaw`
      UPDATE order_phases
      SET status = 'CANCELLED', cancelled_at = ${failedAt}, updated_at = ${failedAt}
      WHERE order_id = ${input.orderId}::uuid
        AND status IN ('QUOTED', 'ACTIVE', 'IN_PRODUCTION')
    `;
    await transaction.$executeRaw`
      UPDATE orders
      SET status = 'CANCELLED', updated_at = ${failedAt}
      WHERE id = ${input.orderId}::uuid
    `;
  }

  private async assertGeometry(
    transaction: Transaction,
    geometry: PersistedGeometryIdentity,
  ): Promise<void> {
    const persisted = await transaction.modelGeometry.findFirst({
      where: {
        id: geometry.modelGeometryId,
        sourceModelFileId: geometry.sourceModelFileId,
        canonicalObjectKey: geometry.canonicalObjectKey,
        geometryHash: geometry.geometrySha256,
        deletedAt: null,
        sourceModelFile: {
          contentHash: geometry.sourceContentSha256,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!persisted) {
      throw new PermanentSlicingResultIngestionError(
        "slicing result geometry no longer matches persisted immutable input",
      );
    }
  }

  private async createOrVerifySlice(
    transaction: Transaction,
    cacheKey: string,
    expected: SliceExpectation,
  ) {
    const existing = await transaction.sliceResult.findUnique({
      where: { cacheKey },
    });
    if (existing) {
      for (const [key, value] of Object.entries(expected)) {
        if (existing[key as keyof typeof existing] !== value) {
          throw new PermanentSlicingResultIngestionError(
            "slice cache key belongs to different immutable metrics",
          );
        }
      }
      return existing;
    }
    return transaction.sliceResult.create({ data: { cacheKey, ...expected } });
  }

  private async ingestFindings(
    transaction: Transaction,
    input: {
      modelFileId: string;
      modelGeometryId: string | null;
      inspectionRevision: string;
      findings: readonly PersistableFinding[];
      resultFingerprintSha256: string;
    },
  ): Promise<void> {
    for (const finding of input.findings) {
      const findingScope = [
        "slicing-finding-v1",
        input.modelGeometryId ?? input.modelFileId,
        input.inspectionRevision,
        finding.code,
      ].join(":");
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${findingScope}, 0))::text
      `;
      const expected = {
        modelFileId: input.modelFileId,
        modelGeometryId: input.modelGeometryId,
        inspectionRevision: input.inspectionRevision,
        code: finding.code,
        severity: severity[finding.severity],
        message: finding.message,
        evidence: {
          phase: finding.phase,
          acknowledgementKey: finding.acknowledgementKey,
          resultFingerprintSha256: input.resultFingerprintSha256,
        } satisfies Prisma.InputJsonObject,
      } as const;
      const existing = await transaction.preflightFinding.findFirst({
        where: {
          modelFileId: input.modelFileId,
          modelGeometryId: input.modelGeometryId,
          inspectionRevision: input.inspectionRevision,
          code: finding.code,
        },
      });
      if (existing) {
        if (
          existing.severity !== expected.severity ||
          existing.message !== expected.message ||
          JSON.stringify(existing.evidence) !==
            JSON.stringify(expected.evidence)
        ) {
          throw new PermanentSlicingResultIngestionError(
            "preflight finding conflicts with immutable persisted evidence",
          );
        }
        continue;
      }
      await transaction.preflightFinding.create({ data: expected });
    }
  }
}
