import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ClaimOrigin,
  ClaimSlotResolutionStatus,
  ClaimStatus,
  IdempotencyStatus,
  JobFailureStage,
  JobStatus,
  OrderPhaseStatus,
  OrderStatus,
  PriceAdjustmentReason,
  Prisma,
  RefundReason,
  ReplacementRequestReason,
  ReplacementRequestStatus,
  ShipmentProviderEventKind,
  ShipmentStatus,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  CancelOrderDto,
  CreateClaimDto,
  CreatePriceAdjustmentDto,
  CreateReplacementDto,
  CreateShipmentDto,
  FulfilmentCommandResultDto,
  FulfilmentProjectionDto,
  JobFailureDto,
  JobPrintedDto,
  JobQcSubmissionDto,
  PackJobDto,
  ShipmentEventDto,
  ShipmentLabelDto,
  ShipmentProviderEvidenceDto,
} from "./orders.dto";

type Transaction = Prisma.TransactionClient;
type CommandOperation = (
  transaction: Transaction,
) => Promise<FulfilmentCommandResultDto>;

const IDEMPOTENCY_DAYS = 30;
// The v0 guard authenticates one deployment-wide operator credential and does
// not expose a person identity yet. Keep its audit identity explicit and
// stable until issue #24 replaces the shared credential with operator sessions.
const V0_OPERATOR_ACTOR_ID = "00000000-0000-4000-8000-000000000022";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_SHIPMENT_STATUSES = [
  ShipmentStatus.PLANNED,
  ShipmentStatus.LABEL_CREATED,
  ShipmentStatus.CANCELLATION_PENDING,
  ShipmentStatus.HANDED_OVER,
  ShipmentStatus.IN_TRANSIT,
] as const;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async getFulfilment(orderId: string): Promise<FulfilmentProjectionDto> {
    assertUuid(orderId, "orderId");
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        phases: true,
        jobs: {
          include: {
            shipmentAssignment: true,
            replacementRequestSource: true,
          },
          orderBy: { createdAt: "asc" },
        },
        shipments: {
          include: { jobAssignments: true },
          orderBy: { createdAt: "asc" },
        },
        fulfilmentSlots: { orderBy: { createdAt: "asc" } },
        replacementRequests: { orderBy: { createdAt: "asc" } },
        claims: {
          include: { resolutions: true, refunds: true },
          orderBy: { createdAt: "asc" },
        },
        priceAdjustments: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!order) throw new NotFoundException("Order was not found");
    const phase = order.phases[0];
    if (!phase) throw new ConflictException("Order has no fulfilment phase");
    return jsonSafe({
      orderId: order.id,
      orderStatus: order.status,
      phase,
      jobs: order.jobs,
      shipments: order.shipments,
      slots: order.fulfilmentSlots,
      replacementRequests: order.replacementRequests,
      claims: order.claims,
      priceAdjustments: order.priceAdjustments,
    }) as FulfilmentProjectionDto;
  }

  acceptJob(
    orderId: string,
    jobId: string,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.command(orderId, `job:${jobId}:accept`, key, {}, async (tx) => {
      const job = await this.lockJob(tx, orderId, jobId);
      if (job.status !== JobStatus.CREATED) {
        throw new ConflictException("Job is not awaiting acceptance");
      }
      const currencyRows = await tx.$queryRaw<Array<{ currency: string }>>`
        SELECT snapshot.currency
        FROM orders target_order
        JOIN order_active_price_bindings active_binding
          ON active_binding.order_id = target_order.id
        JOIN order_price_bindings binding
          ON binding.id = active_binding.order_price_binding_id
         AND binding.order_id = target_order.id
        JOIN price_snapshots snapshot ON snapshot.id = binding.price_snapshot_id
        WHERE target_order.id = ${orderId}::uuid
      `;
      const currency = currencyRows[0]?.currency;
      if (!currency) {
        throw new ConflictException("Order has no active price currency");
      }
      const acceptedAt = await databaseNow(tx);
      const accepted = await tx.job.update({
        where: { id: jobId },
        data: {
          status: JobStatus.ACCEPTED,
          acceptedAt,
          // v0 work is platform-owned. The tuple is still frozen so future
          // maker routing cannot reinterpret historical economics.
          payoutAmount: 0n,
          payoutCurrency: currency,
        },
        select: { id: true, payoutAmount: true, payoutCurrency: true },
      });
      return result(orderId, "JOB_ACCEPTED", accepted);
    });
  }

  startPrinting(
    orderId: string,
    jobId: string,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.command(
      orderId,
      `job:${jobId}:printing`,
      key,
      {},
      async (tx) => {
        const job = await this.lockJob(tx, orderId, jobId);
        if (job.status !== JobStatus.GCODE_READY) {
          throw new ConflictException("Job is not G-code ready");
        }
        const reservation = await tx.productionReservation.findFirst({
          where: { jobId, status: "HELD" },
          select: { id: true },
        });
        if (!reservation) {
          throw new ConflictException("Job has no held production reservation");
        }
        const at = await databaseNow(tx);
        await tx.inventoryReservation.updateMany({
          where: { productionReservationId: reservation.id, status: "HELD" },
          data: { status: "ALLOCATED", updatedAt: at },
        });
        await tx.capacityReservation.updateMany({
          where: { productionReservationId: reservation.id, status: "HELD" },
          data: { status: "SCHEDULED", updatedAt: at },
        });
        await tx.productionReservation.update({
          where: { id: reservation.id },
          data: { status: "SCHEDULED", updatedAt: at },
        });
        await tx.capacityReservation.updateMany({
          where: {
            productionReservationId: reservation.id,
            status: "SCHEDULED",
          },
          data: { status: "PRINTING", updatedAt: at },
        });
        await tx.productionReservation.update({
          where: { id: reservation.id },
          data: { status: "PRINTING", updatedAt: at },
        });
        await tx.job.update({
          where: { id: jobId },
          data: { status: JobStatus.PRINTING, printingAt: at },
        });
        await tx.orderPhase.updateMany({
          where: { id: job.orderPhaseId, status: OrderPhaseStatus.ACTIVE },
          data: { status: OrderPhaseStatus.IN_PRODUCTION, updatedAt: at },
        });
        await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.CONFIRMED },
          data: { status: OrderStatus.IN_PRODUCTION, updatedAt: at },
        });
        return result(orderId, "JOB_PRINTING", { jobId, printingAt: at });
      },
    );
  }

  finishPrinting(
    orderId: string,
    jobId: string,
    body: JobPrintedDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const actualMaterialMilligrams = positiveBigInt(
      body.actualMaterialMilligrams,
      "actualMaterialMilligrams",
      true,
    );
    return this.command(
      orderId,
      `job:${jobId}:printed`,
      key,
      { actualMaterialMilligrams: actualMaterialMilligrams.toString() },
      async (tx) => {
        const job = await this.lockJob(tx, orderId, jobId);
        if (job.status !== JobStatus.PRINTING) {
          throw new ConflictException("Job is not printing");
        }
        const production = await tx.productionReservation.findFirst({
          where: { jobId, status: "PRINTING" },
          select: { id: true },
        });
        if (!production) {
          throw new ConflictException("Printing reservation is unavailable");
        }
        await tx.$queryRaw`
          SELECT taven_settle_printing_production_reservation(
            ${production.id}::uuid, ${actualMaterialMilligrams}
          )::text
        `;
        const printedAt = await databaseNow(tx);
        await tx.job.update({
          where: { id: jobId },
          data: { status: JobStatus.PRINTED, printedAt },
        });
        return result(orderId, "JOB_PRINTED", { jobId, printedAt });
      },
    );
  }

  submitQc(
    orderId: string,
    jobId: string,
    body: JobQcSubmissionDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const photoAssetId = body.photoAssetId?.trim() || undefined;
    const omissionReason = optionalText(
      body.omissionReason,
      "omissionReason",
      500,
    );
    if ((photoAssetId ? 1 : 0) + (omissionReason ? 1 : 0) !== 1) {
      throw new BadRequestException(
        "Provide exactly one of photoAssetId or omissionReason",
      );
    }
    if (photoAssetId) assertUuid(photoAssetId, "photoAssetId");
    return this.command(
      orderId,
      `job:${jobId}:qc-submission`,
      key,
      {
        photoAssetId: photoAssetId ?? null,
        omissionReason: omissionReason ?? null,
      },
      async (tx) => {
        const job = await this.lockJob(tx, orderId, jobId);
        if (job.status !== JobStatus.PRINTED) {
          throw new ConflictException("Job is not ready for QC evidence");
        }
        const photoSubmittedAt = await databaseNow(tx);
        await tx.job.update({
          where: { id: jobId },
          data: {
            status: JobStatus.PHOTO_SUBMITTED,
            photoSubmittedAt,
            qcPhotoAssetId: photoAssetId ?? null,
            qcEvidenceOmissionReason: omissionReason ?? null,
          },
        });
        return result(orderId, "JOB_QC_SUBMITTED", {
          jobId,
          photoSubmittedAt,
          evidence: photoAssetId ? "PHOTO" : "OMITTED",
        });
      },
    );
  }

  approveQc(
    orderId: string,
    jobId: string,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.command(
      orderId,
      `job:${jobId}:qc-approval`,
      key,
      {},
      async (tx) => {
        const job = await this.lockJob(tx, orderId, jobId);
        if (job.status !== JobStatus.PHOTO_SUBMITTED) {
          throw new ConflictException("Job has no submitted QC evidence");
        }
        const qcApprovedAt = await databaseNow(tx);
        const phase = await tx.orderPhase.findUniqueOrThrow({
          where: { id: job.orderPhaseId },
          select: { qcPassedAt: true },
        });
        await tx.job.update({
          where: { id: jobId },
          data: { status: JobStatus.QC_APPROVED, qcApprovedAt },
        });
        const blockers = await tx.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM jobs job
          WHERE job.order_id = ${orderId}::uuid
            AND taven_job_is_current(job.id)
            AND job.status NOT IN ('QC_APPROVED', 'PACKED')
        ) AS blocked
      `;
        if (!blockers[0]?.blocked) {
          await tx.orderPhase.updateMany({
            where: {
              id: job.orderPhaseId,
              status: {
                in: [
                  OrderPhaseStatus.IN_PRODUCTION,
                  OrderPhaseStatus.RECOVERY_PENDING,
                ],
              },
            },
            data: {
              status: OrderPhaseStatus.QC_PASSED,
              ...(phase.qcPassedAt ? {} : { qcPassedAt: qcApprovedAt }),
            },
          });
          await tx.order.updateMany({
            where: {
              id: orderId,
              status: {
                in: [OrderStatus.IN_PRODUCTION, OrderStatus.RECOVERY_PENDING],
              },
            },
            data: { status: OrderStatus.QC_PASSED, updatedAt: qcApprovedAt },
          });
        }
        return result(orderId, "JOB_QC_APPROVED", { jobId, qcApprovedAt });
      },
    );
  }

  failJob(
    orderId: string,
    jobId: string,
    body: JobFailureDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const stage = enumValue(JobFailureStage, body.stage, "stage");
    const reason = requiredText(body.reason, "reason", 2_000);
    if (body.recovery !== "REPLACE" && body.recovery !== "REFUND") {
      throw new BadRequestException("recovery is invalid");
    }
    const actual = body.actualMaterialMilligrams
      ? positiveBigInt(
          body.actualMaterialMilligrams,
          "actualMaterialMilligrams",
          true,
        )
      : undefined;
    return this.command(
      orderId,
      `job:${jobId}:failure`,
      key,
      {
        stage,
        reason,
        recovery: body.recovery,
        actualMaterialMilligrams: actual?.toString() ?? null,
      },
      async (tx) => {
        const job = await this.lockJob(tx, orderId, jobId);
        if (
          [
            JobStatus.HANDED_OVER,
            JobStatus.SETTLED,
            JobStatus.CANCELLED,
            JobStatus.FAILED,
            JobStatus.QC_REJECTED,
          ].includes(
            job.status as
              | typeof JobStatus.HANDED_OVER
              | typeof JobStatus.SETTLED
              | typeof JobStatus.CANCELLED
              | typeof JobStatus.FAILED
              | typeof JobStatus.QC_REJECTED,
          )
        ) {
          throw new ConflictException("Job cannot enter failure recovery");
        }
        const production = await tx.productionReservation.findFirst({
          where: { jobId },
          select: { id: true, status: true },
        });
        if (production?.status === "PRINTING") {
          if (actual === undefined) {
            throw new BadRequestException(
              "actualMaterialMilligrams is required after printing starts",
            );
          }
          await tx.$queryRaw`
            SELECT taven_settle_printing_production_reservation(
              ${production.id}::uuid, ${actual}
            )::text
          `;
        } else if (
          production &&
          ["RESERVED", "HELD", "SCHEDULED"].includes(production.status)
        ) {
          await tx.$queryRaw`
            SELECT taven_release_production_reservation_before_print(
              ${production.id}::uuid
            )::text
          `;
        }
        const failedAt = await databaseNow(tx);
        const terminalStatus =
          job.status === JobStatus.PHOTO_SUBMITTED
            ? JobStatus.QC_REJECTED
            : JobStatus.FAILED;
        await tx.job.update({
          where: { id: jobId },
          data:
            terminalStatus === JobStatus.QC_REJECTED
              ? {
                  status: terminalStatus,
                  qcRejectedAt: failedAt,
                }
              : {
                  status: terminalStatus,
                  failedAt,
                  failureStage: stage,
                  failureReason: reason,
                },
        });
        const request = await tx.replacementRequest.create({
          data: {
            orderId,
            orderPhaseId: job.orderPhaseId,
            shipmentPlanId: job.shipmentPlanId,
            sourceJobId: jobId,
            reason:
              terminalStatus === JobStatus.QC_REJECTED
                ? ReplacementRequestReason.QC_REJECTED
                : ReplacementRequestReason.JOB_FAILED,
            status:
              body.recovery === "REPLACE"
                ? ReplacementRequestStatus.OPEN
                : ReplacementRequestStatus.REFUND_REQUIRED,
            deadlineAt: addDays(failedAt, 2),
          },
        });
        if (
          [
            JobStatus.PRINTING,
            JobStatus.PRINTED,
            JobStatus.PHOTO_SUBMITTED,
            JobStatus.QC_APPROVED,
            JobStatus.PACKED,
          ].includes(
            job.status as
              | typeof JobStatus.PRINTING
              | typeof JobStatus.PRINTED
              | typeof JobStatus.PHOTO_SUBMITTED
              | typeof JobStatus.QC_APPROVED
              | typeof JobStatus.PACKED,
          )
        ) {
          await tx.orderPhase.updateMany({
            where: {
              id: job.orderPhaseId,
              status: {
                in: [
                  OrderPhaseStatus.IN_PRODUCTION,
                  OrderPhaseStatus.QC_PASSED,
                ],
              },
            },
            data: { status: OrderPhaseStatus.RECOVERY_PENDING },
          });
          await tx.order.updateMany({
            where: {
              id: orderId,
              status: {
                in: [
                  OrderStatus.IN_PRODUCTION,
                  OrderStatus.QC_PASSED,
                  OrderStatus.READY_TO_SHIP,
                ],
              },
            },
            data: { status: OrderStatus.RECOVERY_PENDING },
          });
        }
        return result(orderId, terminalStatus, {
          jobId,
          replacementRequestId: request.id,
          recovery: body.recovery,
        });
      },
    );
  }

  createReplacement(
    orderId: string,
    sourceJobId: string,
    body: CreateReplacementDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(body.candidateResourceEstimateId, "candidateResourceEstimateId");
    const requestedPlanKey = optionalText(body.planKey, "planKey", 255);
    return this.command(
      orderId,
      `job:${sourceJobId}:replacement`,
      key,
      {
        candidateResourceEstimateId: body.candidateResourceEstimateId,
        planKey: requestedPlanKey ?? null,
      },
      async (tx) => {
        const source = await this.lockJob(tx, orderId, sourceJobId);
        if (
          source.status !== JobStatus.FAILED &&
          source.status !== JobStatus.QC_REJECTED
        ) {
          throw new ConflictException("Replacement source is not terminal");
        }
        const request = await tx.replacementRequest.findUnique({
          where: { sourceJobId },
        });
        if (!request || request.status !== ReplacementRequestStatus.OPEN) {
          throw new ConflictException("Replacement request is not open");
        }
        const sourcePlanJob = await tx.phaseResourcePlanJob.findUnique({
          where: { id: source.phaseResourcePlanJobId },
          include: {
            candidateResourceEstimate: true,
            slots: { orderBy: { fulfilmentSlotId: "asc" } },
          },
        });
        if (!sourcePlanJob || sourcePlanJob.slots.length === 0) {
          throw new ConflictException("Replacement source plan is incomplete");
        }
        const now = await databaseNow(tx);
        const replacementCandidate =
          await tx.candidateResourceEstimate.findFirst({
            where: {
              id: {
                equals: body.candidateResourceEstimateId,
                not: sourcePlanJob.candidateResourceEstimateId,
              },
              nodeId: source.nodeId,
              shipmentPlanId: source.shipmentPlanId,
              modelGeometryId:
                sourcePlanJob.candidateResourceEstimate.modelGeometryId,
              printConfigRevisionId:
                sourcePlanJob.candidateResourceEstimate.printConfigRevisionId,
              quantity: sourcePlanJob.candidateResourceEstimate.quantity,
              calculatedAt: { gte: request.createdAt },
            },
            include: { capacityIntervals: true },
          });
        if (
          !replacementCandidate ||
          replacementCandidate.capacityIntervals.length === 0 ||
          replacementCandidate.capacityIntervals.some(
            (interval) =>
              interval.startsAt.getTime() <= now.getTime() ||
              interval.endsAt.getTime() >
                replacementCandidate.expiresAt.getTime(),
          )
        ) {
          throw new ConflictException(
            "Replacement requires a freshly calculated compatible candidate with future capacity",
          );
        }
        const expiresAt = new Date(
          Math.min(
            replacementCandidate.expiresAt.getTime(),
            now.getTime() + 30 * 60 * 1_000,
          ),
        );
        if (expiresAt.getTime() <= now.getTime() + 15 * 60 * 1_000) {
          throw new ConflictException(
            "Replacement candidate is stale; refresh resource estimates",
          );
        }
        const commandDigest = createHash("sha256")
          .update(`${sourceJobId}\0${requestedPlanKey ?? key ?? "replacement"}`)
          .digest("hex");
        const planKey =
          requestedPlanKey ?? `replacement-plan:${commandDigest.slice(0, 220)}`;
        const slotIds = sourcePlanJob.slots.map(
          ({ fulfilmentSlotId }) => fulfilmentSlotId,
        );
        const snapshot = await tx.eligibilitySnapshot.create({
          data: {
            nodeId: source.nodeId,
            orderPhaseId: source.orderPhaseId,
            requiredFulfilmentSlotIds: slotIds,
            eligibleCandidateEstimateIds: [replacementCandidate.id],
            snapshotHash: createHash("sha256")
              .update(`replacement-snapshot\0${commandDigest}`)
              .digest("hex"),
            calculatedAt: now,
            expiresAt,
          },
        });
        const plan = await tx.phaseResourcePlan.create({
          data: {
            nodeId: source.nodeId,
            orderPhaseId: source.orderPhaseId,
            eligibilitySnapshotId: snapshot.id,
            planKey,
            expiresAt,
          },
        });
        const planJob = await tx.phaseResourcePlanJob.create({
          data: {
            nodeId: source.nodeId,
            phaseResourcePlanId: plan.id,
            candidateResourceEstimateId: replacementCandidate.id,
            plannedJobKey: `replacement:${commandDigest}`,
          },
        });
        await tx.phaseResourcePlanSlot.createMany({
          data: slotIds.map((fulfilmentSlotId) => ({
            nodeId: source.nodeId,
            phaseResourcePlanId: plan.id,
            phaseResourcePlanJobId: planJob.id,
            fulfilmentSlotId,
          })),
        });
        const reservationKey = `replacement-reservation:${commandDigest}`;
        const reservationRows = await tx.$queryRaw<
          Array<{ phase_reservation_set_id: string }>
        >`
          SELECT phase_reservation_set_id
          FROM taven_create_phase_reservation(
            ${source.nodeId}::uuid, ${plan.id}::uuid, ${reservationKey}
          )
        `;
        const reservationSetId = reservationRows[0]?.phase_reservation_set_id;
        if (!reservationSetId) {
          throw new ConflictException(
            "Replacement reservation was not created",
          );
        }
        const replacementJob = await tx.job.create({
          data: {
            nodeId: source.nodeId,
            orderId,
            orderPhaseId: source.orderPhaseId,
            shipmentPlanId: source.shipmentPlanId,
            phaseResourcePlanJobId: planJob.id,
            replacesJobId: sourceJobId,
          },
        });
        await tx.inventoryReservation.updateMany({
          where: {
            productionReservation: { phaseReservationSetId: reservationSetId },
            status: "RESERVED",
          },
          data: { status: "HELD", updatedAt: now },
        });
        await tx.capacityReservation.updateMany({
          where: {
            productionReservation: { phaseReservationSetId: reservationSetId },
            status: "RESERVED",
          },
          data: { status: "HELD", updatedAt: now },
        });
        await tx.productionReservation.updateMany({
          where: { phaseReservationSetId: reservationSetId },
          data: {
            status: "HELD",
            jobId: replacementJob.id,
            updatedAt: now,
          },
        });
        await tx.phaseReservationSet.update({
          where: { id: reservationSetId },
          data: { status: "HELD", updatedAt: now },
        });
        await tx.replacementRequest.update({
          where: { id: request.id },
          data: {
            status: ReplacementRequestStatus.JOB_CREATED,
            replacementJobId: replacementJob.id,
            phaseReservationSetId: reservationSetId,
          },
        });
        return result(orderId, "REPLACEMENT_CREATED", {
          replacementRequestId: request.id,
          sourceJobId,
          replacementJobId: replacementJob.id,
          phaseReservationSetId: reservationSetId,
        });
      },
    );
  }

  packJob(
    orderId: string,
    jobId: string,
    body: PackJobDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(body.shipmentId, "shipmentId");
    return this.command(
      orderId,
      `job:${jobId}:packing`,
      key,
      { shipmentId: body.shipmentId },
      async (tx) => {
        const job = await this.lockJob(tx, orderId, jobId);
        if (job.status !== JobStatus.QC_APPROVED) {
          throw new ConflictException("Job is not QC approved");
        }
        const shipment = await tx.shipment.findFirst({
          where: {
            id: body.shipmentId,
            orderId,
            shipmentPlanId: job.shipmentPlanId,
            status: {
              in: [ShipmentStatus.PLANNED, ShipmentStatus.LABEL_CREATED],
            },
          },
        });
        if (!shipment) {
          throw new ConflictException(
            "Shipment does not match the Job parcel plan",
          );
        }
        const packedAt = await databaseNow(tx);
        await tx.jobShipmentAssignment.create({
          data: {
            jobId,
            shipmentId: shipment.id,
            shipmentPlanId: job.shipmentPlanId,
            orderId,
            orderPhaseId: job.orderPhaseId,
            assignedAt: packedAt,
          },
        });
        await tx.job.update({
          where: { id: jobId },
          data: { status: JobStatus.PACKED, packedAt },
        });
        const readiness = await tx.$queryRaw<Array<{ ready: boolean }>>`
          SELECT NOT EXISTS (
            SELECT 1 FROM jobs current_job
            WHERE current_job.order_id = ${orderId}::uuid
              AND taven_job_is_current(current_job.id)
              AND current_job.status <> 'PACKED'
          ) AND NOT EXISTS (
            SELECT 1 FROM shipments shipment
            WHERE shipment.order_id = ${orderId}::uuid
              AND NOT EXISTS (
                SELECT 1 FROM shipments successor
                WHERE successor.replaces_shipment_id = shipment.id
              )
              AND shipment.status <> 'LABEL_CREATED'
          ) AS ready
        `;
        if (readiness[0]?.ready) {
          await tx.order.updateMany({
            where: { id: orderId, status: OrderStatus.QC_PASSED },
            data: { status: OrderStatus.READY_TO_SHIP, updatedAt: packedAt },
          });
        }
        return result(orderId, "JOB_PACKED", {
          jobId,
          shipmentId: shipment.id,
          packedAt,
        });
      },
    );
  }

  createShipment(
    orderId: string,
    body: CreateShipmentDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(body.shipmentPlanId, "shipmentPlanId");
    if (body.replacesShipmentId) {
      assertUuid(body.replacesShipmentId, "replacesShipmentId");
    }
    return this.command(
      orderId,
      `shipment-plan:${body.shipmentPlanId}:create`,
      key,
      body,
      async (tx) => {
        const plan = await tx.shipmentPlan.findFirst({
          where: { id: body.shipmentPlanId, orderId },
        });
        if (!plan) throw new NotFoundException("Shipment plan was not found");
        if (body.replacesShipmentId) {
          const predecessor = await tx.shipment.findFirst({
            where: {
              id: body.replacesShipmentId,
              orderId,
              shipmentPlanId: plan.id,
              replacementShipment: null,
              status: {
                in: [
                  ShipmentStatus.LOST,
                  ShipmentStatus.RETURNED,
                  ShipmentStatus.CANCELLED,
                ],
              },
            },
          });
          if (!predecessor) {
            throw new ConflictException("Shipment is not replaceable");
          }
        } else {
          const live = await tx.shipment.count({
            where: {
              orderId,
              shipmentPlanId: plan.id,
              replacementShipment: null,
              status: { in: [...ACTIVE_SHIPMENT_STATUSES] },
            },
          });
          if (live > 0) {
            throw new ConflictException(
              "Shipment plan already has a live parcel",
            );
          }
        }
        const shipment = await tx.shipment.create({
          data: {
            orderId,
            orderPhaseId: plan.orderPhaseId,
            shipmentPlanId: plan.id,
            deliveryDestinationId: plan.deliveryDestinationId,
            replacesShipmentId: body.replacesShipmentId ?? null,
          },
        });
        return result(orderId, "SHIPMENT_CREATED", {
          shipmentId: shipment.id,
          shipmentPlanId: plan.id,
          replacesShipmentId: body.replacesShipmentId ?? null,
        });
      },
    );
  }

  labelShipment(
    orderId: string,
    shipmentId: string,
    body: ShipmentLabelDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const input = {
      carrier: requiredText(body.carrier, "carrier", 100),
      providerShipmentId: requiredText(
        body.providerShipmentId,
        "providerShipmentId",
        255,
      ),
      carrierLabelId: requiredText(body.carrierLabelId, "carrierLabelId", 190),
      trackingCode: optionalText(body.trackingCode, "trackingCode", 255),
    };
    return this.command(
      orderId,
      `shipment:${shipmentId}:label`,
      key,
      input,
      async (tx) => {
        const shipment = await this.lockShipment(tx, orderId, shipmentId);
        if (shipment.status !== ShipmentStatus.PLANNED) {
          throw new ConflictException("Shipment is not awaiting a label");
        }
        const labelCreatedAt = await databaseNow(tx);
        await tx.shipment.update({
          where: { id: shipmentId },
          data: {
            status: ShipmentStatus.LABEL_CREATED,
            carrier: input.carrier,
            providerShipmentId: input.providerShipmentId,
            carrierLabelId: input.carrierLabelId,
            trackingCode: input.trackingCode ?? null,
            labelCreatedAt,
          },
        });
        const readiness = await tx.$queryRaw<Array<{ ready: boolean }>>`
          SELECT NOT EXISTS (
            SELECT 1 FROM jobs current_job
            WHERE current_job.order_id = ${orderId}::uuid
              AND taven_job_is_current(current_job.id)
              AND current_job.status <> 'PACKED'
          ) AND NOT EXISTS (
            SELECT 1 FROM shipments leaf
            WHERE leaf.order_id = ${orderId}::uuid
              AND NOT EXISTS (
                SELECT 1 FROM shipments successor
                WHERE successor.replaces_shipment_id = leaf.id
              )
              AND leaf.status <> 'LABEL_CREATED'
          ) AS ready
        `;
        if (readiness[0]?.ready) {
          await tx.order.updateMany({
            where: { id: orderId, status: OrderStatus.QC_PASSED },
            data: {
              status: OrderStatus.READY_TO_SHIP,
              updatedAt: labelCreatedAt,
            },
          });
        }
        return result(orderId, "SHIPMENT_LABELLED", {
          shipmentId,
          labelCreatedAt,
        });
      },
    );
  }

  confirmLabelVoid(
    orderId: string,
    shipmentId: string,
    body: ShipmentProviderEvidenceDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const evidence = providerEvidence(body);
    return this.command(
      orderId,
      `shipment:${shipmentId}:label-void`,
      key,
      evidence,
      async (tx) => {
        const shipment = await this.lockShipment(tx, orderId, shipmentId);
        if (!shipment.carrier || !shipment.carrierLabelId) {
          throw new ConflictException("Shipment has no carrier label");
        }
        const existing = await tx.shipmentProviderEvent.findUnique({
          where: {
            carrier_providerEventId: {
              carrier: shipment.carrier,
              providerEventId: evidence.providerEventId,
            },
          },
        });
        if (shipment.status === ShipmentStatus.CANCELLED && existing) {
          if (
            existing.shipmentId !== shipmentId ||
            existing.kind !== ShipmentProviderEventKind.LABEL_VOIDED ||
            existing.providerTransactionId !== evidence.providerTransactionId ||
            existing.occurredAt.getTime() !== evidence.occurredAt.getTime()
          ) {
            throw new ConflictException(
              "Provider event identity is already bound to different evidence",
            );
          }
          return result(orderId, "LABEL_VOID_ALREADY_APPLIED", {
            shipmentId,
            providerEventId: evidence.providerEventId,
          });
        }
        if (shipment.status !== ShipmentStatus.CANCELLATION_PENDING) {
          throw new ConflictException(
            "Shipment is not awaiting provider label cancellation",
          );
        }
        if (existing) {
          throw new ConflictException(
            "Provider event identity is already bound to different evidence",
          );
        }
        const outbox = await tx.outboxMessage.findUnique({
          where: {
            deduplicationKey: `void_carrier_label:${shipmentId}:${shipment.carrierLabelId}`,
          },
        });
        if (
          !outbox ||
          outbox.aggregateType !== "Shipment" ||
          outbox.aggregateId !== shipmentId ||
          outbox.messageType !== "void_carrier_label"
        ) {
          throw new ConflictException("Carrier label void command is missing");
        }
        const verifiedAt = await databaseNow(tx);
        await tx.outboxMessage.update({
          where: { id: outbox.id },
          data: {
            status: "DELIVERED",
            deliveredAt: verifiedAt,
            lockedAt: null,
            lastError: null,
            updatedAt: verifiedAt,
          },
        });
        await tx.shipmentProviderEvent.create({
          data: {
            shipmentId,
            outboxMessageId: outbox.id,
            carrier: shipment.carrier,
            carrierLabelId: shipment.carrierLabelId,
            providerEventId: evidence.providerEventId,
            providerTransactionId: evidence.providerTransactionId,
            kind: ShipmentProviderEventKind.LABEL_VOIDED,
            sourceShipmentStatus: ShipmentStatus.CANCELLATION_PENDING,
            occurredAt: evidence.occurredAt,
            authenticatedAt: verifiedAt,
            verifiedAt,
          },
        });
        await tx.shipment.update({
          where: { id: shipmentId },
          data: {
            status: ShipmentStatus.CANCELLED,
            providerVoidId: evidence.providerEventId,
            providerVoidedAt: verifiedAt,
            cancelledAt: verifiedAt,
          },
        });
        const remainingLiveLabels = await tx.shipment.count({
          where: {
            orderId,
            status: {
              in: [
                ShipmentStatus.LABEL_CREATED,
                ShipmentStatus.CANCELLATION_PENDING,
              ],
            },
          },
        });
        const refundIds =
          remainingLiveLabels === 0
            ? await this.finalizeCancellation(tx, orderId, verifiedAt, key!)
            : [];
        return result(
          orderId,
          remainingLiveLabels === 0
            ? "LABEL_VOID_CONFIRMED_AND_ORDER_CANCELLED"
            : "LABEL_VOID_CONFIRMED",
          {
            shipmentId,
            providerEventId: evidence.providerEventId,
            providerVoidedAt: verifiedAt,
            refundIds,
          },
        );
      },
    );
  }

  handoffShipment(
    orderId: string,
    shipmentId: string,
    body: ShipmentProviderEvidenceDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const evidence = providerEvidence(body);
    return this.command(
      orderId,
      `shipment:${shipmentId}:handoff`,
      key,
      evidence,
      async (tx) => {
        const shipment = await this.lockShipment(tx, orderId, shipmentId);
        if (!shipment.carrier || !shipment.carrierLabelId) {
          throw new ConflictException("Shipment has no carrier identity");
        }
        const existing = await tx.shipmentProviderEvent.findUnique({
          where: {
            carrier_providerEventId: {
              carrier: shipment.carrier,
              providerEventId: evidence.providerEventId,
            },
          },
        });
        if (existing) {
          if (
            existing.shipmentId === shipmentId &&
            existing.kind === ShipmentProviderEventKind.ACCEPTANCE_SCAN &&
            existing.providerTransactionId === evidence.providerTransactionId &&
            existing.occurredAt.getTime() === evidence.occurredAt.getTime() &&
            shipment.providerAcceptanceScanId === evidence.providerEventId &&
            shipment.handedOverAt?.getTime() === existing.verifiedAt.getTime()
          ) {
            return result(orderId, "SHIPMENT_HANDOFF_ALREADY_APPLIED", {
              shipmentId,
              handedOverAt: shipment.handedOverAt,
            });
          }
          throw new ConflictException(
            "Provider event identity is already bound to different evidence",
          );
        }
        if (
          shipment.status !== ShipmentStatus.LABEL_CREATED &&
          shipment.status !== ShipmentStatus.CANCELLATION_PENDING
        ) {
          throw new ConflictException("Shipment is not ready for handoff");
        }
        const readiness = await tx.$queryRaw<
          Array<{ packingReady: boolean; financialReady: boolean }>
        >`
          SELECT EXISTS (
            SELECT 1 FROM jobs job
            JOIN job_shipment_assignments assignment ON assignment.job_id = job.id
            WHERE assignment.shipment_id = ${shipmentId}::uuid
              AND taven_job_is_current(job.id)
          ) AND NOT EXISTS (
            SELECT 1 FROM jobs job
            WHERE job.order_id = ${orderId}::uuid
              AND job.shipment_plan_id = ${shipment.shipmentPlanId}::uuid
              AND taven_job_is_current(job.id)
              AND (
                job.status <> 'PACKED'
                OR NOT EXISTS (
                  SELECT 1 FROM job_shipment_assignments assignment
                  WHERE assignment.job_id = job.id
                    AND assignment.shipment_id = ${shipmentId}::uuid
                )
              )
          ) AS "packingReady",
          NOT EXISTS (
            SELECT 1
            FROM price_adjustments adjustment
            LEFT JOIN LATERAL (
              SELECT coalesce(sum(refund.amount_minor), 0) AS refunded
              FROM refund_transactions refund
              WHERE refund.price_adjustment_id = adjustment.id
                AND refund.status = 'SUCCEEDED'
            ) settled ON true
            WHERE adjustment.order_id = ${orderId}::uuid
              AND settled.refunded < adjustment.amount_minor
          ) AND NOT EXISTS (
            SELECT 1
            FROM refund_transactions refund
            JOIN payments payment ON payment.id = refund.payment_id
            WHERE payment.order_id = ${orderId}::uuid
              AND refund.status IN ('PENDING', 'SUSPENDED')
          ) AS "financialReady"
        `;
        if (
          !readiness[0]?.packingReady ||
          (!readiness[0]?.financialReady &&
            shipment.status !== ShipmentStatus.CANCELLATION_PENDING)
        ) {
          throw new ConflictException(
            "Shipment packing or financial handoff barriers are not satisfied",
          );
        }
        const verifiedAt = await databaseNow(tx);
        if (shipment.status === ShipmentStatus.CANCELLATION_PENDING) {
          const voidCommand = await tx.outboxMessage.findUnique({
            where: {
              deduplicationKey: `void_carrier_label:${shipmentId}:${shipment.carrierLabelId}`,
            },
          });
          if (
            !voidCommand ||
            voidCommand.aggregateType !== "Shipment" ||
            voidCommand.aggregateId !== shipmentId ||
            voidCommand.messageType !== "void_carrier_label" ||
            voidCommand.status === "DELIVERED"
          ) {
            throw new ConflictException(
              "Carrier label void command cannot be superseded",
            );
          }
          await tx.outboxMessage.update({
            where: { id: voidCommand.id },
            data: {
              status: "SUPERSEDED",
              lockedAt: null,
              lastError: `superseded by carrier acceptance scan ${evidence.providerEventId}`,
              updatedAt: verifiedAt,
            },
          });
        }
        await tx.shipmentProviderEvent.create({
          data: {
            shipmentId,
            carrier: shipment.carrier,
            carrierLabelId: shipment.carrierLabelId,
            providerEventId: evidence.providerEventId,
            providerTransactionId: evidence.providerTransactionId,
            kind: ShipmentProviderEventKind.ACCEPTANCE_SCAN,
            sourceShipmentStatus: shipment.status,
            occurredAt: evidence.occurredAt,
            authenticatedAt: verifiedAt,
            verifiedAt,
          },
        });
        await tx.job.updateMany({
          where: {
            status: JobStatus.PACKED,
            shipmentAssignment: { shipmentId },
          },
          data: { status: JobStatus.HANDED_OVER, handedOverAt: verifiedAt },
        });
        await tx.shipment.update({
          where: { id: shipmentId },
          data: {
            status: ShipmentStatus.HANDED_OVER,
            providerAcceptanceScanId: evidence.providerEventId,
            handedOverAt: verifiedAt,
          },
        });
        await tx.orderPhase.updateMany({
          where: {
            id: shipment.orderPhaseId,
            status: OrderPhaseStatus.QC_PASSED,
          },
          data: { status: OrderPhaseStatus.SHIPPED, shippedAt: verifiedAt },
        });
        await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.READY_TO_SHIP },
          data: { status: OrderStatus.SHIPPED, updatedAt: verifiedAt },
        });
        return result(orderId, "SHIPMENT_HANDED_OVER", {
          shipmentId,
          handedOverAt: verifiedAt,
        });
      },
    );
  }

  applyShipmentEvent(
    orderId: string,
    shipmentId: string,
    body: ShipmentEventDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const evidence = providerEvidence(body);
    const kind = enumValue(
      {
        TRANSIT_SCAN: ShipmentProviderEventKind.TRANSIT_SCAN,
        DELIVERY_SCAN: ShipmentProviderEventKind.DELIVERY_SCAN,
        LOST: ShipmentProviderEventKind.LOST,
        RETURNED: ShipmentProviderEventKind.RETURNED,
        RECOVERED: ShipmentProviderEventKind.RECOVERED,
      } as const,
      body.kind,
      "kind",
    );
    return this.command(
      orderId,
      `shipment:${shipmentId}:event:${evidence.providerEventId}`,
      key,
      { ...evidence, kind },
      async (tx) => {
        const shipment = await this.lockShipment(tx, orderId, shipmentId);
        if (!shipment.carrier || !shipment.carrierLabelId) {
          throw new ConflictException("Shipment has no carrier identity");
        }
        const existing = await tx.shipmentProviderEvent.findUnique({
          where: {
            carrier_providerEventId: {
              carrier: shipment.carrier,
              providerEventId: evidence.providerEventId,
            },
          },
        });
        if (existing) {
          if (
            existing.shipmentId !== shipmentId ||
            existing.kind !== kind ||
            existing.providerTransactionId !== evidence.providerTransactionId ||
            existing.occurredAt.getTime() !== evidence.occurredAt.getTime()
          ) {
            throw new ConflictException(
              "Provider event identity is already bound to different evidence",
            );
          }
          return result(orderId, "SHIPMENT_EVENT_ALREADY_APPLIED", {
            shipmentId,
            providerEventId: evidence.providerEventId,
            kind,
          });
        }
        assertShipmentEventTransition(shipment.status, kind);
        const verifiedAt = await databaseNow(tx);
        await tx.shipmentProviderEvent.create({
          data: {
            shipmentId,
            carrier: shipment.carrier,
            carrierLabelId: shipment.carrierLabelId,
            providerEventId: evidence.providerEventId,
            providerTransactionId: evidence.providerTransactionId,
            kind,
            sourceShipmentStatus: shipment.status,
            occurredAt: evidence.occurredAt,
            authenticatedAt: verifiedAt,
            verifiedAt,
          },
        });
        if (kind === ShipmentProviderEventKind.TRANSIT_SCAN) {
          await tx.shipment.update({
            where: { id: shipmentId },
            data: { status: ShipmentStatus.IN_TRANSIT },
          });
        } else if (kind === ShipmentProviderEventKind.DELIVERY_SCAN) {
          await tx.shipment.update({
            where: { id: shipmentId },
            data: { status: ShipmentStatus.DELIVERED, deliveredAt: verifiedAt },
          });
          await tx.fulfilmentSlot.updateMany({
            where: {
              outcome: "PENDING",
              shipmentPlanAllocations: {
                some: { shipmentPlanId: shipment.shipmentPlanId },
              },
            },
            data: { outcome: "DELIVERED", updatedAt: verifiedAt },
          });
          const unfinished = await tx.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM shipments leaf
              WHERE leaf.order_id = ${orderId}::uuid
                AND NOT EXISTS (
                  SELECT 1 FROM shipments replacement
                  WHERE replacement.replaces_shipment_id = leaf.id
                )
                AND leaf.status <> 'DELIVERED'
            ) OR EXISTS (
              SELECT 1 FROM fulfilment_slots slot
              WHERE slot.order_id = ${orderId}::uuid
                AND slot.outcome <> 'DELIVERED'
            ) AS blocked
          `;
          if (!unfinished[0]?.blocked) {
            await tx.orderPhase.updateMany({
              where: {
                id: shipment.orderPhaseId,
                status: OrderPhaseStatus.SHIPPED,
              },
              data: {
                status: OrderPhaseStatus.DELIVERED,
                deliveredAt: verifiedAt,
              },
            });
            await tx.order.updateMany({
              where: { id: orderId, status: OrderStatus.SHIPPED },
              data: { status: OrderStatus.DELIVERED, updatedAt: verifiedAt },
            });
          }
        } else {
          const nextStatus =
            kind === ShipmentProviderEventKind.LOST
              ? ShipmentStatus.LOST
              : kind === ShipmentProviderEventKind.RETURNED
                ? ShipmentStatus.RETURNED
                : ShipmentStatus.RECOVERED;
          await tx.shipment.update({
            where: { id: shipmentId },
            data: { status: nextStatus },
          });
          if (
            kind === ShipmentProviderEventKind.LOST ||
            kind === ShipmentProviderEventKind.RETURNED
          ) {
            const claim = await tx.claim.create({
              data: {
                orderId,
                orderPhaseId: shipment.orderPhaseId,
                incidentShipmentId: shipmentId,
                origin: "SHIPMENT_INCIDENT",
                status: ClaimStatus.OPEN,
                reason: `${kind.toLowerCase()} carrier event ${evidence.providerEventId}`,
                openedAt: verifiedAt,
              },
            });
            const slots = await tx.fulfilmentSlot.findMany({
              where: {
                shipmentPlanAllocations: {
                  some: { shipmentPlanId: shipment.shipmentPlanId },
                },
              },
              select: { id: true },
            });
            await tx.claimSlotResolution.createMany({
              data: slots.map(({ id }) => ({
                claimId: claim.id,
                fulfilmentSlotId: id,
                status: ClaimSlotResolutionStatus.PENDING,
              })),
            });
          }
        }
        return result(orderId, "SHIPMENT_EVENT_APPLIED", {
          shipmentId,
          providerEventId: evidence.providerEventId,
          kind,
        });
      },
    );
  }

  createClaim(
    orderId: string,
    body: CreateClaimDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const origin = enumValue(
      {
        SHIPMENT_INCIDENT: ClaimOrigin.SHIPMENT_INCIDENT,
        POST_DELIVERY_QUALITY: ClaimOrigin.POST_DELIVERY_QUALITY,
      } as const,
      body.origin,
      "origin",
    );
    const reason = requiredText(body.reason, "reason", 2_000);
    if (
      !Array.isArray(body.fulfilmentSlotIds) ||
      body.fulfilmentSlotIds.length === 0
    ) {
      throw new BadRequestException("fulfilmentSlotIds is invalid");
    }
    const slotIds = [...new Set(body.fulfilmentSlotIds)].sort();
    if (slotIds.length !== body.fulfilmentSlotIds.length) {
      throw new BadRequestException("fulfilmentSlotIds contains duplicates");
    }
    for (const slotId of slotIds) assertUuid(slotId, "fulfilmentSlotId");
    if (body.incidentShipmentId) {
      assertUuid(body.incidentShipmentId, "incidentShipmentId");
    }
    if (origin === ClaimOrigin.SHIPMENT_INCIDENT && !body.incidentShipmentId) {
      throw new BadRequestException(
        "incidentShipmentId is required for a shipment incident",
      );
    }
    return this.command(
      orderId,
      "claim:create",
      key,
      {
        origin,
        reason,
        fulfilmentSlotIds: slotIds,
        incidentShipmentId: body.incidentShipmentId ?? null,
      },
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        await tx.$queryRaw`
          SELECT id FROM fulfilment_slots
          WHERE order_id = ${orderId}::uuid
          ORDER BY id
          FOR UPDATE
        `;
        const phase = await tx.orderPhase.findUnique({ where: { orderId } });
        if (!phase)
          throw new ConflictException("Order has no fulfilment phase");
        const slots = await tx.fulfilmentSlot.findMany({
          where: { orderId, orderPhaseId: phase.id, id: { in: slotIds } },
          include: { shipmentPlanAllocations: true },
          orderBy: { id: "asc" },
        });
        if (slots.length !== slotIds.length) {
          throw new NotFoundException("Claim fulfilment slot was not found");
        }
        if (origin === ClaimOrigin.POST_DELIVERY_QUALITY) {
          if (
            ![
              OrderStatus.DELIVERED,
              OrderStatus.COMPLETED,
              OrderStatus.PARTIALLY_FULFILLED,
            ].includes(
              order.status as
                | typeof OrderStatus.DELIVERED
                | typeof OrderStatus.COMPLETED
                | typeof OrderStatus.PARTIALLY_FULFILLED,
            ) ||
            slots.some(({ outcome }) => outcome !== "DELIVERED")
          ) {
            throw new ConflictException(
              "Post-delivery Claims require delivered fulfilment slots",
            );
          }
        }
        if (body.incidentShipmentId) {
          const shipment = await tx.shipment.findFirst({
            where: {
              id: body.incidentShipmentId,
              orderId,
              orderPhaseId: phase.id,
            },
          });
          if (!shipment) {
            throw new NotFoundException("Incident Shipment was not found");
          }
          if (
            origin === ClaimOrigin.SHIPMENT_INCIDENT &&
            ![
              ShipmentStatus.LOST,
              ShipmentStatus.RETURNED,
              ShipmentStatus.DELIVERED,
            ].includes(
              shipment.status as
                | typeof ShipmentStatus.LOST
                | typeof ShipmentStatus.RETURNED
                | typeof ShipmentStatus.DELIVERED,
            )
          ) {
            throw new ConflictException(
              "Shipment incident Claim requires terminal carrier evidence",
            );
          }
          if (
            slots.some(
              ({ shipmentPlanAllocations }) =>
                !shipmentPlanAllocations.some(
                  ({ shipmentPlanId }) =>
                    shipmentPlanId === shipment.shipmentPlanId,
                ),
            )
          ) {
            throw new ConflictException(
              "Claim slot does not belong to the incident Shipment",
            );
          }
        }
        const overlapping = await tx.claimSlotResolution.count({
          where: {
            fulfilmentSlotId: { in: slotIds },
            status: {
              in: [
                ClaimSlotResolutionStatus.PENDING,
                ClaimSlotResolutionStatus.REPLACEMENT_PENDING,
                ClaimSlotResolutionStatus.RESHIP_PENDING,
                ClaimSlotResolutionStatus.REFUND_PENDING,
              ],
            },
          },
        });
        if (overlapping > 0) {
          throw new ConflictException(
            "A fulfilment slot already has an active Claim remedy",
          );
        }
        const openedAt = await databaseNow(tx);
        const claim = await tx.claim.create({
          data: {
            orderId,
            orderPhaseId: phase.id,
            incidentShipmentId: body.incidentShipmentId ?? null,
            origin,
            reason,
            openedAt,
          },
        });
        await tx.claimSlotResolution.createMany({
          data: slotIds.map((fulfilmentSlotId) => ({
            claimId: claim.id,
            fulfilmentSlotId,
          })),
        });
        return result(orderId, "CLAIM_OPENED", {
          claimId: claim.id,
          origin,
          fulfilmentSlotIds: slotIds,
        });
      },
    );
  }

  createPriceAdjustment(
    orderId: string,
    body: CreatePriceAdjustmentDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const amountMinor = positiveBigInt(body.amountMinor, "amountMinor");
    const reason = enumValue(
      {
        EXPRESS_BREACH: PriceAdjustmentReason.EXPRESS_BREACH,
        PRODUCTION_FAILURE: PriceAdjustmentReason.PRODUCTION_FAILURE,
        SHIPMENT_INCIDENT: PriceAdjustmentReason.SHIPMENT_INCIDENT,
        POST_DELIVERY_ISSUE: PriceAdjustmentReason.POST_DELIVERY_ISSUE,
      } as const,
      requiredText(body.reason, "reason", 100),
      "reason",
    );
    if (body.paymentId) assertUuid(body.paymentId, "paymentId");
    if (body.claimId) assertUuid(body.claimId, "claimId");
    if (!body.allocation || typeof body.allocation !== "object") {
      throw new BadRequestException("allocation is invalid");
    }
    const slotCredits = priceAdjustmentSlotCredits(
      body.allocation,
      reason !== PriceAdjustmentReason.EXPRESS_BREACH,
    );
    const allocatedAmount = slotCredits.reduce(
      (total, credit) => total + credit.amountMinor,
      0n,
    );
    if (slotCredits.length > 0 && allocatedAmount !== amountMinor) {
      throw new BadRequestException(
        "allocation slotCredits must sum to amountMinor",
      );
    }
    const allocation = {
      ...body.allocation,
      ...(slotCredits.length > 0
        ? {
            slotCredits: slotCredits.map((credit) => ({
              fulfilmentSlotId: credit.fulfilmentSlotId,
              amountMinor: credit.amountMinor.toString(),
            })),
          }
        : {}),
    };
    return this.command(
      orderId,
      "price-adjustment:create",
      key,
      {
        reason,
        amountMinor: amountMinor.toString(),
        paymentId: body.paymentId ?? null,
        claimId: body.claimId ?? null,
        allocation,
      },
      async (tx) => {
        await this.lockOrder(tx, orderId);
        if (slotCredits.length > 0) {
          const ownedSlotCount = await tx.fulfilmentSlot.count({
            where: {
              orderId,
              id: {
                in: slotCredits.map(({ fulfilmentSlotId }) => fulfilmentSlotId),
              },
            },
          });
          if (ownedSlotCount !== slotCredits.length) {
            throw new NotFoundException(
              "Price adjustment fulfilment slot was not found",
            );
          }
        }
        let selectedPaymentAvailable: bigint | undefined;
        if (body.paymentId) {
          const selectedPayment = await tx.payment.findFirst({
            where: {
              id: body.paymentId,
              orderId,
              capturedAmountMinor: { not: null },
            },
            include: {
              refunds: {
                where: {
                  status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] },
                },
                select: { amountMinor: true },
              },
              priceAdjustments: {
                include: {
                  refunds: {
                    where: {
                      status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] },
                    },
                    select: { amountMinor: true },
                  },
                },
              },
            },
          });
          if (!selectedPayment) {
            throw new NotFoundException("Captured Payment was not found");
          }
          const refunded = selectedPayment.refunds.reduce(
            (total, refund) => total + refund.amountMinor,
            0n,
          );
          const reserved = selectedPayment.priceAdjustments.reduce(
            (total, adjustment) => {
              const committed = adjustment.refunds.reduce(
                (sum, refund) => sum + refund.amountMinor,
                0n,
              );
              const outstanding = adjustment.amountMinor - committed;
              return total + (outstanding > 0n ? outstanding : 0n);
            },
            0n,
          );
          selectedPaymentAvailable =
            selectedPayment.capturedAmountMinor! - refunded - reserved;
        }
        const currencyRows = await tx.$queryRaw<Array<{ currency: string }>>`
          SELECT snapshot.currency
          FROM order_active_price_bindings active_binding
          JOIN order_price_bindings binding
            ON binding.id = active_binding.order_price_binding_id
          JOIN price_snapshots snapshot ON snapshot.id = binding.price_snapshot_id
          WHERE active_binding.order_id = ${orderId}::uuid
        `;
        const currency = currencyRows[0]?.currency;
        if (!currency)
          throw new ConflictException("Order price is unavailable");
        const availableRows = await tx.$queryRaw<Array<{ available: bigint }>>`
          SELECT greatest(
            coalesce((
              SELECT sum(payment.captured_amount_minor)
              FROM payments payment
              WHERE payment.order_id = ${orderId}::uuid
                AND payment.captured_amount_minor IS NOT NULL
            ), 0)
            - coalesce((
              SELECT sum(refund.amount_minor)
              FROM refund_transactions refund
              JOIN payments payment ON payment.id = refund.payment_id
              WHERE payment.order_id = ${orderId}::uuid
                AND refund.status IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
            ), 0)
            - coalesce((
              SELECT sum(greatest(
                adjustment.amount_minor - coalesce(committed.amount_minor, 0),
                0
              ))
              FROM price_adjustments adjustment
              LEFT JOIN LATERAL (
                SELECT sum(refund.amount_minor) AS amount_minor
                FROM refund_transactions refund
                WHERE refund.price_adjustment_id = adjustment.id
                  AND refund.status IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
              ) committed ON true
              WHERE adjustment.order_id = ${orderId}::uuid
            ), 0),
            0
          )::bigint AS available
        `;
        if ((availableRows[0]?.available ?? 0n) < amountMinor) {
          throw new ConflictException(
            "Price adjustment exceeds the uncredited captured amount",
          );
        }
        if (
          selectedPaymentAvailable !== undefined &&
          selectedPaymentAvailable < amountMinor
        ) {
          throw new ConflictException(
            "Price adjustment exceeds the selected Payment refundable balance",
          );
        }
        const adjustment = await tx.priceAdjustment.create({
          data: {
            orderId,
            paymentId: body.paymentId ?? null,
            claimId: body.claimId ?? null,
            idempotencyKey: persistenceKey(
              "fulfilment-adjustment",
              orderId,
              key!,
            ),
            reason,
            amountMinor,
            currency,
            allocation: allocation as Prisma.InputJsonObject,
          },
        });
        return result(orderId, "PRICE_ADJUSTMENT_CREATED", {
          priceAdjustmentId: adjustment.id,
          amountMinor,
          currency,
        });
      },
    );
  }

  refundAdjustment(
    orderId: string,
    adjustmentId: string,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(adjustmentId, "adjustmentId");
    return this.command(
      orderId,
      `price-adjustment:${adjustmentId}:refund`,
      key,
      {},
      async (tx) => {
        await this.lockOrder(tx, orderId);
        await tx.$queryRaw`
          SELECT id FROM price_adjustments
          WHERE id = ${adjustmentId}::uuid AND order_id = ${orderId}::uuid
          FOR UPDATE
        `;
        const adjustment = await tx.priceAdjustment.findFirst({
          where: { id: adjustmentId, orderId },
          include: { refunds: { select: { id: true } } },
        });
        if (!adjustment) {
          throw new NotFoundException("Price adjustment was not found");
        }
        if (adjustment.refunds.length > 0) {
          throw new ConflictException(
            "Price adjustment already has persisted refund work",
          );
        }
        const payments = await tx.payment.findMany({
          where: {
            orderId,
            ...(adjustment.paymentId ? { id: adjustment.paymentId } : {}),
            currency: adjustment.currency,
            capturedAmountMinor: { not: null },
          },
          include: {
            refunds: {
              where: {
                status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] },
              },
            },
            priceAdjustments: {
              where: { id: { not: adjustment.id } },
              include: {
                refunds: {
                  where: {
                    status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] },
                  },
                },
              },
            },
          },
          orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
        });
        const available = payments.reduce(
          (total, payment) =>
            total +
            payment.capturedAmountMinor! -
            payment.refunds.reduce(
              (allocated, refund) => allocated + refund.amountMinor,
              0n,
            ) -
            payment.priceAdjustments.reduce((reserved, otherAdjustment) => {
              const committed = otherAdjustment.refunds.reduce(
                (allocated, refund) => allocated + refund.amountMinor,
                0n,
              );
              const outstanding = otherAdjustment.amountMinor - committed;
              return reserved + (outstanding > 0n ? outstanding : 0n);
            }, 0n),
          0n,
        );
        if (available < adjustment.amountMinor) {
          throw new ConflictException(
            "Price adjustment exceeds the refundable balance",
          );
        }
        const refundReason = adjustmentRefundReason(adjustment.reason);
        const requestedAt = await databaseNow(tx);
        let remaining = adjustment.amountMinor;
        const refundIds: string[] = [];
        for (const payment of payments) {
          if (remaining === 0n) break;
          const alreadyAllocated = payment.refunds.reduce(
            (total, refund) => total + refund.amountMinor,
            0n,
          );
          const reserved = payment.priceAdjustments.reduce(
            (total, otherAdjustment) => {
              const committed = otherAdjustment.refunds.reduce(
                (allocated, refund) => allocated + refund.amountMinor,
                0n,
              );
              const outstanding = otherAdjustment.amountMinor - committed;
              return total + (outstanding > 0n ? outstanding : 0n);
            },
            0n,
          );
          const paymentAvailable =
            payment.capturedAmountMinor! - alreadyAllocated - reserved;
          if (paymentAvailable <= 0n) continue;
          const amountMinor =
            paymentAvailable < remaining ? paymentAvailable : remaining;
          const refund = await tx.refundTransaction.create({
            data: {
              paymentId: payment.id,
              priceAdjustmentId: adjustment.id,
              provider: payment.provider,
              idempotencyKey: persistenceKey(
                "adjustment-refund",
                adjustment.id,
                key!,
                payment.id,
              ),
              amountMinor,
              reason: refundReason,
              requestedAt,
            },
          });
          refundIds.push(refund.id);
          remaining -= amountMinor;
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: "REFUND_PENDING", updatedAt: requestedAt },
          });
        }
        return result(orderId, "PRICE_ADJUSTMENT_REFUND_PENDING", {
          priceAdjustmentId: adjustment.id,
          refundIds,
          amountMinor: adjustment.amountMinor,
          currency: adjustment.currency,
        });
      },
    );
  }

  refundClaim(
    orderId: string,
    claimId: string,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(claimId, "claimId");
    return this.command(
      orderId,
      `claim:${claimId}:refund`,
      key,
      {},
      async (tx) => {
        await this.lockOrder(tx, orderId);
        await tx.$queryRaw`
          SELECT id FROM claims
          WHERE id = ${claimId}::uuid AND order_id = ${orderId}::uuid
          FOR UPDATE
        `;
        const claim = await tx.claim.findFirst({
          where: { id: claimId, orderId },
          include: {
            resolutions: {
              where: { status: ClaimSlotResolutionStatus.PENDING },
              include: { fulfilmentSlot: true },
              orderBy: { fulfilmentSlotId: "asc" },
            },
          },
        });
        if (!claim) throw new NotFoundException("Claim was not found");
        if (
          claim.status !== ClaimStatus.OPEN ||
          claim.resolutions.length === 0
        ) {
          throw new ConflictException("Claim is not awaiting a remedy");
        }
        const adjustmentReason =
          claim.origin === ClaimOrigin.POST_DELIVERY_QUALITY
            ? PriceAdjustmentReason.POST_DELIVERY_ISSUE
            : PriceAdjustmentReason.SHIPMENT_INCIDENT;
        const refundReason =
          claim.origin === ClaimOrigin.POST_DELIVERY_QUALITY
            ? RefundReason.POST_DELIVERY_ISSUE
            : RefundReason.SHIPMENT_INCIDENT;
        const priorAdjustments = await tx.priceAdjustment.findMany({
          where: { orderId },
          include: {
            refunds: {
              where: { status: "SUCCEEDED" },
              select: { amountMinor: true },
            },
          },
        });
        const creditedBySlot = new Map<string, bigint>();
        for (const priorAdjustment of priorAdjustments) {
          const successfullyRefunded = priorAdjustment.refunds.reduce(
            (total, refund) => total + refund.amountMinor,
            0n,
          );
          if (successfullyRefunded !== priorAdjustment.amountMinor) {
            throw new ConflictException(
              "Resolve existing price adjustments before refunding a Claim",
            );
          }
          let credits: PriceAdjustmentSlotCredit[];
          try {
            credits = priceAdjustmentSlotCredits(
              priorAdjustment.allocation,
              false,
            );
          } catch {
            throw new ConflictException(
              "Persisted price adjustment allocation is invalid",
            );
          }
          for (const credit of credits) {
            creditedBySlot.set(
              credit.fulfilmentSlotId,
              (creditedBySlot.get(credit.fulfilmentSlotId) ?? 0n) +
                credit.amountMinor,
            );
          }
        }
        const claimSlotCredits = claim.resolutions.flatMap((resolution) => {
          const credited =
            creditedBySlot.get(resolution.fulfilmentSlotId) ?? 0n;
          const remaining =
            resolution.fulfilmentSlot.settlementAmountMinor - credited;
          if (remaining < 0n) {
            throw new ConflictException(
              "Prior credits exceed a Claim fulfilment slot value",
            );
          }
          return remaining === 0n
            ? []
            : [
                {
                  fulfilmentSlotId: resolution.fulfilmentSlotId,
                  amountMinor: remaining,
                },
              ];
        });
        const amountMinor = claimSlotCredits.reduce(
          (total, credit) => total + credit.amountMinor,
          0n,
        );
        if (amountMinor <= 0n) {
          throw new ConflictException("Claim has no refundable contract value");
        }
        const payments = await tx.payment.findMany({
          where: { orderId, capturedAmountMinor: { not: null } },
          include: {
            refunds: {
              where: {
                status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] },
              },
            },
          },
          orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
        });
        const currency = payments[0]?.currency;
        if (
          !currency ||
          payments.some((payment) => payment.currency !== currency)
        ) {
          throw new ConflictException("Claim payment currency is unavailable");
        }
        const available = payments.reduce(
          (total, payment) =>
            total +
            payment.capturedAmountMinor! -
            payment.refunds.reduce(
              (allocated, refund) => allocated + refund.amountMinor,
              0n,
            ),
          0n,
        );
        if (available < amountMinor) {
          throw new ConflictException("Claim exceeds the refundable balance");
        }
        const at = await databaseNow(tx);
        const adjustment = await tx.priceAdjustment.create({
          data: {
            orderId,
            claimId,
            idempotencyKey: persistenceKey(
              "claim-refund-adjustment",
              orderId,
              claimId,
              key!,
            ),
            reason: adjustmentReason,
            amountMinor,
            currency,
            allocation: {
              claimId,
              slotCredits: claimSlotCredits.map((credit) => ({
                fulfilmentSlotId: credit.fulfilmentSlotId,
                amountMinor: credit.amountMinor.toString(),
              })),
            },
          },
        });
        let remaining = amountMinor;
        const refundIds: string[] = [];
        for (const payment of payments) {
          if (remaining === 0n) break;
          const alreadyAllocated = payment.refunds.reduce(
            (total, refund) => total + refund.amountMinor,
            0n,
          );
          const paymentAvailable =
            payment.capturedAmountMinor! - alreadyAllocated;
          if (paymentAvailable <= 0n) continue;
          const refundAmount =
            paymentAvailable < remaining ? paymentAvailable : remaining;
          const refund = await tx.refundTransaction.create({
            data: {
              paymentId: payment.id,
              claimId,
              priceAdjustmentId: adjustment.id,
              provider: payment.provider,
              idempotencyKey: persistenceKey(
                "claim-refund",
                claimId,
                key!,
                payment.id,
              ),
              amountMinor: refundAmount,
              reason: refundReason,
              requestedAt: at,
            },
          });
          refundIds.push(refund.id);
          remaining -= refundAmount;
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: "REFUND_PENDING", updatedAt: at },
          });
        }
        await tx.claimSlotResolution.updateMany({
          where: { claimId, status: ClaimSlotResolutionStatus.PENDING },
          data: { status: ClaimSlotResolutionStatus.REFUND_PENDING },
        });
        await tx.claim.update({
          where: { id: claimId },
          data: { status: ClaimStatus.ACTIVE },
        });
        return result(orderId, "CLAIM_REFUND_PENDING", {
          claimId,
          priceAdjustmentId: adjustment.id,
          refundIds,
          amountMinor,
          currency,
        });
      },
    );
  }

  completeOrder(
    orderId: string,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    return this.command(orderId, "complete", key, {}, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (order.status !== OrderStatus.DELIVERED) {
        throw new ConflictException("Order is not fully delivered");
      }
      const at = await databaseNow(tx);
      await tx.job.updateMany({
        where: {
          orderId,
          status: JobStatus.HANDED_OVER,
          replacementJob: null,
        },
        data: { status: JobStatus.SETTLED, settledAt: at },
      });
      await tx.orderPhase.updateMany({
        where: { orderId, status: OrderPhaseStatus.DELIVERED },
        data: { status: OrderPhaseStatus.COMPLETED, completedAt: at },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.COMPLETED, updatedAt: at },
      });
      return result(orderId, "ORDER_COMPLETED", { completedAt: at });
    });
  }

  cancelOrder(
    orderId: string,
    body: CancelOrderDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    const reason = requiredText(body.reason, "reason", 2_000);
    const printingConsumptions = cancellationPrintingConsumptions(
      body.printingConsumptions,
    );
    const commandInput = {
      reason,
      printingConsumptions: [...printingConsumptions]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([jobId, actualMaterialMilligrams]) => ({
          jobId,
          actualMaterialMilligrams: actualMaterialMilligrams.toString(),
        })),
    };
    return this.command(orderId, "cancel", key, commandInput, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (
        [
          OrderStatus.SHIPPED,
          OrderStatus.DELIVERED,
          OrderStatus.COMPLETED,
          OrderStatus.PARTIALLY_FULFILLED,
          OrderStatus.REFUNDED,
        ].includes(
          order.status as
            | typeof OrderStatus.SHIPPED
            | typeof OrderStatus.DELIVERED
            | typeof OrderStatus.COMPLETED
            | typeof OrderStatus.PARTIALLY_FULFILLED
            | typeof OrderStatus.REFUNDED,
        )
      ) {
        throw new ConflictException("Order cannot be cancelled after handoff");
      }
      const liveLabels = await tx.shipment.findMany({
        where: {
          orderId,
          status: {
            in: [
              ShipmentStatus.LABEL_CREATED,
              ShipmentStatus.CANCELLATION_PENDING,
            ],
          },
        },
        select: { id: true, status: true },
      });
      const at = await databaseNow(tx);
      if (liveLabels.length > 0) {
        await tx.shipment.updateMany({
          where: {
            id: {
              in: liveLabels
                .filter(({ status }) => status === ShipmentStatus.LABEL_CREATED)
                .map(({ id }) => id),
            },
            status: ShipmentStatus.LABEL_CREATED,
          },
          data: {
            status: ShipmentStatus.CANCELLATION_PENDING,
            cancellationRequestedAt: at,
          },
        });
        return result(orderId, "LABEL_CANCELLATION_PENDING", {
          shipmentIds: liveLabels.map(({ id }) => id),
        });
      }
      const refundIds = await this.finalizeCancellation(
        tx,
        orderId,
        at,
        key!,
        printingConsumptions,
      );
      return result(orderId, "ORDER_CANCELLED", { refundIds, reason });
    });
  }

  private async finalizeCancellation(
    tx: Transaction,
    orderId: string,
    at: Date,
    key: string,
    printingConsumptions = new Map<string, bigint>(),
  ): Promise<string[]> {
    await tx.shipment.updateMany({
      where: { orderId, status: ShipmentStatus.PLANNED },
      data: { status: ShipmentStatus.CANCELLED, cancelledAt: at },
    });
    const printing = await tx.productionReservation.findMany({
      where: {
        job: { orderId, status: JobStatus.PRINTING },
        status: "PRINTING",
      },
      select: { id: true, jobId: true },
    });
    if (
      printing.length !== printingConsumptions.size ||
      printing.some(
        ({ jobId }) => !jobId || printingConsumptions.get(jobId) === undefined,
      )
    ) {
      throw new BadRequestException(
        "printingConsumptions must cover every actively printing Job",
      );
    }
    for (const production of printing) {
      await tx.$queryRaw`
        SELECT taven_settle_printing_production_reservation(
          ${production.id}::uuid,
          ${printingConsumptions.get(production.jobId!)!}
        )::text
      `;
    }
    const preprint = await tx.productionReservation.findMany({
      where: {
        job: { orderId },
        status: { in: ["RESERVED", "HELD", "SCHEDULED"] },
      },
      select: { id: true },
    });
    for (const production of preprint) {
      await tx.$queryRaw`
          SELECT taven_release_production_reservation_before_print(
            ${production.id}::uuid
          )::text
        `;
    }
    await tx.job.updateMany({
      where: {
        orderId,
        status: {
          in: [
            JobStatus.CREATED,
            JobStatus.ACCEPTED,
            JobStatus.GCODE_READY,
            JobStatus.PRINTING,
            JobStatus.PRINTED,
            JobStatus.PHOTO_SUBMITTED,
            JobStatus.QC_APPROVED,
            JobStatus.PACKED,
          ],
        },
      },
      data: {
        status: JobStatus.CANCELLED,
        cancelledAt: at,
        cancellationReason: "ORDER_CANCELLED",
      },
    });
    await tx.fulfilmentSlot.updateMany({
      where: { orderId, outcome: "PENDING" },
      data: { outcome: "CANCELLED", updatedAt: at },
    });
    await tx.orderPhase.updateMany({
      where: { orderId },
      data: {
        status: OrderPhaseStatus.CANCELLED,
        cancelledAt: at,
      },
    });
    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED, updatedAt: at },
    });
    const productionFailureRequests = await tx.replacementRequest.findMany({
      where: { orderId, status: ReplacementRequestStatus.REFUND_REQUIRED },
      select: { id: true },
    });
    if (productionFailureRequests.length > 0) {
      await tx.replacementRequest.updateMany({
        where: {
          id: { in: productionFailureRequests.map(({ id }) => id) },
        },
        data: {
          status: ReplacementRequestStatus.RESOLVED,
          resolvedAt: at,
        },
      });
    }
    const payments = await tx.payment.findMany({
      where: { orderId, capturedAmountMinor: { not: null } },
      include: { refunds: { where: { status: "SUCCEEDED" } } },
      orderBy: { id: "asc" },
    });
    const refundIds: string[] = [];
    for (const payment of payments) {
      const refunded = payment.refunds.reduce(
        (total, refund) => total + refund.amountMinor,
        0n,
      );
      const remaining = payment.capturedAmountMinor! - refunded;
      if (remaining <= 0n) continue;
      const refund = await tx.refundTransaction.create({
        data: {
          paymentId: payment.id,
          provider: payment.provider,
          idempotencyKey: persistenceKey(
            "fulfilment-cancel",
            orderId,
            key,
            payment.id,
          ),
          amountMinor: remaining,
          reason:
            productionFailureRequests.length > 0
              ? RefundReason.PRODUCTION_FAILURE
              : RefundReason.CUSTOMER_CANCELLATION,
          requestedAt: at,
        },
      });
      refundIds.push(refund.id);
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: "REFUND_PENDING", updatedAt: at },
      });
    }
    return refundIds;
  }

  private async command(
    orderId: string,
    operation: string,
    key: string | undefined,
    input: unknown,
    execute: CommandOperation,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(orderId, "orderId");
    const idempotencyKey = requiredIdempotencyKey(key);
    const operationDigest = createHash("sha256")
      .update(operation)
      .digest("hex")
      .slice(0, 24);
    const namespace = `fulfilment:${orderId}:${operationDigest}`;
    const fingerprint = createHash("sha256")
      .update(canonicalJson(input))
      .digest("hex");
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${namespace}:${idempotencyKey}`}, 0)
          )::text
        `;
        const now = await databaseNow(tx);
        const existing = await tx.idempotencyRecord.findFirst({
          where: { namespace, idempotencyKey },
          orderBy: { generation: "desc" },
        });
        if (existing && existing.expiresAt > now) {
          if (existing.requestFingerprint !== fingerprint) {
            throw new ConflictException(
              "Idempotency key was already used with different input",
            );
          }
          if (
            existing.status !== IdempotencyStatus.COMPLETED ||
            !existing.responseBody
          ) {
            throw new ConflictException("Idempotent command is incomplete");
          }
          return existing.responseBody as unknown as FulfilmentCommandResultDto;
        }
        const record = await tx.idempotencyRecord.create({
          data: {
            namespace,
            idempotencyKey,
            generation: (existing?.generation ?? 0) + 1,
            requestFingerprint: fingerprint,
            expiresAt: addDays(now, IDEMPOTENCY_DAYS),
          },
        });
        const response = jsonSafe(
          await execute(tx),
        ) as FulfilmentCommandResultDto;
        await tx.auditEvent.create({
          data: {
            orderId,
            correlationId: record.id,
            eventType: "fulfilment.command_completed",
            actorKind: "OPERATOR",
            actorId: V0_OPERATOR_ACTOR_ID,
            idempotencyKey,
            payload: jsonSafe({
              operation,
              input,
              response,
            }) as Prisma.InputJsonObject,
          },
        });
        await tx.idempotencyRecord.update({
          where: { id: record.id },
          data: {
            status: IdempotencyStatus.COMPLETED,
            responseStatusCode: 200,
            responseBody: response as unknown as Prisma.InputJsonObject,
          },
        });
        return response;
      });
    } catch (error) {
      throwFulfilmentError(error);
    }
  }

  private async lockOrder(tx: Transaction, orderId: string) {
    await tx.$queryRaw`
      SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException("Order was not found");
    return order;
  }

  private async lockJob(tx: Transaction, orderId: string, jobId: string) {
    assertUuid(jobId, "jobId");
    await this.lockOrder(tx, orderId);
    await tx.$queryRaw`
      SELECT id FROM jobs
      WHERE id = ${jobId}::uuid AND order_id = ${orderId}::uuid
      FOR UPDATE
    `;
    const job = await tx.job.findFirst({ where: { id: jobId, orderId } });
    if (!job) throw new NotFoundException("Job was not found");
    return job;
  }

  private async lockShipment(
    tx: Transaction,
    orderId: string,
    shipmentId: string,
  ) {
    assertUuid(shipmentId, "shipmentId");
    await this.lockOrder(tx, orderId);
    await tx.$queryRaw`
      SELECT id FROM shipments
      WHERE id = ${shipmentId}::uuid AND order_id = ${orderId}::uuid
      FOR UPDATE
    `;
    const shipment = await tx.shipment.findFirst({
      where: { id: shipmentId, orderId },
    });
    if (!shipment) throw new NotFoundException("Shipment was not found");
    return shipment;
  }
}

function result(
  orderId: string,
  status: string,
  value: unknown,
): FulfilmentCommandResultDto {
  return {
    orderId,
    status,
    result: jsonSafe(value) as Record<string, unknown>,
  };
}

function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
}

function requiredIdempotencyKey(value?: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length < 8 || normalized.length > 255) {
    throw new BadRequestException(
      "Idempotency-Key must contain 8 through 255 characters",
    );
  }
  return normalized;
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new BadRequestException(`${name} is invalid`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, name, maximum);
}

function positiveBigInt(
  value: unknown,
  name: string,
  allowZero = false,
): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed < (allowZero ? 0n : 1n) || parsed > 9_223_372_036_854_775_807n) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return parsed;
}

type PriceAdjustmentSlotCredit = {
  fulfilmentSlotId: string;
  amountMinor: bigint;
};

function priceAdjustmentSlotCredits(
  allocation: unknown,
  required: boolean,
): PriceAdjustmentSlotCredit[] {
  if (
    !allocation ||
    typeof allocation !== "object" ||
    Array.isArray(allocation)
  ) {
    throw new BadRequestException("allocation is invalid");
  }
  const raw = (allocation as Record<string, unknown>).slotCredits;
  if (raw === undefined) {
    if (required) {
      throw new BadRequestException(
        "allocation.slotCredits is required for this adjustment reason",
      );
    }
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestException("allocation.slotCredits is invalid");
  }
  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(
        `allocation.slotCredits[${index}] is invalid`,
      );
    }
    const record = value as Record<string, unknown>;
    const fulfilmentSlotId = record.fulfilmentSlotId;
    if (typeof fulfilmentSlotId !== "string") {
      throw new BadRequestException(
        `allocation.slotCredits[${index}].fulfilmentSlotId is invalid`,
      );
    }
    assertUuid(
      fulfilmentSlotId,
      `allocation.slotCredits[${index}].fulfilmentSlotId`,
    );
    if (seen.has(fulfilmentSlotId)) {
      throw new BadRequestException(
        "allocation.slotCredits contains duplicate fulfilment slots",
      );
    }
    seen.add(fulfilmentSlotId);
    return {
      fulfilmentSlotId,
      amountMinor: positiveBigInt(
        record.amountMinor,
        `allocation.slotCredits[${index}].amountMinor`,
      ),
    };
  });
}

function cancellationPrintingConsumptions(input: unknown): Map<string, bigint> {
  if (input === undefined) return new Map();
  if (!Array.isArray(input)) {
    throw new BadRequestException("printingConsumptions is invalid");
  }
  const consumptions = new Map<string, bigint>();
  input.forEach((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(
        `printingConsumptions[${index}] is invalid`,
      );
    }
    const record = value as Record<string, unknown>;
    if (typeof record.jobId !== "string") {
      throw new BadRequestException(
        `printingConsumptions[${index}].jobId is invalid`,
      );
    }
    assertUuid(record.jobId, `printingConsumptions[${index}].jobId`);
    if (consumptions.has(record.jobId)) {
      throw new BadRequestException(
        "printingConsumptions contains duplicate Jobs",
      );
    }
    consumptions.set(
      record.jobId,
      positiveBigInt(
        record.actualMaterialMilligrams,
        `printingConsumptions[${index}].actualMaterialMilligrams`,
        true,
      ),
    );
  });
  return consumptions;
}

function enumValue<T extends Record<string, string>>(
  values: T,
  value: unknown,
  name: string,
): T[keyof T] {
  if (
    typeof value !== "string" ||
    !Object.values(values).includes(value as T[keyof T])
  ) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value as T[keyof T];
}

function providerEvidence(body: ShipmentProviderEvidenceDto): {
  providerEventId: string;
  providerTransactionId: string;
  occurredAt: Date;
} {
  const occurredAt = new Date(body.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new BadRequestException("occurredAt is invalid");
  }
  return {
    providerEventId: requiredText(body.providerEventId, "providerEventId", 255),
    providerTransactionId: requiredText(
      body.providerTransactionId,
      "providerTransactionId",
      255,
    ),
    occurredAt,
  };
}

function assertShipmentEventTransition(
  status: ShipmentStatus,
  kind: ShipmentProviderEventKind,
): void {
  const valid =
    (kind === ShipmentProviderEventKind.TRANSIT_SCAN &&
      status === ShipmentStatus.HANDED_OVER) ||
    (kind === ShipmentProviderEventKind.DELIVERY_SCAN &&
      (status === ShipmentStatus.HANDED_OVER ||
        status === ShipmentStatus.IN_TRANSIT)) ||
    ((kind === ShipmentProviderEventKind.LOST ||
      kind === ShipmentProviderEventKind.RETURNED) &&
      status === ShipmentStatus.IN_TRANSIT) ||
    (kind === ShipmentProviderEventKind.RECOVERED &&
      status === ShipmentStatus.LOST);
  if (!valid) {
    throw new ConflictException(
      "Shipment event does not match its current state",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function persistenceKey(prefix: string, ...values: string[]): string {
  return `${prefix}:${createHash("sha256")
    .update(values.join("\0"))
    .digest("hex")}`;
}

function adjustmentRefundReason(reason: PriceAdjustmentReason): RefundReason {
  switch (reason) {
    case PriceAdjustmentReason.EXPRESS_BREACH:
      return RefundReason.EXPRESS_BREACH;
    case PriceAdjustmentReason.PRODUCTION_FAILURE:
      return RefundReason.PRODUCTION_FAILURE;
    case PriceAdjustmentReason.SHIPMENT_INCIDENT:
      return RefundReason.SHIPMENT_INCIDENT;
    case PriceAdjustmentReason.POST_DELIVERY_ISSUE:
      return RefundReason.POST_DELIVERY_ISSUE;
  }
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as unknown;
}

async function databaseNow(tx: Transaction): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ observed_at: Date }>>`
    SELECT clock_timestamp() AS observed_at
  `;
  const observedAt = rows[0]?.observed_at;
  if (!observedAt) throw new Error("Database clock is unavailable");
  return observedAt;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000);
}

function throwFulfilmentError(error: unknown): never {
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException
  ) {
    throw error;
  }
  const prismaCode =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  const meta =
    error && typeof error === "object" && "meta" in error
      ? error.meta
      : undefined;
  const databaseCode =
    meta && typeof meta === "object" && "code" in meta
      ? String(meta.code)
      : undefined;
  if (
    prismaCode === "P2025" ||
    prismaCode === "P2003" ||
    databaseCode === "23503"
  ) {
    throw new NotFoundException("Fulfilment resource was not found");
  }
  if (
    prismaCode === "P2002" ||
    prismaCode === "P2010" ||
    databaseCode === "23505" ||
    databaseCode === "23514" ||
    databaseCode === "23P01"
  ) {
    throw new ConflictException(
      "Fulfilment command conflicts with current state",
    );
  }
  throw error;
}
