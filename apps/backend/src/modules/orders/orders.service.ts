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
  JobCancellationReason,
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
  CreateClaimReprintDto,
  CreateClaimDto,
  CreatePriceAdjustmentDto,
  CreateReplacementDto,
  CreateShipmentDto,
  FulfilmentCommandResultDto,
  FulfilmentProjectionDto,
  HandoffReshipmentDto,
  JobFailureDto,
  JobPrintedDto,
  JobQcSubmissionDto,
  PackJobDto,
  RejectClaimDto,
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
          include: {
            resolutions: true,
            refunds: true,
            reshipmentAuthorizations: true,
          },
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
    const printingConsumptions = cancellationPrintingConsumptions(
      body.printingConsumptions,
    );
    if (body.recovery !== "REFUND" && printingConsumptions.size > 0) {
      throw new BadRequestException(
        "printingConsumptions is only valid for parcel refund recovery",
      );
    }
    return this.command(
      orderId,
      `job:${jobId}:failure`,
      key,
      {
        stage,
        reason,
        recovery: body.recovery,
        actualMaterialMilligrams: actual?.toString() ?? null,
        printingConsumptions: [...printingConsumptions]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([siblingJobId, actualMaterialMilligrams]) => ({
            jobId: siblingJobId,
            actualMaterialMilligrams: actualMaterialMilligrams.toString(),
          })),
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
        if (body.recovery === "REFUND") {
          const claimReprintRequest = await tx.replacementRequest.findFirst({
            where: {
              replacementJobId: jobId,
              reason: ReplacementRequestReason.SHIPMENT_LOST,
              status: ReplacementRequestStatus.JOB_CREATED,
              claimId: { not: null },
            },
            select: { id: true, claimId: true },
          });
          if (claimReprintRequest?.claimId) {
            const prepared = await this.prepareClaimReprintFailureRefund(
              tx,
              orderId,
              job,
              jobId,
              claimReprintRequest.claimId,
              failedAt,
              printingConsumptions,
            );
            return result(orderId, prepared.status, {
              jobId,
              claimId: claimReprintRequest.claimId,
              shipmentId: prepared.shipmentId,
              replacementRequestId: request.id,
              recovery: body.recovery,
            });
          }
          const custodyAlreadyTransferred = await tx.shipment.count({
            where: {
              orderId,
              shipmentPlanId: { not: job.shipmentPlanId },
              status: {
                in: [
                  ShipmentStatus.HANDED_OVER,
                  ShipmentStatus.IN_TRANSIT,
                  ShipmentStatus.DELIVERED,
                  ShipmentStatus.LOST,
                  ShipmentStatus.RETURNED,
                  ShipmentStatus.RECOVERED,
                ],
              },
              replacementShipment: null,
            },
          });
          if (custodyAlreadyTransferred > 0) {
            await this.cancelProductionFailureParcelSiblings(
              tx,
              orderId,
              job.shipmentPlanId,
              jobId,
              failedAt,
              printingConsumptions,
            );
            const shipment = await tx.shipment.findFirst({
              where: {
                orderId,
                shipmentPlanId: job.shipmentPlanId,
                replacementShipment: null,
              },
            });
            if (!shipment) {
              throw new ConflictException(
                "Production failure refund requires its exact parcel",
              );
            }
            if (shipment.status === ShipmentStatus.LABEL_CREATED) {
              await tx.shipment.update({
                where: { id: shipment.id },
                data: {
                  status: ShipmentStatus.CANCELLATION_PENDING,
                  cancellationRequestedAt: failedAt,
                },
              });
              return result(
                orderId,
                "PRODUCTION_FAILURE_LABEL_CANCELLATION_PENDING",
                {
                  jobId,
                  shipmentId: shipment.id,
                  replacementRequestId: request.id,
                  recovery: body.recovery,
                },
              );
            }
            if (shipment.status !== ShipmentStatus.PLANNED) {
              throw new ConflictException(
                "Production failure parcel is not refundable before handoff",
              );
            }
            await tx.shipment.update({
              where: { id: shipment.id },
              data: { status: ShipmentStatus.CANCELLED, cancelledAt: failedAt },
            });
            const refundIds =
              await this.finalizePostHandoffProductionFailureRefund(
                tx,
                orderId,
                job.shipmentPlanId,
                request.id,
                failedAt,
                key!,
              );
            return result(orderId, "PRODUCTION_FAILURE_REFUND_PENDING", {
              jobId,
              shipmentId: shipment.id,
              replacementRequestId: request.id,
              refundIds,
              recovery: body.recovery,
            });
          }
        }
        if (printingConsumptions.size > 0) {
          throw new BadRequestException(
            "printingConsumptions does not match an abandoned parcel scope",
          );
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
        const now = await databaseNow(tx);
        if (request.deadlineAt.getTime() <= now.getTime()) {
          throw new ConflictException(
            "Replacement request deadline has expired",
          );
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
              status: ShipmentStatus.CANCELLED,
              cancelledAt: { not: null },
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
        const postHandoffStatuses: ShipmentStatus[] = [
          ShipmentStatus.HANDED_OVER,
          ShipmentStatus.IN_TRANSIT,
          ShipmentStatus.DELIVERED,
          ShipmentStatus.LOST,
          ShipmentStatus.RETURNED,
          ShipmentStatus.RECOVERED,
        ];
        const postHandoffVoid = postHandoffStatuses.includes(shipment.status);
        if (existing) {
          if (
            existing.shipmentId !== shipmentId ||
            existing.kind !== ShipmentProviderEventKind.LABEL_VOIDED ||
            existing.providerTransactionId !== evidence.providerTransactionId ||
            existing.occurredAt.getTime() !== evidence.occurredAt.getTime() ||
            (shipment.status !== ShipmentStatus.CANCELLED && !postHandoffVoid)
          ) {
            throw new ConflictException(
              "Provider event identity is already bound to different evidence",
            );
          }
          return result(
            orderId,
            shipment.status === ShipmentStatus.CANCELLED
              ? "LABEL_VOID_ALREADY_APPLIED"
              : "LABEL_VOID_ALREADY_RECORDED_AFTER_HANDOFF",
            {
              shipmentId,
              providerEventId: evidence.providerEventId,
            },
          );
        }
        if (
          shipment.status !== ShipmentStatus.CANCELLATION_PENDING &&
          !postHandoffVoid
        ) {
          throw new ConflictException(
            "Shipment is not awaiting provider label cancellation",
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
        if (outbox.status === "SUPERSEDED") {
          throw new ConflictException(
            "Carrier label void command was superseded",
          );
        }
        if (
          postHandoffVoid &&
          (outbox.status !== "DELIVERED" || !outbox.deliveredAt)
        ) {
          throw new ConflictException(
            "Carrier label void command has not been delivered",
          );
        }
        const verifiedAt = await databaseNow(tx);
        if (!postHandoffVoid && outbox.status !== "DELIVERED") {
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
        }
        await tx.shipmentProviderEvent.create({
          data: {
            shipmentId,
            outboxMessageId: outbox.id,
            carrier: shipment.carrier,
            carrierLabelId: shipment.carrierLabelId,
            providerEventId: evidence.providerEventId,
            providerTransactionId: evidence.providerTransactionId,
            kind: ShipmentProviderEventKind.LABEL_VOIDED,
            sourceShipmentStatus: shipment.status,
            occurredAt: evidence.occurredAt,
            authenticatedAt: verifiedAt,
            verifiedAt,
          },
        });
        if (postHandoffVoid) {
          return result(orderId, "LABEL_VOID_RECORDED_AFTER_HANDOFF", {
            shipmentId,
            providerEventId: evidence.providerEventId,
            verifiedAt,
          });
        }
        await tx.shipment.update({
          where: { id: shipmentId },
          data: {
            status: ShipmentStatus.CANCELLED,
            providerVoidId: evidence.providerEventId,
            providerVoidedAt: verifiedAt,
            cancelledAt: verifiedAt,
          },
        });
        if (shipment.reprintClaimId) {
          const resolutions = await tx.claimSlotResolution.findMany({
            where: {
              claimId: shipment.reprintClaimId,
              replacementShipmentId: shipmentId,
              status: ClaimSlotResolutionStatus.REPLACEMENT_PENDING,
            },
            select: { id: true },
          });
          const resolutionCount = await tx.claimSlotResolution.count({
            where: { claimId: shipment.reprintClaimId },
          });
          const failedJobs = await tx.job.count({
            where: {
              orderId,
              shipmentPlanId: shipment.shipmentPlanId,
              replacementJob: null,
              status: { in: [JobStatus.FAILED, JobStatus.QC_REJECTED] },
              replacementRequestSource: {
                status: ReplacementRequestStatus.REFUND_REQUIRED,
              },
            },
          });
          const invalidJobs = await tx.job.count({
            where: {
              orderId,
              shipmentPlanId: shipment.shipmentPlanId,
              replacementJob: null,
              NOT: [
                { status: { in: [JobStatus.FAILED, JobStatus.QC_REJECTED] } },
                {
                  status: JobStatus.CANCELLED,
                  cancellationReason: JobCancellationReason.PRODUCTION_FAILURE,
                },
              ],
            },
          });
          if (
            resolutions.length !== resolutionCount ||
            resolutionCount === 0 ||
            failedJobs === 0 ||
            invalidJobs > 0
          ) {
            throw new ConflictException(
              "Claim reprint cancellation does not match its failed parcel scope",
            );
          }
          await tx.claimSlotResolution.updateMany({
            where: {
              claimId: shipment.reprintClaimId,
              replacementShipmentId: shipmentId,
              status: ClaimSlotResolutionStatus.REPLACEMENT_PENDING,
            },
            data: {
              status: ClaimSlotResolutionStatus.PENDING,
              updatedAt: verifiedAt,
            },
          });
          await tx.fulfilmentSlot.updateMany({
            where: {
              orderId,
              outcome: "PENDING",
              shipmentPlanAllocations: {
                some: { shipmentPlanId: shipment.shipmentPlanId },
              },
            },
            data: { outcome: "CANCELLED", updatedAt: verifiedAt },
          });
          return result(
            orderId,
            "LABEL_VOID_CONFIRMED_CLAIM_REPRINT_REFUND_REQUIRED",
            {
              shipmentId,
              claimId: shipment.reprintClaimId,
              providerEventId: evidence.providerEventId,
              providerVoidedAt: verifiedAt,
            },
          );
        }
        const custodyAlreadyTransferred = await tx.shipment.count({
          where: {
            orderId,
            id: { not: shipmentId },
            status: {
              in: [
                ShipmentStatus.HANDED_OVER,
                ShipmentStatus.IN_TRANSIT,
                ShipmentStatus.DELIVERED,
                ShipmentStatus.LOST,
                ShipmentStatus.RETURNED,
                ShipmentStatus.RECOVERED,
              ],
            },
            replacementShipment: null,
          },
        });
        if (custodyAlreadyTransferred > 0) {
          const productionFailureRequests =
            await tx.replacementRequest.findMany({
              where: {
                orderId,
                shipmentPlanId: shipment.shipmentPlanId,
                status: ReplacementRequestStatus.REFUND_REQUIRED,
              },
              select: { id: true },
            });
          const productionFailure = productionFailureRequests[0];
          if (productionFailureRequests.length > 1) {
            throw new ConflictException(
              "Production failure parcel has ambiguous refund obligations",
            );
          }
          const refundIds = productionFailure
            ? await this.finalizePostHandoffProductionFailureRefund(
                tx,
                orderId,
                shipment.shipmentPlanId,
                productionFailure.id,
                verifiedAt,
                key!,
              )
            : await this.finalizePartialCancellation(
                tx,
                orderId,
                shipment.shipmentPlanId,
                verifiedAt,
                key!,
              );
          return result(
            orderId,
            productionFailure
              ? "LABEL_VOID_CONFIRMED_PRODUCTION_FAILURE_REFUND"
              : "LABEL_VOID_CONFIRMED_PARTIAL_CANCELLATION",
            {
              shipmentId,
              providerEventId: evidence.providerEventId,
              providerVoidedAt: verifiedAt,
              refundIds,
            },
          );
        }
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
            ? await this.finalizeCancellation(
                tx,
                orderId,
                verifiedAt,
                key!,
                await this.pendingCancellationPrintingConsumptions(tx, orderId),
                true,
              )
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
            existing.sourceShipmentStatus === ShipmentStatus.CANCELLED &&
            shipment.status === ShipmentStatus.CANCELLED &&
            shipment.providerAcceptanceScanId === null &&
            shipment.handedOverAt === null
          ) {
            return result(orderId, "SHIPMENT_HANDOFF_RECONCILIATION_REQUIRED", {
              shipmentId,
              providerEventId: evidence.providerEventId,
            });
          }
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
        const postVoidCancellation =
          shipment.status === ShipmentStatus.CANCELLED;
        if (
          shipment.status !== ShipmentStatus.LABEL_CREATED &&
          shipment.status !== ShipmentStatus.CANCELLATION_PENDING &&
          !postVoidCancellation
        ) {
          throw new ConflictException("Shipment is not ready for handoff");
        }
        const voidEvent = postVoidCancellation
          ? await tx.shipmentProviderEvent.findFirst({
              where: {
                shipmentId,
                kind: ShipmentProviderEventKind.LABEL_VOIDED,
                providerEventId: shipment.providerVoidId!,
                verifiedAt: shipment.providerVoidedAt!,
              },
            })
          : null;
        if (
          postVoidCancellation &&
          (!voidEvent ||
            evidence.occurredAt.getTime() >= voidEvent.occurredAt.getTime())
        ) {
          throw new ConflictException(
            "Cancelled Shipment accepts only custody scans that physically predate its exact provider void",
          );
        }
        if (
          postVoidCancellation &&
          (await tx.shipment.count({
            where: { replacesShipmentId: shipmentId },
          })) > 0
        ) {
          throw new ConflictException(
            "Replaced cancelled Shipment requires exact manual handoff reconciliation",
          );
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
                (
                  (${postVoidCancellation}::boolean
                   AND (job.status <> 'CANCELLED' OR job.packed_at IS NULL))
                  OR
                  (NOT ${postVoidCancellation}::boolean
                   AND job.status <> 'PACKED')
                )
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
          (!postVoidCancellation && !readiness[0]?.packingReady) ||
          (!readiness[0]?.financialReady &&
            shipment.status !== ShipmentStatus.CANCELLATION_PENDING &&
            !postVoidCancellation)
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
            voidCommand.status === "SUPERSEDED"
          ) {
            throw new ConflictException(
              "Carrier label void command cannot be superseded",
            );
          }
          if (voidCommand.status !== "DELIVERED") {
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
        }
        const acceptanceEvent = await tx.shipmentProviderEvent.create({
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
        if (postVoidCancellation && !readiness[0]?.packingReady) {
          return result(orderId, "SHIPMENT_HANDOFF_RECONCILIATION_REQUIRED", {
            shipmentId,
            providerEventId: evidence.providerEventId,
          });
        }
        if (postVoidCancellation) {
          await this.reconcileCancelledShipmentHandoff(
            tx,
            orderId,
            shipment,
            voidEvent!,
            acceptanceEvent.id,
            evidence.providerEventId,
            verifiedAt,
          );
          return result(orderId, "SHIPMENT_HANDOFF_RECONCILED", {
            shipmentId,
            handedOverAt: verifiedAt,
          });
        }
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
        const reshipmentAuthorization =
          await tx.reshipmentAuthorization.findUnique({
            where: { reshipmentShipmentId: shipmentId },
          });
        const reprintResolution = await tx.claimSlotResolution.findFirst({
          where: {
            replacementShipmentId: shipmentId,
            replacementRequest: {
              reason: ReplacementRequestReason.SHIPMENT_LOST,
            },
          },
          select: { claimId: true },
        });
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
          if (reshipmentAuthorization) {
            const resolutionCount = await tx.claimSlotResolution.count({
              where: {
                claimId: reshipmentAuthorization.claimId,
                replacementShipmentId: shipmentId,
              },
            });
            const deliveredResolutions =
              await tx.claimSlotResolution.updateMany({
                where: {
                  claimId: reshipmentAuthorization.claimId,
                  replacementShipmentId: shipmentId,
                  status: ClaimSlotResolutionStatus.RESHIP_PENDING,
                },
                data: {
                  status: ClaimSlotResolutionStatus.DELIVERED_RESHIP,
                  resolvedAt: verifiedAt,
                  updatedAt: verifiedAt,
                },
              });
            const resolvedClaim = await tx.claim.updateMany({
              where: {
                id: reshipmentAuthorization.claimId,
                status: ClaimStatus.ACTIVE,
              },
              data: {
                status: ClaimStatus.RESOLVED_RESHIP,
                resolvedAt: verifiedAt,
                updatedAt: verifiedAt,
              },
            });
            if (
              resolutionCount === 0 ||
              deliveredResolutions.count !== resolutionCount ||
              resolvedClaim.count !== 1
            ) {
              throw new ConflictException(
                "Reshipment delivery does not match its active Claim remedy",
              );
            }
          } else if (reprintResolution) {
            const resolutionCount = await tx.claimSlotResolution.count({
              where: {
                claimId: reprintResolution.claimId,
                replacementShipmentId: shipmentId,
              },
            });
            const deliveredResolutions =
              await tx.claimSlotResolution.updateMany({
                where: {
                  claimId: reprintResolution.claimId,
                  replacementShipmentId: shipmentId,
                  status: ClaimSlotResolutionStatus.REPLACEMENT_PENDING,
                },
                data: {
                  status: ClaimSlotResolutionStatus.DELIVERED_REPLACEMENT,
                  resolvedAt: verifiedAt,
                  updatedAt: verifiedAt,
                },
              });
            const resolvedClaim = await tx.claim.updateMany({
              where: {
                id: reprintResolution.claimId,
                status: ClaimStatus.ACTIVE,
              },
              data: {
                status: ClaimStatus.RESOLVED_REPLACEMENT,
                resolvedAt: verifiedAt,
                updatedAt: verifiedAt,
              },
            });
            if (
              resolutionCount === 0 ||
              deliveredResolutions.count !== resolutionCount ||
              resolvedClaim.count !== 1
            ) {
              throw new ConflictException(
                "Reprint delivery does not match its active Claim remedy",
              );
            }
          }
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
          } else {
            const partial = await tx.$queryRaw<Array<{ ready: boolean }>>`
              SELECT EXISTS (
                SELECT 1 FROM fulfilment_slots
                WHERE order_id = ${orderId}::uuid AND outcome = 'DELIVERED'
              ) AND NOT EXISTS (
                SELECT 1 FROM fulfilment_slots
                WHERE order_id = ${orderId}::uuid
                  AND outcome NOT IN ('DELIVERED', 'CANCELLED_REFUNDED')
              ) AND NOT EXISTS (
                SELECT 1 FROM claims claim
                WHERE claim.order_id = ${orderId}::uuid
                  AND claim.status IN ('OPEN', 'ACTIVE')
              ) AND NOT EXISTS (
                SELECT 1 FROM refund_transactions refund
                JOIN payments payment ON payment.id = refund.payment_id
                WHERE payment.order_id = ${orderId}::uuid
                  AND refund.status IN ('PENDING', 'SUSPENDED')
              ) AS ready
            `;
            if (partial[0]?.ready) {
              await tx.orderPhase.updateMany({
                where: {
                  id: shipment.orderPhaseId,
                  status: OrderPhaseStatus.SHIPPED,
                },
                data: { status: OrderPhaseStatus.PARTIALLY_FULFILLED },
              });
              await tx.order.updateMany({
                where: { id: orderId, status: OrderStatus.SHIPPED },
                data: {
                  status: OrderStatus.PARTIALLY_FULFILLED,
                  updatedAt: verifiedAt,
                },
              });
            }
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
            if (reshipmentAuthorization) {
              const resolutionCount = await tx.claimSlotResolution.count({
                where: {
                  claimId: reshipmentAuthorization.claimId,
                  replacementShipmentId: shipmentId,
                },
              });
              const recoveredResolutions =
                await tx.claimSlotResolution.updateMany({
                  where: {
                    claimId: reshipmentAuthorization.claimId,
                    replacementShipmentId: shipmentId,
                    status: ClaimSlotResolutionStatus.RESHIP_PENDING,
                  },
                  data: {
                    status: ClaimSlotResolutionStatus.PENDING,
                    updatedAt: verifiedAt,
                  },
                });
              if (
                resolutionCount === 0 ||
                recoveredResolutions.count !== resolutionCount
              ) {
                throw new ConflictException(
                  "Reshipment incident does not match its active Claim remedy",
                );
              }
            } else if (reprintResolution) {
              const resolutionCount = await tx.claimSlotResolution.count({
                where: {
                  claimId: reprintResolution.claimId,
                  replacementShipmentId: shipmentId,
                },
              });
              const recoveredResolutions =
                await tx.claimSlotResolution.updateMany({
                  where: {
                    claimId: reprintResolution.claimId,
                    replacementShipmentId: shipmentId,
                    status: ClaimSlotResolutionStatus.REPLACEMENT_PENDING,
                  },
                  data: {
                    status: ClaimSlotResolutionStatus.PENDING,
                    updatedAt: verifiedAt,
                  },
                });
              if (
                resolutionCount === 0 ||
                recoveredResolutions.count !== resolutionCount
              ) {
                throw new ConflictException(
                  "Reprint incident does not match its active Claim remedy",
                );
              }
            } else {
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
          if (shipment.reprintClaimId) {
            throw new ConflictException(
              "Claim-owned replacement Shipment must reuse its existing Claim",
            );
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

  rejectClaim(
    orderId: string,
    claimId: string,
    body: RejectClaimDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(claimId, "claimId");
    const reason = requiredText(body.reason, "reason", 2_000);
    return this.command(
      orderId,
      `claim:${claimId}:rejection`,
      key,
      { reason },
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
              include: { fulfilmentSlot: true },
              orderBy: { fulfilmentSlotId: "asc" },
            },
            replacementRequests: { select: { id: true } },
            reprintShipments: { select: { id: true } },
            reshipmentAuthorizations: { select: { id: true } },
            priceAdjustments: { select: { id: true } },
            refunds: { select: { id: true } },
          },
        });
        if (!claim) throw new NotFoundException("Claim was not found");
        await tx.$queryRaw`
          SELECT id FROM claim_slot_resolutions
          WHERE claim_id = ${claimId}::uuid
          ORDER BY id
          FOR UPDATE
        `;
        if (
          claim.origin !== ClaimOrigin.POST_DELIVERY_QUALITY ||
          claim.status !== ClaimStatus.OPEN ||
          claim.resolutions.length === 0 ||
          claim.resolutions.some(
            ({
              status,
              replacementRequestId,
              replacementShipmentId,
              fulfilmentSlot,
            }) =>
              status !== ClaimSlotResolutionStatus.PENDING ||
              replacementRequestId !== null ||
              replacementShipmentId !== null ||
              fulfilmentSlot.outcome !== "DELIVERED",
          ) ||
          claim.replacementRequests.length > 0 ||
          claim.reprintShipments.length > 0 ||
          claim.reshipmentAuthorizations.length > 0 ||
          claim.priceAdjustments.length > 0 ||
          claim.refunds.length > 0
        ) {
          throw new ConflictException(
            "Only a clean post-delivery quality Claim can be rejected",
          );
        }
        const rejectedAt = await databaseNow(tx);
        const rejected = await tx.claimSlotResolution.updateMany({
          where: {
            claimId,
            status: ClaimSlotResolutionStatus.PENDING,
            replacementRequestId: null,
            replacementShipmentId: null,
          },
          data: {
            status: ClaimSlotResolutionStatus.REJECTED,
            resolvedAt: rejectedAt,
            updatedAt: rejectedAt,
          },
        });
        const resolved = await tx.claim.updateMany({
          where: {
            id: claimId,
            orderId,
            origin: ClaimOrigin.POST_DELIVERY_QUALITY,
            status: ClaimStatus.OPEN,
          },
          data: {
            status: ClaimStatus.RESOLVED_REJECTED,
            resolvedAt: rejectedAt,
            updatedAt: rejectedAt,
          },
        });
        if (
          rejected.count !== claim.resolutions.length ||
          resolved.count !== 1
        ) {
          throw new ConflictException(
            "Claim rejection lost its complete pending resolution scope",
          );
        }
        return result(orderId, "CLAIM_REJECTED", {
          claimId,
          fulfilmentSlotIds: claim.resolutions.map(
            ({ fulfilmentSlotId }) => fulfilmentSlotId,
          ),
          rejectedAt,
        });
      },
    );
  }

  createClaimReprint(
    orderId: string,
    claimId: string,
    body: CreateClaimReprintDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(claimId, "claimId");
    if (!Array.isArray(body.replacements) || body.replacements.length === 0) {
      throw new BadRequestException("replacements is invalid");
    }
    const replacements = body.replacements
      .map(({ sourceJobId, candidateResourceEstimateId }) => {
        assertUuid(sourceJobId, "sourceJobId");
        assertUuid(candidateResourceEstimateId, "candidateResourceEstimateId");
        return { sourceJobId, candidateResourceEstimateId };
      })
      .sort((left, right) => left.sourceJobId.localeCompare(right.sourceJobId));
    if (
      new Set(replacements.map(({ sourceJobId }) => sourceJobId)).size !==
        replacements.length ||
      new Set(
        replacements.map(
          ({ candidateResourceEstimateId }) => candidateResourceEstimateId,
        ),
      ).size !== replacements.length
    ) {
      throw new BadRequestException(
        "replacements must contain unique source Jobs and candidates",
      );
    }
    const requestedPlanKey = optionalText(body.planKey, "planKey", 255);
    return this.command(
      orderId,
      `claim:${claimId}:reprint`,
      key,
      { replacements, planKey: requestedPlanKey ?? null },
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        if (order.status !== OrderStatus.SHIPPED) {
          throw new ConflictException(
            "Parcel reprint requires a shipped Order",
          );
        }
        await tx.$queryRaw`
          SELECT id FROM claims
          WHERE id = ${claimId}::uuid AND order_id = ${orderId}::uuid
          FOR UPDATE
        `;
        const claim = await tx.claim.findFirst({
          where: { id: claimId, orderId },
          include: {
            incidentShipment: true,
            resolutions: {
              include: { replacementShipment: true },
              orderBy: { fulfilmentSlotId: "asc" },
            },
          },
        });
        if (!claim) throw new NotFoundException("Claim was not found");
        const rootShipment = claim.incidentShipment;
        const priorReplacementIds = new Set(
          claim.resolutions.flatMap(({ replacementShipmentId }) =>
            replacementShipmentId ? [replacementShipmentId] : [],
          ),
        );
        const retrying = claim.status === ClaimStatus.ACTIVE;
        const predecessor = retrying
          ? claim.resolutions[0]?.replacementShipment
          : rootShipment;
        const predecessorAuthorization = predecessor
          ? await tx.reshipmentAuthorization.findUnique({
              where: { reshipmentShipmentId: predecessor.id },
            })
          : null;
        const predecessorIsReprint = predecessor?.reprintClaimId === claimId;
        const predecessorIsReship =
          predecessorAuthorization?.claimId === claimId;
        if (
          claim.origin !== ClaimOrigin.SHIPMENT_INCIDENT ||
          ![ClaimStatus.OPEN, ClaimStatus.ACTIVE].includes(
            claim.status as typeof ClaimStatus.OPEN | typeof ClaimStatus.ACTIVE,
          ) ||
          !rootShipment ||
          !predecessor ||
          predecessor.status !== ShipmentStatus.LOST ||
          (retrying &&
            (priorReplacementIds.size !== 1 ||
              (!predecessorIsReprint && !predecessorIsReship)))
        ) {
          throw new ConflictException(
            "Only an unresolved LOST parcel Claim can authorize a reprint",
          );
        }
        await tx.$queryRaw`
          SELECT id FROM fulfilment_slots
          WHERE order_id = ${orderId}::uuid
          ORDER BY id
          FOR UPDATE
        `;
        await tx.$queryRaw`
          SELECT id FROM claim_slot_resolutions
          WHERE claim_id = ${claimId}::uuid
          ORDER BY id
          FOR UPDATE
        `;
        const planSlotIds = (
          await tx.shipmentPlanFulfilmentSlot.findMany({
            where: { shipmentPlanId: predecessor.shipmentPlanId },
            select: { fulfilmentSlotId: true },
            orderBy: { fulfilmentSlotId: "asc" },
          })
        ).map(({ fulfilmentSlotId }) => fulfilmentSlotId);
        const claimedSlotIds = claim.resolutions.map(
          ({ fulfilmentSlotId }) => fulfilmentSlotId,
        );
        const successorCount = await tx.shipment.count({
          where: { replacesShipmentId: predecessor.id },
        });
        const financialWork =
          (await tx.refundTransaction.count({ where: { claimId } })) +
          (await tx.priceAdjustment.count({ where: { claimId } }));
        if (
          successorCount !== 0 ||
          financialWork !== 0 ||
          planSlotIds.length === 0 ||
          planSlotIds.length !== claimedSlotIds.length ||
          planSlotIds.some(
            (slotId, index) => slotId !== claimedSlotIds[index],
          ) ||
          claim.resolutions.some(
            ({ status, replacementRequestId, replacementShipmentId }) =>
              status !== ClaimSlotResolutionStatus.PENDING ||
              (!retrying &&
                (replacementRequestId !== null ||
                  replacementShipmentId !== null)) ||
              (retrying &&
                (replacementShipmentId !== predecessor.id ||
                  (predecessorIsReprint && replacementRequestId === null) ||
                  (predecessorIsReship && replacementRequestId !== null))),
          )
        ) {
          throw new ConflictException(
            "Parcel reprint requires the whole unresolved LOST Claim",
          );
        }
        const pendingSlots = await tx.fulfilmentSlot.count({
          where: { id: { in: planSlotIds }, orderId, outcome: "PENDING" },
        });
        if (pendingSlots !== planSlotIds.length) {
          throw new ConflictException(
            "Parcel reprint requires unresolved fulfilment slots",
          );
        }
        const sourceJobs = await tx.job.findMany({
          where: {
            orderId,
            orderPhaseId: predecessor.orderPhaseId,
            shipmentPlanId: predecessor.shipmentPlanId,
            replacementJob: null,
          },
          include: {
            shipmentAssignment: true,
            phaseResourcePlanJob: {
              include: {
                candidateResourceEstimate: true,
                slots: { orderBy: { fulfilmentSlotId: "asc" } },
              },
            },
          },
          orderBy: { id: "asc" },
        });
        const predecessorLineageIds = await this.shipmentLineageIds(
          tx,
          predecessor.id,
        );
        if (
          sourceJobs.length === 0 ||
          sourceJobs.length !== replacements.length ||
          sourceJobs.some(
            ({ id, status, shipmentAssignment }) =>
              ![JobStatus.HANDED_OVER, JobStatus.SETTLED].includes(
                status as
                  typeof JobStatus.HANDED_OVER | typeof JobStatus.SETTLED,
              ) ||
              !shipmentAssignment ||
              !predecessorLineageIds.has(shipmentAssignment.shipmentId) ||
              !replacements.some(({ sourceJobId }) => sourceJobId === id),
          )
        ) {
          throw new ConflictException(
            "Parcel reprint requires every original handed-over Job",
          );
        }
        const sourceSlotIds = sourceJobs
          .flatMap(({ phaseResourcePlanJob }) =>
            phaseResourcePlanJob.slots.map(
              ({ fulfilmentSlotId }) => fulfilmentSlotId,
            ),
          )
          .sort();
        if (
          sourceSlotIds.length !== planSlotIds.length ||
          new Set(sourceSlotIds).size !== sourceSlotIds.length ||
          sourceSlotIds.some((slotId, index) => slotId !== planSlotIds[index])
        ) {
          throw new ConflictException(
            "Original Jobs do not form the exact parcel slot partition",
          );
        }
        const nodeIds = new Set(sourceJobs.map(({ nodeId }) => nodeId));
        if (nodeIds.size !== 1) {
          throw new ConflictException(
            "A v0 parcel reprint must be reserved on one production node",
          );
        }
        const now = await databaseNow(tx);
        const commandDigest = createHash("sha256")
          .update(`${claimId}\0${requestedPlanKey ?? key ?? "claim-reprint"}`)
          .digest("hex");
        const successor = await tx.shipment.create({
          data: {
            orderId,
            orderPhaseId: predecessor.orderPhaseId,
            shipmentPlanId: predecessor.shipmentPlanId,
            deliveryDestinationId: predecessor.deliveryDestinationId,
            replacesShipmentId: predecessor.id,
            reprintClaimId: claimId,
          },
        });
        const replacementJobs: Array<{
          sourceJobId: string;
          replacementJobId: string;
          replacementRequestId: string;
          phaseReservationSetId: string;
        }> = [];
        for (const [index, source] of sourceJobs.entries()) {
          const replacementInput = replacements.find(
            ({ sourceJobId }) => sourceJobId === source.id,
          )!;
          const sourcePlanJob = source.phaseResourcePlanJob;
          const candidate = await tx.candidateResourceEstimate.findFirst({
            where: {
              id: {
                equals: replacementInput.candidateResourceEstimateId,
                not: sourcePlanJob.candidateResourceEstimateId,
              },
              nodeId: source.nodeId,
              shipmentPlanId: source.shipmentPlanId,
              modelGeometryId:
                sourcePlanJob.candidateResourceEstimate.modelGeometryId,
              printConfigRevisionId:
                sourcePlanJob.candidateResourceEstimate.printConfigRevisionId,
              quantity: sourcePlanJob.candidateResourceEstimate.quantity,
              calculatedAt: { gte: claim.openedAt },
            },
            include: { capacityIntervals: true },
          });
          if (
            !candidate ||
            candidate.capacityIntervals.length === 0 ||
            candidate.capacityIntervals.some(
              (interval) =>
                interval.startsAt.getTime() <= now.getTime() ||
                interval.endsAt.getTime() > candidate.expiresAt.getTime(),
            )
          ) {
            throw new ConflictException(
              "Parcel reprint requires freshly calculated compatible candidates with future capacity",
            );
          }
          const expiresAt = new Date(
            Math.min(
              candidate.expiresAt.getTime(),
              now.getTime() + 30 * 60 * 1_000,
            ),
          );
          if (expiresAt.getTime() <= now.getTime() + 15 * 60 * 1_000) {
            throw new ConflictException(
              "Parcel reprint candidate is stale; refresh resource estimates",
            );
          }
          const jobDigest = createHash("sha256")
            .update(`${commandDigest}\0${source.id}\0${index}`)
            .digest("hex");
          const slotIds = sourcePlanJob.slots.map(
            ({ fulfilmentSlotId }) => fulfilmentSlotId,
          );
          const snapshot = await tx.eligibilitySnapshot.create({
            data: {
              nodeId: source.nodeId,
              orderPhaseId: source.orderPhaseId,
              requiredFulfilmentSlotIds: slotIds,
              eligibleCandidateEstimateIds: [candidate.id],
              snapshotHash: createHash("sha256")
                .update(`claim-reprint-snapshot\0${jobDigest}`)
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
              planKey: `claim-reprint-plan:${jobDigest}`,
              expiresAt,
            },
          });
          const planJob = await tx.phaseResourcePlanJob.create({
            data: {
              nodeId: source.nodeId,
              phaseResourcePlanId: plan.id,
              candidateResourceEstimateId: candidate.id,
              plannedJobKey: `claim-reprint:${jobDigest}`,
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
          const reservationRows = await tx.$queryRaw<
            Array<{ phase_reservation_set_id: string }>
          >`
            SELECT phase_reservation_set_id
            FROM taven_create_phase_reservation(
              ${source.nodeId}::uuid, ${plan.id}::uuid,
              ${`claim-reprint-reservation:${jobDigest}`}
            )
          `;
          const phaseReservationSetId =
            reservationRows[0]?.phase_reservation_set_id;
          if (!phaseReservationSetId) {
            throw new ConflictException(
              "Parcel reprint reservation was not created",
            );
          }
          const replacementJob = await tx.job.create({
            data: {
              nodeId: source.nodeId,
              orderId,
              orderPhaseId: source.orderPhaseId,
              shipmentPlanId: source.shipmentPlanId,
              phaseResourcePlanJobId: planJob.id,
              replacesJobId: source.id,
            },
          });
          await tx.inventoryReservation.updateMany({
            where: {
              productionReservation: { phaseReservationSetId },
              status: "RESERVED",
            },
            data: { status: "HELD", updatedAt: now },
          });
          await tx.capacityReservation.updateMany({
            where: {
              productionReservation: { phaseReservationSetId },
              status: "RESERVED",
            },
            data: { status: "HELD", updatedAt: now },
          });
          await tx.productionReservation.updateMany({
            where: { phaseReservationSetId },
            data: {
              status: "HELD",
              jobId: replacementJob.id,
              updatedAt: now,
            },
          });
          await tx.phaseReservationSet.update({
            where: { id: phaseReservationSetId },
            data: { status: "HELD", updatedAt: now },
          });
          const request = await tx.replacementRequest.create({
            data: {
              orderId,
              orderPhaseId: source.orderPhaseId,
              shipmentPlanId: source.shipmentPlanId,
              sourceJobId: source.id,
              replacementJobId: replacementJob.id,
              phaseReservationSetId,
              claimId,
              reason: ReplacementRequestReason.SHIPMENT_LOST,
              status: ReplacementRequestStatus.JOB_CREATED,
              deadlineAt: addDays(now, 2),
            },
          });
          const updated = await tx.claimSlotResolution.updateMany({
            where: {
              claimId,
              fulfilmentSlotId: { in: slotIds },
              status: ClaimSlotResolutionStatus.PENDING,
            },
            data: {
              status: ClaimSlotResolutionStatus.REPLACEMENT_PENDING,
              replacementRequestId: request.id,
              replacementShipmentId: successor.id,
            },
          });
          if (updated.count !== slotIds.length) {
            throw new ConflictException(
              "Parcel reprint Job does not match the Claim slot partition",
            );
          }
          replacementJobs.push({
            sourceJobId: source.id,
            replacementJobId: replacementJob.id,
            replacementRequestId: request.id,
            phaseReservationSetId,
          });
        }
        await tx.claim.updateMany({
          where: { id: claimId, status: ClaimStatus.OPEN },
          data: { status: ClaimStatus.ACTIVE },
        });
        return result(orderId, "CLAIM_REPRINT_CREATED", {
          claimId,
          originalShipmentId: rootShipment.id,
          predecessorShipmentId: predecessor.id,
          replacementShipmentId: successor.id,
          replacementJobs,
        });
      },
    );
  }

  handoffReshipment(
    orderId: string,
    claimId: string,
    body: HandoffReshipmentDto,
    key?: string,
  ): Promise<FulfilmentCommandResultDto> {
    assertUuid(claimId, "claimId");
    const carrier = requiredText(body.carrier, "carrier", 100);
    const providerShipmentId = requiredText(
      body.providerShipmentId,
      "providerShipmentId",
      255,
    );
    const carrierLabelId = requiredText(
      body.carrierLabelId,
      "carrierLabelId",
      190,
    );
    const trackingCode = optionalText(body.trackingCode, "trackingCode", 255);
    const reQcEvidence = requiredText(body.reQcEvidence, "reQcEvidence", 500);
    const evidence = providerEvidence(body);
    const custodyConfirmedAt = dateEvidence(
      body.custodyConfirmedAt,
      "custodyConfirmedAt",
    );
    const reQcPassedAt = dateEvidence(body.reQcPassedAt, "reQcPassedAt");
    if (
      custodyConfirmedAt.getTime() >= reQcPassedAt.getTime() ||
      reQcPassedAt.getTime() > evidence.occurredAt.getTime()
    ) {
      throw new BadRequestException(
        "custodyConfirmedAt, reQcPassedAt, and occurredAt must be chronological",
      );
    }
    const input = {
      carrier,
      providerShipmentId,
      carrierLabelId,
      trackingCode: trackingCode ?? null,
      providerEventId: evidence.providerEventId,
      providerTransactionId: evidence.providerTransactionId,
      occurredAt: evidence.occurredAt,
      custodyConfirmedAt,
      reQcPassedAt,
      reQcEvidence,
    };
    return this.command(
      orderId,
      `claim:${claimId}:reshipment-handoff`,
      key,
      input,
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        if (order.status !== OrderStatus.SHIPPED) {
          throw new ConflictException(
            "Custody reshipment requires a shipped Order",
          );
        }
        await tx.$queryRaw`
          SELECT id FROM claims
          WHERE id = ${claimId}::uuid AND order_id = ${orderId}::uuid
          FOR UPDATE
        `;
        const claim = await tx.claim.findFirst({
          where: { id: claimId, orderId },
          include: {
            incidentShipment: true,
            resolutions: {
              include: { replacementShipment: true },
              orderBy: { fulfilmentSlotId: "asc" },
            },
          },
        });
        if (!claim) throw new NotFoundException("Claim was not found");
        const rootShipment = claim.incidentShipment;
        const priorReplacementIds = new Set(
          claim.resolutions.flatMap(({ replacementShipmentId }) =>
            replacementShipmentId ? [replacementShipmentId] : [],
          ),
        );
        const retrying = claim.status === ClaimStatus.ACTIVE;
        const original = retrying
          ? claim.resolutions[0]?.replacementShipment
          : rootShipment;
        const originalAuthorization = original
          ? await tx.reshipmentAuthorization.findUnique({
              where: { reshipmentShipmentId: original.id },
            })
          : null;
        const originalIsReprint = original?.reprintClaimId === claimId;
        const originalIsReship = originalAuthorization?.claimId === claimId;
        if (
          claim.origin !== ClaimOrigin.SHIPMENT_INCIDENT ||
          ![ClaimStatus.OPEN, ClaimStatus.ACTIVE].includes(
            claim.status as typeof ClaimStatus.OPEN | typeof ClaimStatus.ACTIVE,
          ) ||
          !rootShipment ||
          !original ||
          ![ShipmentStatus.RETURNED, ShipmentStatus.RECOVERED].includes(
            original.status as
              typeof ShipmentStatus.RETURNED | typeof ShipmentStatus.RECOVERED,
          ) ||
          (retrying &&
            (priorReplacementIds.size !== 1 ||
              (!originalIsReprint && !originalIsReship)))
        ) {
          throw new ConflictException(
            "Claim does not have custody-confirmed reshipment scope",
          );
        }
        await tx.$queryRaw`
          SELECT id FROM shipments
          WHERE id = ${original.id}::uuid AND order_id = ${orderId}::uuid
          FOR UPDATE
        `;
        await tx.$queryRaw`
          SELECT id FROM claim_slot_resolutions
          WHERE claim_id = ${claimId}::uuid
          ORDER BY id
          FOR UPDATE
        `;
        const successorCount = await tx.shipment.count({
          where: { replacesShipmentId: original.id },
        });
        const planSlots = await tx.shipmentPlanFulfilmentSlot.findMany({
          where: { shipmentPlanId: original.shipmentPlanId },
          select: { fulfilmentSlotId: true },
          orderBy: { fulfilmentSlotId: "asc" },
        });
        const claimedSlotIds = claim.resolutions.map(
          ({ fulfilmentSlotId }) => fulfilmentSlotId,
        );
        const planSlotIds = planSlots.map(
          ({ fulfilmentSlotId }) => fulfilmentSlotId,
        );
        if (
          successorCount !== 0 ||
          planSlotIds.length === 0 ||
          claimedSlotIds.length !== planSlotIds.length ||
          claimedSlotIds.some(
            (slotId, index) => slotId !== planSlotIds[index],
          ) ||
          claim.resolutions.some(
            ({ status, replacementRequestId, replacementShipmentId }) =>
              status !== ClaimSlotResolutionStatus.PENDING ||
              (!retrying &&
                (replacementRequestId !== null ||
                  replacementShipmentId !== null)) ||
              (retrying &&
                (replacementShipmentId !== original.id ||
                  (originalIsReprint && replacementRequestId === null) ||
                  (originalIsReship && replacementRequestId !== null))),
          )
        ) {
          throw new ConflictException(
            "Custody reshipment requires the whole unresolved parcel Claim",
          );
        }
        const pendingSlots = await tx.fulfilmentSlot.count({
          where: { id: { in: claimedSlotIds }, orderId, outcome: "PENDING" },
        });
        if (pendingSlots !== claimedSlotIds.length) {
          throw new ConflictException(
            "Custody reshipment requires unresolved fulfilment slots",
          );
        }
        const originalJobs = await tx.job.findMany({
          where: {
            orderId,
            orderPhaseId: original.orderPhaseId,
            shipmentPlanId: original.shipmentPlanId,
            replacementJob: null,
          },
          include: { shipmentAssignment: true },
          orderBy: { id: "asc" },
        });
        const originalLineageIds = await this.shipmentLineageIds(
          tx,
          original.id,
        );
        if (
          originalJobs.length === 0 ||
          originalJobs.some(
            ({ status, shipmentAssignment }) =>
              ![JobStatus.HANDED_OVER, JobStatus.SETTLED].includes(
                status as
                  typeof JobStatus.HANDED_OVER | typeof JobStatus.SETTLED,
              ) ||
              !shipmentAssignment ||
              !originalLineageIds.has(shipmentAssignment.shipmentId),
          )
        ) {
          throw new ConflictException(
            "Custody reshipment requires the original handed-over Job scope",
          );
        }
        const claimFinancialWork = await tx.refundTransaction.count({
          where: { claimId },
        });
        const claimAdjustments = await tx.priceAdjustment.count({
          where: { claimId },
        });
        const activeRefunds = await tx.refundTransaction.count({
          where: {
            payment: { orderId },
            status: { in: ["PENDING", "SUSPENDED"] },
          },
        });
        if (
          claimFinancialWork > 0 ||
          claimAdjustments > 0 ||
          activeRefunds > 0
        ) {
          throw new ConflictException(
            "Custody reshipment requires settled financial recovery",
          );
        }
        const reshipment = await tx.shipment.create({
          data: {
            orderId,
            orderPhaseId: original.orderPhaseId,
            shipmentPlanId: original.shipmentPlanId,
            deliveryDestinationId: original.deliveryDestinationId,
            replacesShipmentId: original.id,
          },
        });
        const verifiedAt = await databaseNow(tx);
        if (
          custodyConfirmedAt.getTime() > verifiedAt.getTime() ||
          reQcPassedAt.getTime() > verifiedAt.getTime() ||
          evidence.occurredAt.getTime() > verifiedAt.getTime() + 5_000
        ) {
          throw new ConflictException(
            "Custody, re-QC, and carrier evidence cannot be in the future",
          );
        }
        await tx.shipment.update({
          where: { id: reshipment.id },
          data: {
            status: ShipmentStatus.LABEL_CREATED,
            carrier,
            providerShipmentId,
            carrierLabelId,
            trackingCode: trackingCode ?? null,
            labelCreatedAt: verifiedAt,
          },
        });
        const acceptanceEvent = await tx.shipmentProviderEvent.create({
          data: {
            shipmentId: reshipment.id,
            carrier,
            carrierLabelId,
            providerEventId: evidence.providerEventId,
            providerTransactionId: evidence.providerTransactionId,
            kind: ShipmentProviderEventKind.ACCEPTANCE_SCAN,
            sourceShipmentStatus: ShipmentStatus.LABEL_CREATED,
            occurredAt: evidence.occurredAt,
            authenticatedAt: verifiedAt,
            verifiedAt,
          },
        });
        const authorization = await tx.reshipmentAuthorization.create({
          data: {
            orderId,
            orderPhaseId: original.orderPhaseId,
            shipmentPlanId: original.shipmentPlanId,
            deliveryDestinationId: original.deliveryDestinationId,
            claimId,
            originalShipmentId: original.id,
            reshipmentShipmentId: reshipment.id,
            acceptanceEventId: acceptanceEvent.id,
            custodyConfirmedAt,
            reQcPassedAt,
            reQcEvidence,
            issuedAt: verifiedAt,
            consumedAt: verifiedAt,
          },
        });
        await tx.claimSlotResolution.updateMany({
          where: { claimId, status: ClaimSlotResolutionStatus.PENDING },
          data: {
            status: ClaimSlotResolutionStatus.RESHIP_PENDING,
            replacementRequestId: null,
            replacementShipmentId: reshipment.id,
          },
        });
        await tx.claim.updateMany({
          where: { id: claimId, status: ClaimStatus.OPEN },
          data: { status: ClaimStatus.ACTIVE },
        });
        await tx.shipment.update({
          where: { id: reshipment.id },
          data: {
            status: ShipmentStatus.HANDED_OVER,
            providerAcceptanceScanId: evidence.providerEventId,
            handedOverAt: verifiedAt,
          },
        });
        return result(orderId, "CLAIM_RESHIPMENT_HANDED_OVER", {
          claimId,
          authorizationId: authorization.id,
          originalShipmentId: rootShipment.id,
          predecessorShipmentId: original.id,
          reshipmentShipmentId: reshipment.id,
          handedOverAt: verifiedAt,
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
    const requestedSlotCredits = priceAdjustmentSlotCredits(
      body.allocation,
      reason !== PriceAdjustmentReason.EXPRESS_BREACH,
    );
    const allocatedAmount = requestedSlotCredits.reduce(
      (total, credit) => total + credit.amountMinor,
      0n,
    );
    if (requestedSlotCredits.length > 0 && allocatedAmount !== amountMinor) {
      throw new BadRequestException(
        "allocation slotCredits must sum to amountMinor",
      );
    }
    const requestedAllocation = {
      ...body.allocation,
      ...(requestedSlotCredits.length > 0
        ? {
            slotCredits: requestedSlotCredits.map((credit) => ({
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
        allocation: requestedAllocation,
      },
      async (tx) => {
        await this.lockOrder(tx, orderId);
        const slotCredits =
          reason === PriceAdjustmentReason.EXPRESS_BREACH
            ? await this.expressAdjustmentSlotCredits(
                tx,
                orderId,
                amountMinor,
                requestedSlotCredits,
              )
            : requestedSlotCredits;
        const allocation = {
          ...body.allocation,
          slotCredits: slotCredits.map((credit) => ({
            fulfilmentSlotId: credit.fulfilmentSlotId,
            amountMinor: credit.amountMinor.toString(),
          })),
        };
        if (slotCredits.length > 0) {
          const ownedSlots = await tx.fulfilmentSlot.findMany({
            where: {
              orderId,
              id: {
                in: slotCredits.map(({ fulfilmentSlotId }) => fulfilmentSlotId),
              },
            },
            select: { id: true, settlementAmountMinor: true },
          });
          if (ownedSlots.length !== slotCredits.length) {
            throw new NotFoundException(
              "Price adjustment fulfilment slot was not found",
            );
          }
          const priorAdjustments = await tx.priceAdjustment.findMany({
            where: { orderId },
            select: { allocation: true },
          });
          const priorCredits = new Map<string, bigint>();
          for (const priorAdjustment of priorAdjustments) {
            for (const credit of priceAdjustmentSlotCredits(
              priorAdjustment.allocation,
              false,
            )) {
              priorCredits.set(
                credit.fulfilmentSlotId,
                (priorCredits.get(credit.fulfilmentSlotId) ?? 0n) +
                  credit.amountMinor,
              );
            }
          }
          const settlementBySlot = new Map(
            ownedSlots.map((slot) => [slot.id, slot.settlementAmountMinor]),
          );
          if (
            slotCredits.some(
              (credit) =>
                (priorCredits.get(credit.fulfilmentSlotId) ?? 0n) +
                  credit.amountMinor >
                settlementBySlot.get(credit.fulfilmentSlotId)!,
            )
          ) {
            throw new ConflictException(
              "Price adjustment exceeds a fulfilment Slot settlement amount",
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
              include: { fulfilmentSlot: true, replacementShipment: true },
              orderBy: { fulfilmentSlotId: "asc" },
            },
            reshipmentAuthorizations: {
              include: { reshipmentShipment: true },
              orderBy: { consumedAt: "desc" },
            },
          },
        });
        if (!claim) throw new NotFoundException("Claim was not found");
        const currentReplacementShipmentIds = new Set(
          claim.resolutions.flatMap(({ replacementShipmentId }) =>
            replacementShipmentId ? [replacementShipmentId] : [],
          ),
        );
        const currentReshipmentAuthorization =
          currentReplacementShipmentIds.size === 1
            ? claim.reshipmentAuthorizations.find(({ reshipmentShipmentId }) =>
                currentReplacementShipmentIds.has(reshipmentShipmentId),
              )
            : undefined;
        const reshipmentIncidentRefundable =
          claim.status === ClaimStatus.ACTIVE &&
          currentReshipmentAuthorization !== undefined &&
          [
            ShipmentStatus.LOST,
            ShipmentStatus.RETURNED,
            ShipmentStatus.RECOVERED,
          ].includes(
            currentReshipmentAuthorization.reshipmentShipment.status as
              | typeof ShipmentStatus.LOST
              | typeof ShipmentStatus.RETURNED
              | typeof ShipmentStatus.RECOVERED,
          );
        const reprintIncidentRefundable =
          claim.status === ClaimStatus.ACTIVE &&
          claim.resolutions.length > 0 &&
          claim.resolutions.every(
            ({ replacementRequestId, replacementShipment }) =>
              replacementRequestId !== null &&
              replacementShipment !== null &&
              [
                ShipmentStatus.LOST,
                ShipmentStatus.RETURNED,
                ShipmentStatus.RECOVERED,
              ].includes(
                replacementShipment.status as
                  | typeof ShipmentStatus.LOST
                  | typeof ShipmentStatus.RETURNED
                  | typeof ShipmentStatus.RECOVERED,
              ),
          );
        const cancelledReprintShipmentIds = [
          ...new Set(
            claim.resolutions.flatMap(({ replacementShipment }) =>
              replacementShipment?.status === ShipmentStatus.CANCELLED
                ? [replacementShipment.id]
                : [],
            ),
          ),
        ];
        let failedReprintRefundable = false;
        if (
          claim.status === ClaimStatus.ACTIVE &&
          claim.resolutions.length > 0 &&
          cancelledReprintShipmentIds.length === 1 &&
          claim.resolutions.every(
            ({ replacementRequestId, replacementShipment }) =>
              replacementRequestId !== null &&
              replacementShipment?.id === cancelledReprintShipmentIds[0],
          )
        ) {
          const cancelledShipment = claim.resolutions[0]!.replacementShipment!;
          const currentJobs = await tx.job.findMany({
            where: {
              orderId,
              shipmentPlanId: cancelledShipment.shipmentPlanId,
              replacementJob: null,
            },
            include: { replacementRequestSource: true },
          });
          failedReprintRefundable =
            currentJobs.length > 0 &&
            currentJobs.some(
              ({ status, replacementRequestSource }) =>
                [JobStatus.FAILED, JobStatus.QC_REJECTED].includes(
                  status as
                    typeof JobStatus.FAILED | typeof JobStatus.QC_REJECTED,
                ) &&
                replacementRequestSource?.status ===
                  ReplacementRequestStatus.REFUND_REQUIRED,
            ) &&
            currentJobs.every(
              ({ status, cancellationReason }) =>
                [JobStatus.FAILED, JobStatus.QC_REJECTED].includes(
                  status as
                    typeof JobStatus.FAILED | typeof JobStatus.QC_REJECTED,
                ) ||
                (status === JobStatus.CANCELLED &&
                  cancellationReason ===
                    JobCancellationReason.PRODUCTION_FAILURE),
            );
        }
        if (
          (claim.status !== ClaimStatus.OPEN &&
            !reshipmentIncidentRefundable &&
            !reprintIncidentRefundable &&
            !failedReprintRefundable) ||
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
        if (failedReprintRefundable) {
          await tx.replacementRequest.updateMany({
            where: {
              orderId,
              status: ReplacementRequestStatus.REFUND_REQUIRED,
              sourceJob: {
                shipmentPlanId:
                  claim.resolutions[0]!.replacementShipment!.shipmentPlanId,
                replacementJob: null,
              },
            },
            data: {
              status: ReplacementRequestStatus.RESOLVED,
              resolvedAt: at,
            },
          });
        }
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
        const activePrinting = await this.activePrintingReservations(
          tx,
          orderId,
        );
        assertPrintingConsumptionCoverage(
          activePrinting,
          printingConsumptions,
          false,
        );
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
        if (order.status === OrderStatus.QC_PASSED) {
          await tx.orderPhase.updateMany({
            where: {
              orderId,
              status: OrderPhaseStatus.QC_PASSED,
            },
            data: { status: OrderPhaseStatus.RECOVERY_PENDING },
          });
          await tx.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.RECOVERY_PENDING, updatedAt: at },
          });
        }
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

  private async cancelProductionFailureParcelSiblings(
    tx: Transaction,
    orderId: string,
    shipmentPlanId: string,
    failedJobId: string,
    cancelledAt: Date,
    printingConsumptions: Map<string, bigint>,
  ): Promise<void> {
    const siblings = await tx.job.findMany({
      where: {
        orderId,
        shipmentPlanId,
        id: { not: failedJobId },
        replacementJob: null,
      },
      include: {
        productionReservations: {
          select: { id: true, status: true },
        },
      },
      orderBy: { id: "asc" },
    });
    const printingSiblings: Array<{ jobId: string }> = [];
    for (const sibling of siblings) {
      if (
        [
          JobStatus.HANDED_OVER,
          JobStatus.SETTLED,
          JobStatus.CANCELLED,
          JobStatus.FAILED,
          JobStatus.QC_REJECTED,
        ].includes(
          sibling.status as
            | typeof JobStatus.HANDED_OVER
            | typeof JobStatus.SETTLED
            | typeof JobStatus.CANCELLED
            | typeof JobStatus.FAILED
            | typeof JobStatus.QC_REJECTED,
        ) ||
        sibling.productionReservations.length !== 1
      ) {
        throw new ConflictException(
          "Production failure cannot abandon an ambiguous parcel Job scope",
        );
      }
      const production = sibling.productionReservations[0]!;
      if (production.status === "PRINTING") {
        printingSiblings.push({ jobId: sibling.id });
      } else if (
        !["RESERVED", "HELD", "SCHEDULED", "CONSUMED"].includes(
          production.status,
        )
      ) {
        throw new ConflictException(
          "Production failure sibling Job reservation is not terminal",
        );
      }
    }
    assertPrintingConsumptionCoverage(
      printingSiblings,
      printingConsumptions,
      false,
    );
    for (const sibling of siblings) {
      const production = sibling.productionReservations[0]!;
      if (production.status === "PRINTING") {
        await tx.$queryRaw`
          SELECT taven_settle_printing_production_reservation(
            ${production.id}::uuid,
            ${printingConsumptions.get(sibling.id)!}
          )::text
        `;
      }
      if (["RESERVED", "HELD", "SCHEDULED"].includes(production.status)) {
        await tx.$queryRaw`
          SELECT taven_release_production_reservation_before_print(
            ${production.id}::uuid
          )::text
        `;
      }
      await tx.job.update({
        where: { id: sibling.id },
        data: {
          status: JobStatus.CANCELLED,
          cancelledAt,
          cancellationReason: JobCancellationReason.PRODUCTION_FAILURE,
        },
      });
    }
  }

  private async prepareClaimReprintFailureRefund(
    tx: Transaction,
    orderId: string,
    job: { orderPhaseId: string; shipmentPlanId: string },
    failedJobId: string,
    claimId: string,
    failedAt: Date,
    printingConsumptions: Map<string, bigint>,
  ): Promise<{ status: string; shipmentId: string }> {
    await tx.$queryRaw`
      SELECT id FROM claims
      WHERE id = ${claimId}::uuid AND order_id = ${orderId}::uuid
      FOR UPDATE
    `;
    const resolutions = await tx.claimSlotResolution.findMany({
      where: {
        claimId,
        status: ClaimSlotResolutionStatus.REPLACEMENT_PENDING,
      },
      select: { replacementShipmentId: true },
    });
    const replacementShipmentIds = new Set(
      resolutions.flatMap(({ replacementShipmentId }) =>
        replacementShipmentId ? [replacementShipmentId] : [],
      ),
    );
    const resolutionCount = await tx.claimSlotResolution.count({
      where: { claimId },
    });
    if (
      resolutions.length === 0 ||
      resolutions.length !== resolutionCount ||
      replacementShipmentIds.size !== 1
    ) {
      throw new ConflictException(
        "Failed Claim reprint does not own the complete parcel remedy",
      );
    }
    const shipmentId = [...replacementShipmentIds][0]!;
    const shipment = await tx.shipment.findFirst({
      where: {
        id: shipmentId,
        orderId,
        orderPhaseId: job.orderPhaseId,
        shipmentPlanId: job.shipmentPlanId,
        reprintClaimId: claimId,
      },
    });
    if (
      !shipment ||
      ![ShipmentStatus.PLANNED, ShipmentStatus.LABEL_CREATED].includes(
        shipment.status as
          typeof ShipmentStatus.PLANNED | typeof ShipmentStatus.LABEL_CREATED,
      )
    ) {
      throw new ConflictException(
        "Failed Claim reprint parcel is not recoverable before handoff",
      );
    }
    await this.cancelProductionFailureParcelSiblings(
      tx,
      orderId,
      job.shipmentPlanId,
      failedJobId,
      failedAt,
      printingConsumptions,
    );
    if (shipment.status === ShipmentStatus.LABEL_CREATED) {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: ShipmentStatus.CANCELLATION_PENDING,
          cancellationRequestedAt: failedAt,
        },
      });
      return {
        status: "CLAIM_REPRINT_LABEL_CANCELLATION_PENDING",
        shipmentId,
      };
    }
    await tx.shipment.update({
      where: { id: shipment.id },
      data: { status: ShipmentStatus.CANCELLED, cancelledAt: failedAt },
    });
    await tx.fulfilmentSlot.updateMany({
      where: {
        orderId,
        outcome: "PENDING",
        shipmentPlanAllocations: {
          some: { shipmentPlanId: shipment.shipmentPlanId },
        },
      },
      data: { outcome: "CANCELLED", updatedAt: failedAt },
    });
    await tx.claimSlotResolution.updateMany({
      where: {
        claimId,
        replacementShipmentId: shipmentId,
        status: ClaimSlotResolutionStatus.REPLACEMENT_PENDING,
      },
      data: {
        status: ClaimSlotResolutionStatus.PENDING,
        updatedAt: failedAt,
      },
    });
    return { status: "CLAIM_REPRINT_REFUND_REQUIRED", shipmentId };
  }

  private async reconcileCancelledShipmentHandoff(
    tx: Transaction,
    orderId: string,
    shipment: {
      id: string;
      orderPhaseId: string;
      shipmentPlanId: string;
      deliveryDestinationId: string;
      cancellationRequestedAt: Date | null;
    },
    voidEvent: { id: string },
    acceptanceEventId: string,
    providerAcceptanceScanId: string,
    reconciledAt: Date,
  ): Promise<void> {
    if (!shipment.cancellationRequestedAt) {
      throw new ConflictException(
        "Cancelled Shipment has no cancellation request evidence",
      );
    }
    const currentJobs = await tx.job.findMany({
      where: {
        orderId,
        shipmentPlanId: shipment.shipmentPlanId,
        replacementJob: null,
      },
      select: { status: true },
    });
    if (
      currentJobs.length === 0 ||
      currentJobs.some(({ status }) => status !== JobStatus.CANCELLED)
    ) {
      throw new ConflictException(
        "Failed production cancellation requires exact manual handoff reconciliation",
      );
    }
    const shipmentSlotIds = new Set(
      (
        await tx.fulfilmentSlot.findMany({
          where: {
            orderId,
            shipmentPlanAllocations: {
              some: { shipmentPlanId: shipment.shipmentPlanId },
            },
          },
          select: { id: true },
        })
      ).map(({ id }) => id),
    );
    const partialCancellationAdjustments = await tx.priceAdjustment.findMany({
      where: {
        orderId,
        reason: PriceAdjustmentReason.CUSTOMER_CANCELLATION,
      },
      select: { allocation: true },
    });
    if (
      partialCancellationAdjustments.some(({ allocation }) =>
        priceAdjustmentSlotCredits(allocation, false).some(
          ({ fulfilmentSlotId }) => shipmentSlotIds.has(fulfilmentSlotId),
        ),
      )
    ) {
      throw new ConflictException(
        "Partially cancelled Shipment requires exact manual financial reconciliation before handoff",
      );
    }
    const productionFailureRefunds = await tx.refundTransaction.count({
      where: {
        payment: { orderId },
        reason: RefundReason.PRODUCTION_FAILURE,
      },
    });
    if (productionFailureRefunds > 0) {
      throw new ConflictException(
        "Production failure refund requires exact manual financial reconciliation before handoff",
      );
    }
    const currentShipments = await tx.shipment.count({
      where: { orderId, replacementShipment: null },
    });
    if (currentShipments !== 1) {
      throw new ConflictException(
        "Multi-parcel cancelled Shipment requires exact manual handoff reconciliation",
      );
    }
    const cancellationRefunds = await tx.refundTransaction.findMany({
      where: {
        payment: { orderId },
        reason: RefundReason.CUSTOMER_CANCELLATION,
        status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] },
      },
      include: {
        payment: {
          include: {
            priceSnapshot: true,
            refunds: {
              where: { status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] } },
              select: { amountMinor: true, status: true, completedAt: true },
            },
          },
        },
        providerResultEvent: true,
      },
      orderBy: { requestedAt: "asc" },
    });
    const succeededRefunds = cancellationRefunds.filter(
      ({ status }) => status === "SUCCEEDED",
    );

    let refundedReconciliation:
      | {
          settlementId: string;
          paymentId: string;
          refundTransactionId: string;
          refundProviderEventId: string;
        }
      | undefined;
    if (succeededRefunds.length > 0) {
      const refund = succeededRefunds[0]!;
      const payment = refund.payment;
      const succeededPaymentRefunds = payment.refunds.filter(
        ({ status }) => status === "SUCCEEDED",
      );
      const succeededRefundTotal = succeededPaymentRefunds.reduce(
        (total, succeededRefund) => total + succeededRefund.amountMinor,
        0n,
      );
      if (
        succeededRefunds.length !== 1 ||
        cancellationRefunds.some(
          ({ status }) => status === "PENDING" || status === "SUSPENDED",
        ) ||
        payment.status !== "REFUNDED" ||
        payment.capturedAmountMinor === null ||
        !payment.capturedAt ||
        payment.capturedAt.getTime() >= reconciledAt.getTime() ||
        payment.refunds.some(({ status }) => status !== "SUCCEEDED") ||
        succeededRefundTotal !== payment.capturedAmountMinor ||
        succeededPaymentRefunds.some(
          ({ completedAt }) =>
            !completedAt || completedAt.getTime() > reconciledAt.getTime(),
        ) ||
        !refund.completedAt ||
        !refund.providerResultEventId ||
        !refund.providerResultEvent
      ) {
        throw new ConflictException(
          "Refunded cancellation requires exact manual financial reconciliation",
        );
      }
      const fullyRefundedAt = new Date(
        Math.max(
          ...succeededPaymentRefunds.map(({ completedAt }) =>
            completedAt!.getTime(),
          ),
        ),
      );
      const capturedPayments = await tx.payment.count({
        where: {
          orderId,
          capturedAmountMinor: { gt: 0n },
          capturedAt: { lt: reconciledAt },
        },
      });
      if (capturedPayments !== 1) {
        throw new ConflictException(
          "Refunded cancellation requires exact manual financial reconciliation",
        );
      }
      await tx.fulfilmentSlot.updateMany({
        where: { orderId, outcome: "CANCELLED" },
        data: {
          outcome: "CANCELLED_REFUNDED",
          updatedAt: fullyRefundedAt,
        },
      });
      await tx.orderPhase.updateMany({
        where: { orderId, status: OrderPhaseStatus.CANCELLED },
        data: { status: OrderPhaseStatus.CANCELLED_REFUNDED },
      });
      await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.CANCELLED },
        data: { status: OrderStatus.REFUNDED, updatedAt: fullyRefundedAt },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          captureAuthorized: false,
          captureCutoffAt: reconciledAt,
          updatedAt: reconciledAt,
        },
      });
      const settlement = await tx.orderSettlement.create({
        data: {
          orderId,
          orderPhaseId: shipment.orderPhaseId,
          orderPriceBindingId: payment.orderPriceBindingId,
          priceSnapshotId: payment.priceSnapshotId,
          paymentId: payment.id,
          refundTransactionId: refund.id,
          kind: "UNAUTHORIZED_HANDOFF",
          currency: payment.currency,
          contractTotalMinor: payment.priceSnapshot.contractTotalMinor,
          capturedTotalMinor: payment.capturedAmountMinor,
          earnedAmountMinor: 0n,
          retainedAmountMinor: 0n,
          refundAmountMinor: succeededRefundTotal,
          writtenOffAmountMinor: 0n,
          unearnedCancelledAmountMinor:
            payment.priceSnapshot.contractTotalMinor,
          amountDueMinor: 0n,
          refundableBalanceMinor: 0n,
          cutoffAt: reconciledAt,
          settledAt: reconciledAt,
        },
      });
      refundedReconciliation = {
        settlementId: settlement.id,
        paymentId: payment.id,
        refundTransactionId: refund.id,
        refundProviderEventId: refund.providerResultEventId,
      };
    } else {
      const pendingRefunds = cancellationRefunds.filter(
        ({ status }) => status === "PENDING",
      );
      if (
        pendingRefunds.some(
          ({ replacesRefundTransactionId }) =>
            replacesRefundTransactionId !== null,
        ) ||
        cancellationRefunds.some(({ status }) => status === "SUSPENDED") ||
        pendingRefunds.some(
          ({ dispatchClaimedAt, providerRefundId, providerResultEventId }) =>
            dispatchClaimedAt !== null ||
            providerRefundId !== null ||
            providerResultEventId !== null,
        )
      ) {
        throw new ConflictException(
          "Retried or dispatched cancellation refund must reach an exact provider outcome before handoff reconciliation",
        );
      }
      if (pendingRefunds.length > 0) {
        await tx.refundTransaction.updateMany({
          where: { id: { in: pendingRefunds.map(({ id }) => id) } },
          data: { status: "SUPERSEDED", updatedAt: reconciledAt },
        });
      }
      const paymentIds = [
        ...new Set(pendingRefunds.map(({ paymentId }) => paymentId)),
      ];
      for (const paymentId of paymentIds) {
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          select: { capturedAmountMinor: true },
        });
        const refunds = await tx.refundTransaction.findMany({
          where: { paymentId },
          select: { amountMinor: true, status: true },
        });
        const succeeded = refunds.reduce(
          (total, refund) =>
            total + (refund.status === "SUCCEEDED" ? refund.amountMinor : 0n),
          0n,
        );
        const hasPending = refunds.some(
          ({ status }) => status === "PENDING" || status === "SUSPENDED",
        );
        const captured = payment.capturedAmountMinor ?? 0n;
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: hasPending
              ? "REFUND_PENDING"
              : succeeded === 0n
                ? "CAPTURED"
                : succeeded === captured
                  ? "REFUNDED"
                  : "PARTIALLY_REFUNDED",
            updatedAt: reconciledAt,
          },
        });
      }
    }

    if (refundedReconciliation) {
      await tx.handoffReconciliation.create({
        data: {
          orderId,
          orderPhaseId: shipment.orderPhaseId,
          shipmentId: shipment.id,
          shipmentPlanId: shipment.shipmentPlanId,
          deliveryDestinationId: shipment.deliveryDestinationId,
          acceptanceEventId,
          voidEventId: voidEvent.id,
          paymentId: refundedReconciliation.paymentId,
          refundTransactionId: refundedReconciliation.refundTransactionId,
          refundProviderEventId: refundedReconciliation.refundProviderEventId,
          orderSettlementId: refundedReconciliation.settlementId,
          status: "COMPLETED",
          cancellationRequestedAt: shipment.cancellationRequestedAt,
          reconciledAt,
        },
      });
    }

    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        status: ShipmentStatus.HANDED_OVER,
        providerAcceptanceScanId,
        handedOverAt: reconciledAt,
      },
    });
    await tx.fulfilmentSlot.updateMany({
      where: {
        outcome: { in: ["CANCELLED", "CANCELLED_REFUNDED"] },
        shipmentPlanAllocations: {
          some: { shipmentPlanId: shipment.shipmentPlanId },
        },
      },
      data: { outcome: "PENDING", updatedAt: reconciledAt },
    });
    await tx.job.updateMany({
      where: {
        orderId,
        orderPhaseId: shipment.orderPhaseId,
        shipmentPlanId: shipment.shipmentPlanId,
        status: JobStatus.CANCELLED,
        replacementJob: null,
      },
      data: { status: JobStatus.HANDED_OVER, handedOverAt: reconciledAt },
    });
    await tx.orderPhase.update({
      where: { id: shipment.orderPhaseId },
      data: { status: OrderPhaseStatus.SHIPPED, shippedAt: reconciledAt },
    });
    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.SHIPPED, updatedAt: reconciledAt },
    });
  }

  private async finalizePostHandoffProductionFailureRefund(
    tx: Transaction,
    orderId: string,
    shipmentPlanId: string,
    replacementRequestId: string,
    at: Date,
    key: string,
  ): Promise<string[]> {
    const request = await tx.replacementRequest.findFirst({
      where: {
        id: replacementRequestId,
        orderId,
        shipmentPlanId,
        status: ReplacementRequestStatus.REFUND_REQUIRED,
      },
      include: {
        sourceJob: {
          include: {
            phaseResourcePlanJob: {
              include: { slots: true },
            },
          },
        },
      },
    });
    if (
      !request ||
      ![JobStatus.FAILED, JobStatus.QC_REJECTED].includes(
        request.sourceJob.status as
          typeof JobStatus.FAILED | typeof JobStatus.QC_REJECTED,
      )
    ) {
      throw new ConflictException(
        "Production failure refund obligation is not active",
      );
    }
    const currentJobs = await tx.job.findMany({
      where: { orderId, shipmentPlanId, replacementJob: null },
      include: {
        phaseResourcePlanJob: {
          include: { slots: true },
        },
      },
      orderBy: { id: "asc" },
    });
    const planSlotIds = (
      await tx.shipmentPlanFulfilmentSlot.findMany({
        where: { shipmentPlanId },
        select: { fulfilmentSlotId: true },
        orderBy: { fulfilmentSlotId: "asc" },
      })
    ).map(({ fulfilmentSlotId }) => fulfilmentSlotId);
    const jobSlotIds = currentJobs
      .flatMap(({ phaseResourcePlanJob }) =>
        phaseResourcePlanJob.slots.map(
          ({ fulfilmentSlotId }) => fulfilmentSlotId,
        ),
      )
      .sort();
    const shipment = await tx.shipment.findFirst({
      where: {
        orderId,
        shipmentPlanId,
        status: ShipmentStatus.CANCELLED,
        replacementShipment: null,
      },
    });
    if (
      !shipment ||
      currentJobs.length === 0 ||
      !currentJobs.some(({ id }) => id === request.sourceJobId) ||
      currentJobs.some(
        ({ id, status, cancellationReason }) =>
          (id === request.sourceJobId &&
            ![JobStatus.FAILED, JobStatus.QC_REJECTED].includes(
              status as typeof JobStatus.FAILED | typeof JobStatus.QC_REJECTED,
            )) ||
          (id !== request.sourceJobId &&
            (status !== JobStatus.CANCELLED ||
              cancellationReason !== JobCancellationReason.PRODUCTION_FAILURE)),
      ) ||
      planSlotIds.length === 0 ||
      planSlotIds.length !== jobSlotIds.length ||
      new Set(jobSlotIds).size !== jobSlotIds.length ||
      planSlotIds.some((slotId, index) => slotId !== jobSlotIds[index])
    ) {
      throw new ConflictException(
        "Production failure refund requires one exact whole-parcel scope",
      );
    }
    const slots = await tx.fulfilmentSlot.findMany({
      where: { id: { in: planSlotIds }, orderId, outcome: "PENDING" },
      select: { id: true, settlementAmountMinor: true },
      orderBy: { id: "asc" },
    });
    if (slots.length !== planSlotIds.length) {
      throw new ConflictException(
        "Production failure refund requires pending parcel slots",
      );
    }
    const priorAdjustments = await tx.priceAdjustment.findMany({
      where: { orderId },
      include: {
        refunds: {
          where: { status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] } },
          select: { amountMinor: true },
        },
      },
    });
    const creditedBySlot = new Map<string, bigint>();
    for (const adjustment of priorAdjustments) {
      for (const credit of priceAdjustmentSlotCredits(
        adjustment.allocation,
        false,
      )) {
        creditedBySlot.set(
          credit.fulfilmentSlotId,
          (creditedBySlot.get(credit.fulfilmentSlotId) ?? 0n) +
            credit.amountMinor,
        );
      }
    }
    const slotCredits = slots.flatMap((slot) => {
      const remaining =
        slot.settlementAmountMinor - (creditedBySlot.get(slot.id) ?? 0n);
      if (remaining < 0n) {
        throw new ConflictException(
          "Prior credits exceed a failed fulfilment Slot value",
        );
      }
      return remaining === 0n
        ? []
        : [{ fulfilmentSlotId: slot.id, amountMinor: remaining }];
    });
    const amountMinor = slotCredits.reduce(
      (total, credit) => total + credit.amountMinor,
      0n,
    );
    if (amountMinor <= 0n) {
      throw new ConflictException(
        "Production failure parcel has no refundable contract value",
      );
    }
    const payments = await tx.payment.findMany({
      where: { orderId, capturedAmountMinor: { not: null } },
      include: {
        refunds: {
          where: { status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] } },
        },
      },
      orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
    });
    const currency = payments[0]?.currency;
    if (
      !currency ||
      payments.some((payment) => payment.currency !== currency)
    ) {
      throw new ConflictException(
        "Production failure payment currency is unavailable",
      );
    }
    const reservedAdjustments = priorAdjustments.reduce((total, adjustment) => {
      const committed = adjustment.refunds.reduce(
        (sum, refund) => sum + refund.amountMinor,
        0n,
      );
      const outstanding = adjustment.amountMinor - committed;
      return total + (outstanding > 0n ? outstanding : 0n);
    }, 0n);
    const available =
      payments.reduce(
        (total, payment) =>
          total +
          payment.capturedAmountMinor! -
          payment.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n),
        0n,
      ) - reservedAdjustments;
    if (available < amountMinor) {
      throw new ConflictException(
        "Production failure refund exceeds the refundable balance",
      );
    }
    const adjustment = await tx.priceAdjustment.create({
      data: {
        orderId,
        idempotencyKey: persistenceKey(
          "production-failure-adjustment",
          orderId,
          replacementRequestId,
          key,
        ),
        reason: PriceAdjustmentReason.PRODUCTION_FAILURE,
        amountMinor,
        currency,
        allocation: {
          shipmentPlanId,
          replacementRequestId,
          slotCredits: slotCredits.map((credit) => ({
            fulfilmentSlotId: credit.fulfilmentSlotId,
            amountMinor: credit.amountMinor.toString(),
          })),
        },
      },
    });
    await tx.fulfilmentSlot.updateMany({
      where: { id: { in: planSlotIds } },
      data: { outcome: "CANCELLED", updatedAt: at },
    });
    await tx.replacementRequest.update({
      where: { id: request.id },
      data: {
        status: ReplacementRequestStatus.RESOLVED,
        resolvedAt: at,
      },
    });
    let remaining = amountMinor;
    let unboundReserved = priorAdjustments.reduce((total, prior) => {
      if (prior.paymentId) return total;
      const committed = prior.refunds.reduce(
        (sum, refund) => sum + refund.amountMinor,
        0n,
      );
      const outstanding = prior.amountMinor - committed;
      return total + (outstanding > 0n ? outstanding : 0n);
    }, 0n);
    const refundIds: string[] = [];
    for (const payment of payments) {
      if (remaining === 0n) break;
      const allocated = payment.refunds.reduce(
        (sum, refund) => sum + refund.amountMinor,
        0n,
      );
      const selectedReserved = priorAdjustments.reduce((total, prior) => {
        if (prior.paymentId !== payment.id) return total;
        const committed = prior.refunds.reduce(
          (sum, refund) => sum + refund.amountMinor,
          0n,
        );
        const outstanding = prior.amountMinor - committed;
        return total + (outstanding > 0n ? outstanding : 0n);
      }, 0n);
      let paymentAvailable =
        payment.capturedAmountMinor! - allocated - selectedReserved;
      const unboundForPayment =
        paymentAvailable <= 0n
          ? 0n
          : paymentAvailable < unboundReserved
            ? paymentAvailable
            : unboundReserved;
      paymentAvailable -= unboundForPayment;
      unboundReserved -= unboundForPayment;
      if (paymentAvailable <= 0n) continue;
      const refundAmount =
        paymentAvailable < remaining ? paymentAvailable : remaining;
      const refund = await tx.refundTransaction.create({
        data: {
          paymentId: payment.id,
          priceAdjustmentId: adjustment.id,
          provider: payment.provider,
          idempotencyKey: persistenceKey(
            "production-failure-refund",
            adjustment.id,
            key,
            payment.id,
          ),
          amountMinor: refundAmount,
          reason: RefundReason.PRODUCTION_FAILURE,
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
    if (remaining !== 0n) {
      throw new ConflictException(
        "Production failure refund allocation is incomplete",
      );
    }
    return refundIds;
  }

  private async finalizePartialCancellation(
    tx: Transaction,
    orderId: string,
    shipmentPlanId: string,
    at: Date,
    key: string,
  ): Promise<string[]> {
    const jobs = await tx.job.findMany({
      where: {
        orderId,
        shipmentPlanId,
        replacementJob: null,
        status: JobStatus.PACKED,
      },
      select: { id: true },
    });
    if (jobs.length === 0) {
      throw new ConflictException(
        "Partially cancelled Shipment has no packed Job scope",
      );
    }
    await tx.job.updateMany({
      where: { id: { in: jobs.map(({ id }) => id) } },
      data: {
        status: JobStatus.CANCELLED,
        cancelledAt: at,
        cancellationReason: "ORDER_CANCELLED",
      },
    });
    const slots = await tx.fulfilmentSlot.findMany({
      where: {
        orderId,
        outcome: "PENDING",
        shipmentPlanAllocations: { some: { shipmentPlanId } },
      },
      select: { id: true, settlementAmountMinor: true },
      orderBy: { id: "asc" },
    });
    if (slots.length === 0) {
      throw new ConflictException(
        "Partially cancelled Shipment has no pending fulfilment scope",
      );
    }
    const priorAdjustments = await tx.priceAdjustment.findMany({
      where: { orderId },
      include: {
        refunds: {
          where: { status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] } },
          select: { amountMinor: true },
        },
      },
    });
    const creditedBySlot = new Map<string, bigint>();
    for (const adjustment of priorAdjustments) {
      for (const credit of priceAdjustmentSlotCredits(
        adjustment.allocation,
        false,
      )) {
        creditedBySlot.set(
          credit.fulfilmentSlotId,
          (creditedBySlot.get(credit.fulfilmentSlotId) ?? 0n) +
            credit.amountMinor,
        );
      }
    }
    const slotCredits = slots.flatMap((slot) => {
      const remaining =
        slot.settlementAmountMinor - (creditedBySlot.get(slot.id) ?? 0n);
      if (remaining < 0n) {
        throw new ConflictException(
          "Prior credits exceed a cancelled fulfilment Slot value",
        );
      }
      return remaining === 0n
        ? []
        : [{ fulfilmentSlotId: slot.id, amountMinor: remaining }];
    });
    const amountMinor = slotCredits.reduce(
      (total, credit) => total + credit.amountMinor,
      0n,
    );
    const payments = await tx.payment.findMany({
      where: { orderId, capturedAmountMinor: { not: null } },
      include: {
        refunds: {
          where: { status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] } },
        },
      },
      orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
    });
    const currency = payments[0]?.currency;
    if (
      !currency ||
      payments.some((payment) => payment.currency !== currency)
    ) {
      throw new ConflictException(
        "Partial cancellation payment currency is unavailable",
      );
    }
    const reservedAdjustments = priorAdjustments.reduce((total, adjustment) => {
      const committed = adjustment.refunds.reduce(
        (sum, refund) => sum + refund.amountMinor,
        0n,
      );
      const outstanding = adjustment.amountMinor - committed;
      return total + (outstanding > 0n ? outstanding : 0n);
    }, 0n);
    const available =
      payments.reduce(
        (total, payment) =>
          total +
          payment.capturedAmountMinor! -
          payment.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n),
        0n,
      ) - reservedAdjustments;
    if (available < amountMinor) {
      throw new ConflictException(
        "Partial cancellation exceeds the refundable balance",
      );
    }

    let adjustmentId: string | undefined;
    if (amountMinor > 0n) {
      adjustmentId = (
        await tx.priceAdjustment.create({
          data: {
            orderId,
            idempotencyKey: persistenceKey(
              "partial-cancellation-adjustment",
              orderId,
              shipmentPlanId,
              key,
            ),
            reason: PriceAdjustmentReason.CUSTOMER_CANCELLATION,
            amountMinor,
            currency,
            allocation: {
              shipmentPlanId,
              slotCredits: slotCredits.map((credit) => ({
                fulfilmentSlotId: credit.fulfilmentSlotId,
                amountMinor: credit.amountMinor.toString(),
              })),
            },
          },
        })
      ).id;
    }
    await tx.fulfilmentSlot.updateMany({
      where: { id: { in: slots.map(({ id }) => id) } },
      data: { outcome: "CANCELLED", updatedAt: at },
    });
    if (!adjustmentId) return [];

    let remaining = amountMinor;
    let unboundReserved = priorAdjustments.reduce((total, adjustment) => {
      if (adjustment.paymentId) return total;
      const committed = adjustment.refunds.reduce(
        (sum, refund) => sum + refund.amountMinor,
        0n,
      );
      const outstanding = adjustment.amountMinor - committed;
      return total + (outstanding > 0n ? outstanding : 0n);
    }, 0n);
    const refundIds: string[] = [];
    for (const payment of payments) {
      if (remaining === 0n) break;
      const allocated = payment.refunds.reduce(
        (sum, refund) => sum + refund.amountMinor,
        0n,
      );
      const selectedReserved = priorAdjustments.reduce((total, adjustment) => {
        if (adjustment.paymentId !== payment.id) return total;
        const committed = adjustment.refunds.reduce(
          (sum, refund) => sum + refund.amountMinor,
          0n,
        );
        const outstanding = adjustment.amountMinor - committed;
        return total + (outstanding > 0n ? outstanding : 0n);
      }, 0n);
      let paymentAvailable =
        payment.capturedAmountMinor! - allocated - selectedReserved;
      const unboundForPayment =
        paymentAvailable <= 0n
          ? 0n
          : paymentAvailable < unboundReserved
            ? paymentAvailable
            : unboundReserved;
      paymentAvailable -= unboundForPayment;
      unboundReserved -= unboundForPayment;
      if (paymentAvailable <= 0n) continue;
      const refundAmount =
        paymentAvailable < remaining ? paymentAvailable : remaining;
      const refund = await tx.refundTransaction.create({
        data: {
          paymentId: payment.id,
          priceAdjustmentId: adjustmentId,
          provider: payment.provider,
          idempotencyKey: persistenceKey(
            "partial-cancellation-refund",
            adjustmentId,
            key,
            payment.id,
          ),
          amountMinor: refundAmount,
          reason: RefundReason.PARTIAL_CANCELLATION,
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
    if (remaining !== 0n) {
      throw new ConflictException(
        "Partial cancellation refund allocation is incomplete",
      );
    }
    return refundIds;
  }

  private async finalizeCancellation(
    tx: Transaction,
    orderId: string,
    at: Date,
    key: string,
    printingConsumptions = new Map<string, bigint>(),
    allowSettledConsumptions = false,
  ): Promise<string[]> {
    await tx.shipment.updateMany({
      where: { orderId, status: ShipmentStatus.PLANNED },
      data: { status: ShipmentStatus.CANCELLED, cancelledAt: at },
    });
    const printing = await this.activePrintingReservations(tx, orderId);
    assertPrintingConsumptionCoverage(
      printing,
      printingConsumptions,
      allowSettledConsumptions,
    );
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
      include: {
        refunds: {
          where: { status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] } },
        },
      },
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

  private activePrintingReservations(tx: Transaction, orderId: string) {
    return tx.productionReservation.findMany({
      where: {
        job: { orderId, status: JobStatus.PRINTING },
        status: "PRINTING",
      },
      select: { id: true, jobId: true },
    });
  }

  private async pendingCancellationPrintingConsumptions(
    tx: Transaction,
    orderId: string,
  ): Promise<Map<string, bigint>> {
    const rows = await tx.$queryRaw<Array<{ printingConsumptions: unknown }>>`
      SELECT event.payload #> '{input,printingConsumptions}' AS "printingConsumptions"
      FROM audit_events event
      WHERE event.order_id = ${orderId}::uuid
        AND event.event_type = 'fulfilment.command_completed'
        AND event.payload ->> 'operation' = 'cancel'
        AND event.payload #>> '{response,status}' = 'LABEL_CANCELLATION_PENDING'
      ORDER BY event.created_at DESC, event.id DESC
      LIMIT 1
    `;
    return cancellationPrintingConsumptions(rows[0]?.printingConsumptions);
  }

  private async expressAdjustmentSlotCredits(
    tx: Transaction,
    orderId: string,
    amountMinor: bigint,
    requestedSlotCredits: PriceAdjustmentSlotCredit[],
  ): Promise<PriceAdjustmentSlotCredit[]> {
    const targets = await tx.$queryRaw<
      Array<{
        fulfilmentSlotId: string;
        basisMinor: bigint;
        creditedMinor: bigint;
        currency: string;
      }>
    >`
      WITH express_allocations AS (
        SELECT allocation.fulfilment_slot_id,
               sum(allocation.amount_minor)::bigint AS basis_minor,
               snapshot.currency
        FROM order_active_price_bindings active_binding
        JOIN order_price_bindings binding
          ON binding.id = active_binding.order_price_binding_id
         AND binding.order_id = active_binding.order_id
        JOIN price_snapshots snapshot
          ON snapshot.id = binding.price_snapshot_id
        JOIN price_snapshot_components component
          ON component.price_snapshot_id = snapshot.id
         AND component.kind = 'EXPRESS'
        JOIN price_component_fulfilment_allocations allocation
          ON allocation.price_snapshot_component_id = component.id
        WHERE active_binding.order_id = ${orderId}::uuid
        GROUP BY allocation.fulfilment_slot_id, snapshot.currency
      ), prior_credits AS (
        SELECT (credit.value ->> 'fulfilmentSlotId')::uuid AS fulfilment_slot_id,
               sum((credit.value ->> 'amountMinor')::bigint)::bigint AS credited_minor
        FROM price_adjustments adjustment
        CROSS JOIN LATERAL jsonb_array_elements(
          coalesce(adjustment.allocation -> 'slotCredits', '[]'::jsonb)
        ) credit(value)
        WHERE adjustment.order_id = ${orderId}::uuid
          AND adjustment.reason = 'EXPRESS_BREACH'
        GROUP BY (credit.value ->> 'fulfilmentSlotId')::uuid
      )
      SELECT express.fulfilment_slot_id AS "fulfilmentSlotId",
             express.basis_minor AS "basisMinor",
             coalesce(prior.credited_minor, 0)::bigint AS "creditedMinor",
             express.currency
      FROM express_allocations express
      LEFT JOIN prior_credits prior
        ON prior.fulfilment_slot_id = express.fulfilment_slot_id
      ORDER BY express.fulfilment_slot_id
    `;
    const currency = targets[0]?.currency;
    if (
      !currency ||
      targets.some((target) => target.currency !== currency) ||
      targets.some(
        (target) =>
          target.basisMinor <= 0n ||
          target.creditedMinor < 0n ||
          target.creditedMinor > target.basisMinor,
      )
    ) {
      throw new ConflictException("Order has no allocated express surcharge");
    }
    const remainingBySlot = new Map(
      targets.map((target) => [
        target.fulfilmentSlotId,
        target.basisMinor - target.creditedMinor,
      ]),
    );
    if (requestedSlotCredits.length > 0) {
      if (
        requestedSlotCredits.some(
          (credit) =>
            !remainingBySlot.has(credit.fulfilmentSlotId) ||
            credit.amountMinor > remainingBySlot.get(credit.fulfilmentSlotId)!,
        )
      ) {
        throw new ConflictException(
          "Price adjustment exceeds the remaining allocated express surcharge",
        );
      }
      return requestedSlotCredits;
    }
    const remainingTargets = targets
      .map((target) => ({
        id: target.fulfilmentSlotId,
        basis: target.basisMinor - target.creditedMinor,
      }))
      .filter((target) => target.basis > 0n);
    if (
      amountMinor >
      remainingTargets.reduce((total, target) => total + target.basis, 0n)
    ) {
      throw new ConflictException(
        "Price adjustment exceeds the remaining allocated express surcharge",
      );
    }
    const { allocateMoney, Money } = await import("@taven/core");
    return allocateMoney(Money.of(amountMinor, currency), remainingTargets)
      .filter((allocation) => allocation.amount.minorUnits > 0n)
      .map((allocation) => ({
        fulfilmentSlotId: allocation.targetId,
        amountMinor: allocation.amount.minorUnits,
      }));
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

  private async shipmentLineageIds(
    tx: Transaction,
    leafShipmentId: string,
  ): Promise<Set<string>> {
    const lineage = await tx.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE shipment_lineage AS (
        SELECT id, replaces_shipment_id
        FROM shipments
        WHERE id = ${leafShipmentId}::uuid
        UNION ALL
        SELECT predecessor.id, predecessor.replaces_shipment_id
        FROM shipments predecessor
        JOIN shipment_lineage successor
          ON successor.replaces_shipment_id = predecessor.id
      )
      SELECT id FROM shipment_lineage
    `;
    return new Set(lineage.map(({ id }) => id));
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

function dateEvidence(value: unknown, name: string): Date {
  const date = new Date(typeof value === "string" ? value : "");
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return date;
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

function assertPrintingConsumptionCoverage(
  printing: Array<{ jobId: string | null }>,
  consumptions: Map<string, bigint>,
  allowSettledConsumptions: boolean,
): void {
  if (
    (!allowSettledConsumptions && printing.length !== consumptions.size) ||
    printing.some(
      ({ jobId }) => !jobId || consumptions.get(jobId) === undefined,
    )
  ) {
    throw new BadRequestException(
      "printingConsumptions must cover every actively printing Job",
    );
  }
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
    case PriceAdjustmentReason.CUSTOMER_CANCELLATION:
      return RefundReason.PARTIAL_CANCELLATION;
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
