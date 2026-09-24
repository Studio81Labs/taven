import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  AutomaticQuoteRiskDecision,
  JobStatus,
  Prisma,
  RetentionHold,
  SliceKind,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { AuditService } from "../audit/audit.service";
import { slicerSettingsSnapshot } from "../slicing/slicer-profile-snapshot.service";
import {
  OBJECT_STORAGE,
  ObjectStorageDeadlineError,
  type ObjectStorage,
  type StoredObjectMetadata,
} from "../storage/object-storage.port";
import {
  OBJECT_STORAGE_CONFIG,
  type ObjectStorageConfig,
} from "../storage/storage.config";
import type {
  OperatorJobArtifactAvailabilityDto,
  OperatorJobArtifactDownloadDto,
  OperatorJobDetailDto,
  OperatorActionDto,
} from "./operator-reads.dto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCTION_STATES = new Set<JobStatus>([
  JobStatus.GCODE_READY,
  JobStatus.PRINTING,
  JobStatus.PRINTED,
  JobStatus.PHOTO_SUBMITTED,
  JobStatus.QC_APPROVED,
  JobStatus.PACKED,
  JobStatus.HANDED_OVER,
]);
const TERMINAL_STATES = new Set<JobStatus>([
  JobStatus.SETTLED,
  JobStatus.CANCELLED,
  JobStatus.FAILED,
  JobStatus.QC_REJECTED,
]);

function jobActions(
  operator: OperatorContext,
  job: OperatorJobDetailDto,
  readiness: { held: boolean; machineReady: boolean; mounted: boolean },
): OperatorActionDto[] {
  const actions: OperatorActionDto[] = [];
  const canOperate = operator.permissions.includes(
    OPERATOR_PERMISSIONS.OPERATIONS_WRITE,
  );
  const add = (
    action: string,
    blockingCodes: string[] = [],
    requiresReason = false,
    requiresConfirmation = false,
  ) => {
    if (canOperate)
      actions.push({
        action,
        targetType: "JOB",
        targetId: job.id,
        enabled: blockingCodes.length === 0,
        blockingCodes,
        requiresReason,
        requiresConfirmation,
      });
  };
  for (const [action, available] of [
    ["DOWNLOAD_SOURCE_MODEL", job.artifacts.sourceModel.available],
    ["DOWNLOAD_PREVIEW", job.artifacts.preview.available],
    ["DOWNLOAD_PRODUCTION", job.artifacts.production.available],
  ] as const) {
    if (available)
      actions.push({
        action,
        targetType: "JOB",
        targetId: job.id,
        enabled: true,
        blockingCodes: [],
        requiresReason: false,
        requiresConfirmation: false,
      });
  }
  switch (job.status) {
    case JobStatus.CREATED:
      add("ACCEPT_JOB");
      break;
    case JobStatus.GCODE_READY:
      add("START_PRINTING", [
        ...(readiness.held ? [] : ["HELD_RESERVATION_REQUIRED"]),
        ...(readiness.machineReady ? [] : ["MACHINE_UNAVAILABLE"]),
        ...(readiness.mounted ? [] : ["MATERIAL_NOT_MOUNTED"]),
        ...(job.artifacts.production.available
          ? []
          : ["PRODUCTION_ARTIFACT_UNAVAILABLE"]),
      ]);
      break;
    case JobStatus.PRINTING:
      add("FINISH_PRINTING", ["ACTUAL_MATERIAL_REQUIRED"]);
      break;
    case JobStatus.PRINTED:
      add("SUBMIT_QC", ["QC_EVIDENCE_REQUIRED"]);
      break;
    case JobStatus.PHOTO_SUBMITTED:
      add("APPROVE_QC");
      break;
    case JobStatus.QC_APPROVED:
      add("PACK_JOB", ["MATCHING_SHIPMENT_REQUIRED"]);
      break;
    case JobStatus.FAILED:
    case JobStatus.QC_REJECTED:
      add("PREPARE_REPLACEMENT", ["FRESH_RESERVATION_REQUIRED"], true);
      break;
  }
  if (
    new Set<JobStatus>([
      JobStatus.ACCEPTED,
      JobStatus.GCODE_READY,
      JobStatus.PRINTING,
      JobStatus.PRINTED,
      JobStatus.PHOTO_SUBMITTED,
      JobStatus.QC_APPROVED,
      JobStatus.PACKED,
    ]).has(job.status as JobStatus)
  )
    add("FAIL_JOB", ["FAILURE_DETAILS_REQUIRED"], true, true);
  return actions;
}

export type JobArtifactKind = "SOURCE_MODEL" | "PREVIEW" | "PRODUCTION";

const jobInclude = {
  order: {
    select: {
      publicReference: true,
      individualOrigin: {
        select: { quote: { select: { promisedDate: true } } },
      },
      automaticQuoteDraft: {
        select: {
          items: {
            select: {
              ordinal: true,
              sourceModelFileId: true,
              bodyIds: true,
              selectionSha256: true,
              targetModelGeometryId: true,
              printConfigRevisionId: true,
              referenceProfileId: true,
              referencePartsPerPlate: true,
              quantity: true,
              configurationFingerprint: true,
              riskDecisions: {
                where: { decision: AutomaticQuoteRiskDecision.ACKNOWLEDGED },
                select: {
                  configurationFingerprint: true,
                  preflightFindingId: true,
                  acknowledgementKey: true,
                  preflightFinding: {
                    select: {
                      modelFileId: true,
                      modelGeometryId: true,
                      inspectionRevision: true,
                      code: true,
                      severity: true,
                      message: true,
                    },
                  },
                },
              },
              referenceProfile: {
                select: {
                  settings: true,
                  slicerEngine: true,
                  slicerVersion: true,
                },
              },
              printConfigRevision: { select: { settings: true } },
            },
          },
        },
      },
    },
  },
  shipmentPlan: { select: { ordinal: true } },
  shipmentAssignment: { select: { shipmentId: true } },
  replacementJob: { select: { id: true } },
  replacementRequestSource: { select: { id: true } },
  replacementRequestResult: { select: { id: true } },
  phaseResourcePlanJob: {
    include: {
      candidateResourceEstimate: {
        include: { inventory: { select: { mountStatus: true } } },
      },
      slots: {
        include: {
          fulfilmentSlot: {
            include: {
              shipmentPlanAllocations: {
                select: { shipmentPlanId: true },
              },
              orderItem: {
                include: {
                  sourceModelFile: true,
                  modelGeometry: true,
                  primaryReferenceSliceResult: {
                    select: {
                      kind: true,
                      modelGeometryId: true,
                      printConfigRevisionId: true,
                      referenceProfileId: true,
                      partsPerPlate: true,
                    },
                  },
                  tailReferenceSliceResult: {
                    select: {
                      kind: true,
                      modelGeometryId: true,
                      printConfigRevisionId: true,
                      referenceProfileId: true,
                      partsPerPlate: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  productionSliceResult: true,
  productionReservations: {
    select: { productionSliceResultId: true },
  },
} as const satisfies Prisma.JobInclude;

type ScopedJob = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

type ArtifactAssessment = {
  availability: OperatorJobArtifactAvailabilityDto;
  objectKey?: string;
  expectedHash?: string;
  metadata?: StoredObjectMetadata;
  deadline?: Date;
};

@Injectable()
export class OperatorJobArtifactsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
    @Inject(OBJECT_STORAGE_CONFIG)
    private readonly storageConfig: ObjectStorageConfig,
  ) {}

  async detail(
    operator: OperatorContext,
    jobId: string,
  ): Promise<OperatorJobDetailDto> {
    const job = await this.scopedJob(operator, jobId);
    const estimate = job.phaseResourcePlanJob.candidateResourceEstimate;
    const slots = this.exactSlots(job);
    const source = await this.assess(job, "SOURCE_MODEL", slots);
    const production = await this.assess(job, "PRODUCTION", slots);
    const readiness =
      job.status === JobStatus.GCODE_READY
        ? await this.printingReadiness(job)
        : { held: false, machineReady: false, mounted: false };
    const promisedDate = job.order.individualOrigin?.quote.promisedDate;
    const acceptedItems = new Map(
      (job.order.automaticQuoteDraft?.items ?? []).map((item) => [
        item.ordinal,
        item,
      ]),
    );
    const risksByItemId = new Map<
      string,
      OperatorJobDetailDto["slots"][number]["acceptedRisks"]
    >();
    for (const { fulfilmentSlot } of slots) {
      const item = fulfilmentSlot.orderItem;
      if (!risksByItemId.has(item.id)) {
        risksByItemId.set(
          item.id,
          await acceptedRisks(item, acceptedItems.get(item.ordinal)),
        );
      }
    }

    const detail: OperatorJobDetailDto = {
      id: job.id,
      nodeId: job.nodeId,
      orderId: job.orderId,
      orderReference: job.order.publicReference,
      orderPhaseId: job.orderPhaseId,
      shipmentPlanId: job.shipmentPlanId,
      shipmentPlanOrdinal: job.shipmentPlan.ordinal,
      shipmentId: job.shipmentAssignment?.shipmentId ?? null,
      status: job.status,
      replacesJobId: job.replacesJobId,
      replacementJobId: job.replacementJob?.id ?? null,
      sourceReplacementRequestId: job.replacementRequestSource?.id ?? null,
      resultReplacementRequestId: job.replacementRequestResult?.id ?? null,
      slots: slots.map(({ fulfilmentSlot }) => {
        const item = fulfilmentSlot.orderItem;
        return {
          fulfilmentSlotId: fulfilmentSlot.id,
          orderItemId: item.id,
          quantityOrdinal: fulfilmentSlot.quantityOrdinal,
          sourceModelFileId: item.sourceModelFileId,
          modelGeometryId: item.modelGeometryId,
          material: item.material,
          color: item.color,
          boundsXMicrometers: item.modelGeometry.boundsXMicrometers.toString(),
          boundsYMicrometers: item.modelGeometry.boundsYMicrometers.toString(),
          boundsZMicrometers: item.modelGeometry.boundsZMicrometers.toString(),
          volumeCubicMicrometers:
            item.modelGeometry.volumeCubicMicrometers.toString(),
          geometrySha256: item.modelGeometry.geometryHash,
          acceptedRisks: risksByItemId.get(item.id) ?? [],
        };
      }),
      estimate: {
        candidateResourceEstimateId: estimate.id,
        machineId: estimate.machineId,
        inventoryId: estimate.inventoryId,
        inventoryMountStatus: estimate.inventory.mountStatus,
        mountReadyForPrinting: estimate.inventory.mountStatus === "MOUNTED",
        printConfigRevisionId: estimate.printConfigRevisionId,
        machineProfileId: estimate.machineProfileId,
        machineCalibrationId: estimate.machineCalibrationId,
        quantity: estimate.quantity,
        partsPerPlate: estimate.partsPerPlate,
        plateCount: Math.ceil(estimate.quantity / estimate.partsPerPlate),
        requiredMachineSeconds: estimate.requiredMachineSeconds.toString(),
        requiredMaterialMilligrams:
          estimate.requiredMaterialMilligrams.toString(),
        calculatedAt: estimate.calculatedAt.toISOString(),
        provenance: "CANDIDATE_RESOURCE_ESTIMATE",
      },
      deadline: {
        date: promisedDate ? promisedDate.toISOString().slice(0, 10) : null,
        provenance: promisedDate
          ? "ACCEPTED_INDIVIDUAL_QUOTE"
          : "NO_PROMISED_DATE",
      },
      artifacts: {
        sourceModel: source.availability,
        preview: unavailable("NOT_GENERATED"),
        production: production.availability,
      },
      actions: [],
    };
    detail.actions = jobActions(operator, detail, readiness);
    return detail;
  }

  private async printingReadiness(job: ScopedJob): Promise<{
    held: boolean;
    machineReady: boolean;
    mounted: boolean;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ machineReady: boolean; mounted: boolean }>
    >`
      SELECT machine.status = 'ACTIVE'
           AND selection.revision_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM capacity_reservations interval
             WHERE interval.production_reservation_id = reservation.id
               AND NOT EXISTS (
                 SELECT 1 FROM machine_availability_windows available
                 WHERE available.revision_id = selection.revision_id
                   AND available.starts_at <= interval.starts_at
                   AND available.ends_at >= interval.ends_at
               )
           ) AS "machineReady",
           inventory.mount_status = 'MOUNTED' AS mounted
      FROM production_reservations reservation
      JOIN machines machine
        ON machine.id = reservation.machine_id
       AND machine.node_id = reservation.node_id
      JOIN inventories inventory
        ON inventory.id = reservation.inventory_id
       AND inventory.node_id = reservation.node_id
      LEFT JOIN machine_availability_selections selection
        ON selection.machine_id = machine.id
       AND selection.node_id = machine.node_id
      WHERE reservation.job_id = ${job.id}::uuid
        AND reservation.node_id = ${job.nodeId}::uuid
        AND reservation.status = 'HELD'
      LIMIT 1
    `;
    const row = rows[0];
    return {
      held: row !== undefined,
      machineReady: row?.machineReady === true,
      mounted: row?.mounted === true,
    };
  }

  async download(
    operator: OperatorContext,
    jobId: string,
    kind: string,
  ): Promise<OperatorJobArtifactDownloadDto> {
    if (!isArtifactKind(kind)) {
      throw new BadRequestException("Artifact kind is invalid");
    }
    const job = await this.scopedJob(operator, jobId);
    const assessment = await this.assess(job, kind, this.exactSlots(job));
    if (!assessment.availability.available) {
      if (
        assessment.availability.reason === "EXPIRED" ||
        assessment.availability.reason === "DELETED" ||
        assessment.availability.reason === "MISSING_BYTES"
      ) {
        throw new GoneException("Job artifact is no longer retained");
      }
      throw new ConflictException("Job artifact is unavailable");
    }
    const { objectKey, expectedHash, metadata, deadline } = assessment;
    if (!objectKey || !expectedHash || !metadata || !deadline) {
      throw new ConflictException("Job artifact is unavailable");
    }
    let signed;
    try {
      signed = await this.objects.createDownloadUrl({
        objectKey,
        expiresAt: deadline,
      });
    } catch (error) {
      if (error instanceof ObjectStorageDeadlineError) {
        throw new GoneException("Job artifact expired");
      }
      throw new ServiceUnavailableException("Artifact storage is unavailable");
    }
    await this.prisma.$transaction((transaction) =>
      this.audit.recordOperator(transaction, operator, {
        orderId: job.orderId,
        nodeId: job.nodeId,
        eventType: "job.artifact_download_issued",
        correlationId: randomUUID(),
        payload: { jobId: job.id, kind },
      }),
    );
    return {
      downloadUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      contentType: metadata.contentType,
      contentLength: String(metadata.contentLength),
      sha256: expectedHash,
    };
  }

  private async scopedJob(
    operator: OperatorContext,
    jobId: string,
  ): Promise<ScopedJob> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    const nodeId = operatorNode(operator);
    if (!UUID.test(jobId))
      throw new BadRequestException("jobId must be a UUID");
    const job = await this.prisma.job.findFirst({
      where: { id: jobId.toLowerCase(), nodeId },
      include: jobInclude,
    });
    if (!job) throw new NotFoundException("Job was not found");
    return job;
  }

  private exactSlots(
    job: ScopedJob,
  ): ScopedJob["phaseResourcePlanJob"]["slots"] {
    const slots = job.phaseResourcePlanJob.slots;
    const estimate = job.phaseResourcePlanJob.candidateResourceEstimate;
    if (
      slots.length === 0 ||
      slots.length !== estimate.quantity ||
      estimate.shipmentPlanId !== job.shipmentPlanId ||
      slots.some(
        ({ fulfilmentSlot }) =>
          fulfilmentSlot.orderId !== job.orderId ||
          fulfilmentSlot.orderPhaseId !== job.orderPhaseId ||
          !fulfilmentSlot.shipmentPlanAllocations.some(
            (allocation) => allocation.shipmentPlanId === job.shipmentPlanId,
          ) ||
          fulfilmentSlot.orderItem.modelGeometryId !==
            estimate.modelGeometryId ||
          fulfilmentSlot.orderItem.printConfigRevisionId !==
            estimate.printConfigRevisionId,
      )
    ) {
      throw new ConflictException("Job source lineage is inconsistent");
    }
    return [...slots].sort((left, right) =>
      left.fulfilmentSlot.id.localeCompare(right.fulfilmentSlot.id),
    );
  }

  private async assess(
    job: ScopedJob,
    kind: JobArtifactKind,
    slots: ScopedJob["phaseResourcePlanJob"]["slots"],
  ): Promise<ArtifactAssessment> {
    if (TERMINAL_STATES.has(job.status)) {
      return { availability: unavailable("TERMINAL_JOB") };
    }
    if (kind === "PREVIEW") {
      return { availability: unavailable("NOT_GENERATED") };
    }
    const estimate = job.phaseResourcePlanJob.candidateResourceEstimate;
    let objectKey: string;
    let expectedHash: string;
    let deadline = new Date(
      Date.now() + this.storageConfig.signedUrlTtlSeconds * 1_000,
    );

    if (kind === "SOURCE_MODEL") {
      const item = slots[0]!.fulfilmentSlot.orderItem;
      const source = item.sourceModelFile;
      if (
        slots.some(
          (slot) =>
            slot.fulfilmentSlot.orderItem.sourceModelFileId !== source.id,
        )
      ) {
        return { availability: unavailable("INTEGRITY_MISMATCH") };
      }
      if (source.deletedAt || item.modelGeometry.deletedAt) {
        return { availability: unavailable("DELETED") };
      }
      if (source.retentionHold === RetentionHold.NONE) {
        deadline = new Date(
          Math.min(deadline.getTime(), source.sourceDeleteAfter.getTime()),
        );
      }
      if (deadline.getTime() - Date.now() < 1_000) {
        return { availability: unavailable("EXPIRED") };
      }
      objectKey = source.storageObjectKey;
      expectedHash = source.contentHash;
    } else {
      if (!PRODUCTION_STATES.has(job.status)) {
        return { availability: unavailable("NOT_READY") };
      }
      const result = job.productionSliceResult;
      if (!result || !job.productionArtifactHash || !job.gcodeReadyAt) {
        return { availability: unavailable("NOT_READY") };
      }
      if (
        result.kind !== SliceKind.PRODUCTION ||
        result.artifactHash !== job.productionArtifactHash ||
        result.modelGeometryId !== estimate.modelGeometryId ||
        result.printConfigRevisionId !== estimate.printConfigRevisionId ||
        result.machineProfileId !== estimate.machineProfileId ||
        result.machineCalibrationId !== estimate.machineCalibrationId ||
        result.arrangementRevisionId !== estimate.arrangementRevisionId ||
        result.packageQuantity !== estimate.quantity ||
        result.partsPerPlate !== estimate.partsPerPlate ||
        !job.productionReservations.some(
          (reservation) => reservation.productionSliceResultId === result.id,
        )
      ) {
        return { availability: unavailable("INTEGRITY_MISMATCH") };
      }
      objectKey = result.artifactObjectKey;
      expectedHash = result.artifactHash;
    }

    let metadata: StoredObjectMetadata | null;
    try {
      metadata = await this.objects.headObject(objectKey);
    } catch {
      throw new ServiceUnavailableException("Artifact storage is unavailable");
    }
    if (!metadata) {
      return { availability: unavailable("MISSING_BYTES") };
    }
    if (metadata.contentHash !== expectedHash) {
      return { availability: unavailable("INTEGRITY_MISMATCH") };
    }
    return {
      availability: { available: true, reason: null },
      objectKey,
      expectedHash,
      metadata,
      deadline,
    };
  }
}

function unavailable(
  reason: NonNullable<OperatorJobArtifactAvailabilityDto["reason"]>,
): OperatorJobArtifactAvailabilityDto {
  return { available: false, reason };
}

function isArtifactKind(value: string): value is JobArtifactKind {
  return (
    value === "SOURCE_MODEL" || value === "PREVIEW" || value === "PRODUCTION"
  );
}

async function acceptedRisks(
  item: ScopedJob["phaseResourcePlanJob"]["slots"][number]["fulfilmentSlot"]["orderItem"],
  snapshot:
    | NonNullable<ScopedJob["order"]["automaticQuoteDraft"]>["items"][number]
    | undefined,
): Promise<OperatorJobDetailDto["slots"][number]["acceptedRisks"]> {
  if (
    !snapshot ||
    snapshot.sourceModelFileId !== item.sourceModelFileId ||
    snapshot.targetModelGeometryId !== item.modelGeometryId ||
    snapshot.printConfigRevisionId !== item.printConfigRevisionId ||
    snapshot.referencePartsPerPlate !== item.referencePartsPerPlate ||
    snapshot.quantity !== item.quantity
  ) {
    return [];
  }
  const references = [
    item.primaryReferenceSliceResult,
    item.tailReferenceSliceResult,
  ].filter((slice) => slice !== null);
  if (
    references.length === 0 ||
    snapshot.referencePartsPerPlate === null ||
    references.some(
      (slice) =>
        slice.kind !== SliceKind.REFERENCE ||
        slice.modelGeometryId !== item.modelGeometryId ||
        slice.printConfigRevisionId !== item.printConfigRevisionId ||
        slice.referenceProfileId !== snapshot.referenceProfileId,
    )
  ) {
    return [];
  }
  const scopedDecisions = snapshot.riskDecisions.filter(
    (decision) =>
      decision.configurationFingerprint === snapshot.configurationFingerprint &&
      decision.preflightFinding.modelFileId === item.sourceModelFileId &&
      decision.preflightFinding.modelGeometryId === item.modelGeometryId,
  );
  if (scopedDecisions.length === 0) return [];
  const partsPerPlate = snapshot.referencePartsPerPlate;
  const remainder = snapshot.quantity % partsPerPlate;
  const expectedOccupancies =
    snapshot.quantity <= partsPerPlate
      ? [snapshot.quantity]
      : remainder === 0
        ? [partsPerPlate]
        : [partsPerPlate, remainder];
  if (
    references.length !== expectedOccupancies.length ||
    references.some(
      (slice, index) => slice.partsPerPlate !== expectedOccupancies[index],
    )
  ) {
    return [];
  }
  const { slicingInputFingerprint } = await import("@taven/slicer-contracts");
  const inspectionRevisions = new Set([
    "inspection-v1",
    ...expectedOccupancies.map((occupancy) =>
      slicingInputFingerprint("reference_slice", {
        geometry: {
          sourceModelFileId: item.sourceModelFileId,
          sourceContentSha256: item.sourceModelFile.contentHash,
          modelGeometryId: item.modelGeometryId,
          canonicalObjectKey: item.modelGeometry.canonicalObjectKey,
          geometrySha256: item.modelGeometry.geometryHash,
          bodyIds: snapshot.bodyIds,
          selectionSha256: snapshot.selectionSha256,
        },
        referenceProfile: {
          revisionId: snapshot.referenceProfileId,
          contentSha256: slicerSettingsSnapshot(
            snapshot.referenceProfile.settings,
          ).contentSha256,
          slicerEngine: snapshot.referenceProfile.slicerEngine,
          slicerVersion: snapshot.referenceProfile.slicerVersion,
        },
        printConfig: {
          revisionId: snapshot.printConfigRevisionId,
          contentSha256: slicerSettingsSnapshot(
            snapshot.printConfigRevision.settings,
          ).contentSha256,
        },
        partsPerPlate: occupancy,
      }),
    ),
  ]);
  return scopedDecisions
    .filter((decision) =>
      inspectionRevisions.has(decision.preflightFinding.inspectionRevision),
    )
    .map((decision) => ({
      findingId: decision.preflightFindingId,
      code: decision.preflightFinding.code,
      severity: decision.preflightFinding.severity,
      message: decision.preflightFinding.message,
      acknowledgementKey: decision.acknowledgementKey,
    }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
}
