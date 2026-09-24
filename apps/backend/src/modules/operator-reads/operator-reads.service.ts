import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AutomaticQuoteRiskDecision,
  CapacityReservationStatus,
  JobStatus,
  OrderStatus,
  Prisma,
  SliceKind,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  assertOperationalOrderScope,
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { OrdersService } from "../orders/orders.service";
import type { FulfilmentProjectionDto } from "../orders/orders.dto";
import type {
  FulfilmentClaimDto,
  FulfilmentRefundDto,
} from "../orders/orders.dto";
import { referenceProfileActivationNotice } from "../resources/reference-profile-activation-notice.dto";
import {
  CapacityReservationPageDto,
  MachineCalibrationPageDto,
  MachineCapabilityPageDto,
  MachinePageDto,
  MachineAvailabilityReadDto,
  MachineProfilePageDto,
  OperatorJobPageDto,
  OperatorOrderDetailDto,
  OperatorOrderPageDto,
  OperatorOrderTimelinePageDto,
  OperatorPaymentPageDto,
  OperatorRefundPageDto,
  OperatorSettlementPageDto,
  OperatorFulfilmentHistoryPageDto,
  OperatorClaimChildHistoryPageDto,
  type OperatorFulfilmentHistoryCursorsDto,
  type OperatorSettlementDto,
  type OperatorPaymentDto,
  type OperatorRefundTransactionDto,
  PriceListPageDto,
  PrintConfigRevisionPageDto,
  ReferenceProfilePageDto,
  ReferenceProfileActivationNoticePageDto,
  type MachineProfileReadDto,
  type OperatorJobListItemDto,
  type OperatorOrderListItemDto,
  type OperatorActionDto,
  type ReferenceProfileReadDto,
  InventoryPageDto,
  InventoryDetailDto,
  MachineProfileDetailDto,
  PriceListDetailDto,
  PrintConfigRevisionDetailDto,
  ReferenceProfileDetailDto,
} from "./operator-reads.dto";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_RANGE_MILLISECONDS = 366 * 24 * 60 * 60 * 1_000;

export type PageInput = Readonly<{
  cursor?: string;
  limit?: number;
}>;

export type OrderPageInput = PageInput & Readonly<{ status?: string }>;
export type JobPageInput = PageInput &
  Readonly<{ status?: string; machineId?: string }>;
export type NodePageInput = PageInput & Readonly<{ machineId?: string }>;
export type CapacityPageInput = NodePageInput &
  Readonly<{ from: string; to: string; status?: string }>;

type Cursor = Readonly<{ id: string; filterHash: string }>;
type TimeCursor = Readonly<{
  createdAt: string;
  id: string;
  filterHash: string;
}>;
type StartsAtCursor = Readonly<{
  startsAt: string;
  id: string;
  filterHash: string;
}>;
type ActivationNoticeCursor = Readonly<{
  activatedAt: string;
  id: string;
  filterHash: string;
}>;

type SelectedReferenceSlice = Readonly<{
  kind: SliceKind;
  modelGeometryId: string;
  printConfigRevisionId: string;
  referenceProfileId: string | null;
}>;

type AutomaticQuoteItemSnapshot = Readonly<{
  ordinal: number;
  sourceModelFileId: string;
  targetModelGeometryId: string;
  printConfigRevisionId: string;
  referenceProfileId: string;
  referencePartsPerPlate: number | null;
  configurationFingerprint: string;
  riskDecisions: ReadonlyArray<
    Readonly<{
      configurationFingerprint: string;
      acknowledgementKey: string;
      preflightFinding: Readonly<{
        id: string;
        code: string;
        severity: string;
        message: string;
      }>;
    }>
  >;
}>;

type OrderedItemPreflightScope = Readonly<{
  ordinal: number;
  sourceModelFileId: string;
  modelGeometryId: string;
  printConfigRevisionId: string;
  referencePartsPerPlate: number | null;
  primaryReferenceSliceResult: SelectedReferenceSlice | null;
  tailReferenceSliceResult: SelectedReferenceSlice | null;
}>;

@Injectable()
export class OperatorReadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  async ordersPage(
    operator: OperatorContext,
    input: OrderPageInput,
  ): Promise<OperatorOrderPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    const nodeId = operatorNode(operator);
    const limit = pageLimit(input.limit);
    const status = orderStatus(input.status);
    const filterHash = digest({ nodeId, status });
    const cursor = input.cursor
      ? parseTimeCursor(input.cursor, filterHash, "orders cursor")
      : undefined;
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
        const keys = await transaction.$queryRaw<
          Array<{ id: string; createdAt: Date }>
        >`
      SELECT "order".id, "order".created_at AS "createdAt"
      FROM orders AS "order"
      WHERE (
        ${status}::order_status IS NULL OR "order".status = ${status}::order_status
      )
        AND EXISTS (
          SELECT 1
          FROM (
            SELECT job.node_id FROM jobs AS job WHERE job.order_id = "order".id
            UNION
            SELECT plan.node_id
            FROM phase_resource_plans AS plan
            JOIN order_phases AS phase ON phase.id = plan.order_phase_id
            WHERE phase.order_id = "order".id
            UNION
            SELECT plan_job.node_id
            FROM phase_resource_plan_jobs AS plan_job
            JOIN phase_resource_plans AS plan ON plan.id = plan_job.phase_resource_plan_id
            JOIN order_phases AS phase ON phase.id = plan.order_phase_id
            WHERE phase.order_id = "order".id
            UNION
            SELECT plan_slot.node_id
            FROM phase_resource_plan_slots AS plan_slot
            JOIN phase_resource_plans AS plan ON plan.id = plan_slot.phase_resource_plan_id
            JOIN order_phases AS phase ON phase.id = plan.order_phase_id
            WHERE phase.order_id = "order".id
          ) AS scoped
          WHERE scoped.node_id = ${nodeId}::uuid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT job.node_id FROM jobs AS job WHERE job.order_id = "order".id
            UNION
            SELECT plan.node_id
            FROM phase_resource_plans AS plan
            JOIN order_phases AS phase ON phase.id = plan.order_phase_id
            WHERE phase.order_id = "order".id
            UNION
            SELECT plan_job.node_id
            FROM phase_resource_plan_jobs AS plan_job
            JOIN phase_resource_plans AS plan ON plan.id = plan_job.phase_resource_plan_id
            JOIN order_phases AS phase ON phase.id = plan.order_phase_id
            WHERE phase.order_id = "order".id
            UNION
            SELECT plan_slot.node_id
            FROM phase_resource_plan_slots AS plan_slot
            JOIN phase_resource_plans AS plan ON plan.id = plan_slot.phase_resource_plan_id
            JOIN order_phases AS phase ON phase.id = plan.order_phase_id
            WHERE phase.order_id = "order".id
          ) AS scoped
          WHERE scoped.node_id <> ${nodeId}::uuid
        )
        AND (
          ${cursor?.createdAt ? new Date(cursor.createdAt) : null}::timestamptz IS NULL
          OR ("order".created_at, "order".id) < (
            ${cursor?.createdAt ? new Date(cursor.createdAt) : null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY "order".created_at DESC, "order".id DESC
      LIMIT ${limit + 1}
    `;
        const rows = await transaction.order.findMany({
          where: { id: { in: keys.map((key) => key.id) } },
          select: {
            id: true,
            publicReference: true,
            status: true,
            createdAt: true,
            confirmedAt: true,
          },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const page = keys
          .slice(0, limit)
          .map((key) => byId.get(key.id))
          .filter((row): row is (typeof rows)[number] => row !== undefined)
          .map(orderListItem);
        const last = keys.at(limit - 1);
        return {
          items: page,
          ...(keys.length > limit && last
            ? {
                nextCursor: encodeCursor({
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                  filterHash,
                }),
              }
            : {}),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async orderDetail(
    operator: OperatorContext,
    orderId: string,
  ): Promise<OperatorOrderDetailDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    assertUuid(orderId, "orderId");
    // Scope validation locks the envelope, so read committed avoids a
    // serialization failure when a concurrent fulfilment command releases it.
    return this.prisma.$transaction(async (transaction) => {
      const fulfilment = await this.orders.getFulfilmentInTransaction(
        operator,
        orderId,
        transaction,
      );
      const order = await transaction.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            orderBy: { ordinal: "asc" },
            include: {
              modelGeometry: true,
              printConfigRevision: { include: { revision: true } },
              primaryReferenceSliceResult: {
                select: {
                  id: true,
                  kind: true,
                  modelGeometryId: true,
                  printConfigRevisionId: true,
                  referenceProfileId: true,
                  packageQuantity: true,
                  packagePlateCount: true,
                  partsPerPlate: true,
                  estimatedPrintSeconds: true,
                  estimatedMaterialMilligrams: true,
                  slicerEngine: true,
                  slicerVersion: true,
                  createdAt: true,
                },
              },
              tailReferenceSliceResult: {
                select: {
                  id: true,
                  kind: true,
                  modelGeometryId: true,
                  printConfigRevisionId: true,
                  referenceProfileId: true,
                  packageQuantity: true,
                  packagePlateCount: true,
                  partsPerPlate: true,
                  estimatedPrintSeconds: true,
                  estimatedMaterialMilligrams: true,
                  slicerEngine: true,
                  slicerVersion: true,
                  createdAt: true,
                },
              },
            },
          },
          automaticQuoteDraft: {
            select: {
              items: {
                select: {
                  ordinal: true,
                  sourceModelFileId: true,
                  targetModelGeometryId: true,
                  printConfigRevisionId: true,
                  referenceProfileId: true,
                  referencePartsPerPlate: true,
                  configurationFingerprint: true,
                  riskDecisions: {
                    where: {
                      decision: AutomaticQuoteRiskDecision.ACKNOWLEDGED,
                    },
                    select: {
                      configurationFingerprint: true,
                      acknowledgementKey: true,
                      preflightFinding: {
                        select: {
                          id: true,
                          code: true,
                          severity: true,
                          message: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          acceptedPriceBinding: {
            include: {
              priceSnapshot: {
                include: {
                  priceList: true,
                  components: {
                    include: { fulfilmentAllocations: true },
                    orderBy: { id: "asc" },
                  },
                },
              },
            },
          },
          legalAcceptances: {
            include: { revision: true },
            orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
          },
          activeContractPrice: { include: { contractPriceRevision: true } },
          shipmentPlans: {
            orderBy: { ordinal: "asc" },
            include: {
              fulfilmentSlotAllocations: {
                include: {
                  fulfilmentSlot: { select: { orderItemId: true } },
                },
              },
            },
          },
          settlements: {
            orderBy: [{ settledAt: "asc" }, { id: "asc" }],
          },
          priceBindings: {
            include: {
              payments: {
                orderBy: { createdAt: "asc" },
                include: {
                  refunds: {
                    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
                  },
                },
              },
            },
          },
          auditEvents: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: {
              id: true,
              eventType: true,
              actorKind: true,
              reasonCode: true,
              reason: true,
              createdAt: true,
            },
            take: 26,
          },
        },
      });
      if (!order) throw new NotFoundException("Order was not found");
      const slotJobs = await transaction.$queryRaw<
        Array<{
          fulfilmentSlotId: string;
          jobId: string | null;
          current: boolean;
        }>
      >`
        SELECT slot.id AS "fulfilmentSlotId",
               job.id AS "jobId",
               CASE WHEN job.id IS NULL THEN false
                    ELSE taven_job_is_current(job.id) END AS "current"
        FROM fulfilment_slots slot
        LEFT JOIN phase_resource_plan_slots planned
          ON planned.fulfilment_slot_id = slot.id
        LEFT JOIN jobs job
          ON job.phase_resource_plan_job_id = planned.phase_resource_plan_job_id
         AND job.order_id = slot.order_id
        WHERE slot.order_id = ${orderId}::uuid
        ORDER BY slot.id, job.created_at, job.id
      `;
      const slotLineage = new Map<
        string,
        {
          fulfilmentSlotId: string;
          currentJobId: string | null;
          jobIds: string[];
        }
      >();
      for (const row of slotJobs) {
        const entry = slotLineage.get(row.fulfilmentSlotId) ?? {
          fulfilmentSlotId: row.fulfilmentSlotId,
          currentJobId: null,
          jobIds: [],
        };
        if (row.jobId && !entry.jobIds.includes(row.jobId)) {
          entry.jobIds.push(row.jobId);
          if (row.current) entry.currentJobId = row.jobId;
        }
        slotLineage.set(row.fulfilmentSlotId, entry);
      }
      const accepted = order.acceptedPriceBinding?.priceSnapshot;
      const active = order.activeContractPrice?.contractPriceRevision;
      const acceptedQuoteItems = new Map(
        (order.automaticQuoteDraft?.items ?? []).map((item) => [
          item.ordinal,
          item,
        ]),
      );
      const payments = order.priceBindings.flatMap(
        (binding) => binding.payments,
      );
      const orderedPayments = [...payments].sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      );
      const orderedSettlements = [...order.settlements].reverse();
      const compensation = payments.reduce((sum, payment) => {
        if (payment.captureAuthorized || !payment.capturedAt) return sum;
        const refunded = payment.refunds
          .filter((refund) => refund.status === "SUCCEEDED")
          .reduce((amount, refund) => amount + refund.amountMinor, 0n);
        const remaining = (payment.capturedAmountMinor ?? 0n) - refunded;
        return sum + (remaining > 0n ? remaining : 0n);
      }, 0n);
      const blockers = orderBarriers(
        fulfilment,
        payments,
        order.settlements,
        compensation,
      );
      const timeline = order.auditEvents.slice(0, 25);
      const bounded = boundedFulfilment(fulfilment, 25);
      return {
        id: order.id,
        publicReference: order.publicReference,
        status: order.status,
        confirmedAt: iso(order.confirmedAt),
        acceptedTermsRevision: order.acceptedTermsRevision,
        acceptedClaimPolicyRevision: order.acceptedClaimPolicyRevision,
        acceptedClaimWindowDays: order.acceptedClaimWindowDays,
        withdrawalExceptionAcknowledgedAt: iso(
          order.withdrawalExceptionAcknowledgedAt,
        ),
        legalAcceptances: order.legalAcceptances.map((acceptance) => ({
          revisionId: acceptance.revisionId,
          purpose: acceptance.purpose,
          revisionCode: acceptance.revision.revisionCode,
          contentHash: acceptance.revision.contentHash,
          acceptedAt: acceptance.acceptedAt.toISOString(),
        })),
        acceptedPrice: accepted
          ? {
              bindingId: order.acceptedPriceBinding!.id,
              snapshotId: accepted.id,
              snapshotHash: accepted.snapshotHash,
              pricingRevision: accepted.pricingRevision,
              taxRegime: accepted.taxRegime,
              vatRateBasisPoints: accepted.vatRateBasisPoints,
              contractTotalMinor: accepted.contractTotalMinor.toString(),
              netAmountMinor: accepted.netAmountMinor.toString(),
              vatAmountMinor: accepted.vatAmountMinor.toString(),
              currency: accepted.currency,
              priceListRevision: accepted.priceList.revision,
              termsRevision: accepted.priceList.termsRevision,
              components: accepted.components.map((component) => ({
                id: component.id,
                kind: component.kind,
                scope: component.scope,
                orderItemId: component.orderItemId,
                shipmentPlanId: component.shipmentPlanId,
                amountMinor: component.amountMinor.toString(),
                allocation: component.allocation as Record<
                  string,
                  unknown
                > | null,
                fulfilmentAllocations: component.fulfilmentAllocations.map(
                  (allocation) => ({
                    fulfilmentSlotId: allocation.fulfilmentSlotId,
                    amountMinor: allocation.amountMinor.toString(),
                  }),
                ),
              })),
            }
          : null,
        items: order.items.map((item) => ({
          id: item.id,
          ordinal: item.ordinal,
          sourceModelFileId: item.sourceModelFileId,
          modelGeometryId: item.modelGeometryId,
          printConfigRevisionId: item.printConfigRevisionId,
          material: item.material,
          color: item.color,
          quantity: item.quantity,
          referencePartsPerPlate: item.referencePartsPerPlate,
          primaryReferenceSlice: operatorReferenceSlice(
            item.primaryReferenceSliceResult,
          ),
          tailReferenceSlice: operatorReferenceSlice(
            item.tailReferenceSliceResult,
          ),
          preflightFindings: acceptedPreflightFindingCodes(
            item,
            acceptedQuoteItems.get(item.ordinal),
          ),
          acceptedFindings: acceptedPreflightFindings(
            item,
            acceptedQuoteItems.get(item.ordinal),
          ),
          geometry: {
            boundsXMicrometers:
              item.modelGeometry.boundsXMicrometers.toString(),
            boundsYMicrometers:
              item.modelGeometry.boundsYMicrometers.toString(),
            boundsZMicrometers:
              item.modelGeometry.boundsZMicrometers.toString(),
            volumeCubicMicrometers:
              item.modelGeometry.volumeCubicMicrometers.toString(),
            geometrySha256: item.modelGeometry.geometryHash,
          },
          printConfig: {
            id: item.printConfigRevision.id,
            digest: item.printConfigRevision.revision.digest,
            quality: item.printConfigRevision.quality,
            infillPercent: item.printConfigRevision.infillPercent,
            layerHeightMicrometers:
              item.printConfigRevision.layerHeightMicrometers,
            supportsEnabled: item.printConfigRevision.supportsEnabled,
            brimEnabled: item.printConfigRevision.brimEnabled,
            createdAt: item.printConfigRevision.createdAt.toISOString(),
          },
        })),
        financial: {
          activeContractRevisionId: active?.id ?? null,
          activeContractTotalMinor:
            active?.contractTotalMinor.toString() ?? null,
          activeContractNetMinor: active?.netAmountMinor.toString() ?? null,
          currency: active?.currency ?? null,
          settlements: orderedSettlements.slice(0, 25).map(operatorSettlement),
          ...(orderedSettlements.length > 25
            ? { settlementsNextCursor: orderedSettlements[24]!.id }
            : {}),
          payments: orderedPayments.slice(0, 25).map(operatorPayment),
          ...(orderedPayments.length > 25
            ? { paymentsNextCursor: orderedPayments[24]!.id }
            : {}),
          outstandingCompensationMinor: compensation.toString(),
          blockingCodes: blockers.filter((code) =>
            ["COMPENSATION_DUE", "REFUND_UNRESOLVED", "BALANCE_DUE"].includes(
              code,
            ),
          ),
        },
        fulfilment: bounded.projection,
        fulfilmentNextCursors: bounded.nextCursors,
        shipmentPlans: order.shipmentPlans.map((plan) => ({
          id: plan.id,
          orderPhaseId: plan.orderPhaseId,
          ordinal: plan.ordinal,
          category: plan.category,
          plannedVolumeCubicMm: plan.plannedVolumeCubicMm.toString(),
          plannedWeightMilligrams: plan.plannedWeightMilligrams.toString(),
          shippingAmountMinor: plan.shippingAmountMinor.toString(),
          packagingAmountMinor: plan.packagingAmountMinor.toString(),
          handlingAmountMinor: plan.handlingAmountMinor.toString(),
          slots: plan.fulfilmentSlotAllocations.map((allocation) => ({
            fulfilmentSlotId: allocation.fulfilmentSlotId,
            orderItemId: allocation.fulfilmentSlot.orderItemId,
          })),
        })),
        slotLineage: [...slotLineage.values()],
        timeline: timeline.map((event) => ({
          id: event.id,
          eventType: event.eventType,
          actorKind: event.actorKind,
          reasonCode: event.reasonCode,
          reason: event.reason,
          occurredAt: event.createdAt.toISOString(),
        })),
        ...(order.auditEvents.length > 25
          ? { timelineNextCursor: timeline.at(-1)!.id }
          : {}),
        blockingCodes: blockers,
        actions: orderActions(
          operator,
          fulfilment,
          order.shipmentPlans,
          payments,
          blockers,
        ),
      };
    });
  }

  async orderTimeline(
    operator: OperatorContext,
    orderId: string,
    input: PageInput,
  ): Promise<OperatorOrderTimelinePageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    assertUuid(orderId, "orderId");
    if (input.cursor) assertUuid(input.cursor, "cursor");
    const limit = pageLimit(input.limit);
    const nodeId = operatorNode(operator);
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, nodeId);
      const cursor = input.cursor
        ? await tx.auditEvent.findFirst({
            where: { id: input.cursor, orderId },
            select: { id: true, createdAt: true },
          })
        : null;
      if (input.cursor && !cursor)
        throw new BadRequestException("cursor is invalid");
      const rows = await tx.auditEvent.findMany({
        where: {
          orderId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  {
                    createdAt: cursor.createdAt,
                    id: { lt: cursor.id },
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          eventType: true,
          actorKind: true,
          reasonCode: true,
          reason: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map(orderTimelineEvent),
        ...(rows.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
      };
    });
  }

  async orderPayments(
    operator: OperatorContext,
    orderId: string,
    input: PageInput,
  ): Promise<OperatorPaymentPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    assertUuid(orderId, "orderId");
    if (input.cursor) assertUuid(input.cursor, "cursor");
    const limit = pageLimit(input.limit);
    const nodeId = operatorNode(operator);
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, nodeId);
      if (
        input.cursor &&
        !(await tx.payment.findFirst({
          where: { id: input.cursor, orderId },
          select: { id: true },
        }))
      )
        throw new BadRequestException("cursor is invalid");
      const rows = await tx.payment.findMany({
        where: { orderId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        include: {
          refunds: {
            orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
            take: 26,
          },
        },
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map(operatorPayment),
        ...(rows.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
      };
    });
  }

  async orderRefunds(
    operator: OperatorContext,
    orderId: string,
    input: PageInput,
  ): Promise<OperatorRefundPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    assertUuid(orderId, "orderId");
    if (input.cursor) assertUuid(input.cursor, "cursor");
    const limit = pageLimit(input.limit);
    const nodeId = operatorNode(operator);
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, nodeId);
      const where = { payment: { orderId } };
      if (
        input.cursor &&
        !(await tx.refundTransaction.findFirst({
          where: { ...where, id: input.cursor },
          select: { id: true },
        }))
      )
        throw new BadRequestException("cursor is invalid");
      const rows = await tx.refundTransaction.findMany({
        where,
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map((refund) => ({
          ...operatorRefund(refund),
          paymentId: refund.paymentId,
        })),
        ...(rows.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
      };
    });
  }

  async orderSettlements(
    operator: OperatorContext,
    orderId: string,
    input: PageInput,
  ): Promise<OperatorSettlementPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    assertUuid(orderId, "orderId");
    if (input.cursor) assertUuid(input.cursor, "cursor");
    const limit = pageLimit(input.limit);
    const nodeId = operatorNode(operator);
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, nodeId);
      if (
        input.cursor &&
        !(await tx.orderSettlement.findFirst({
          where: { id: input.cursor, orderId },
          select: { id: true },
        }))
      )
        throw new BadRequestException("cursor is invalid");
      const rows = await tx.orderSettlement.findMany({
        where: { orderId },
        orderBy: [{ settledAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map(operatorSettlement),
        ...(rows.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
      };
    });
  }

  async fulfilmentHistory(
    operator: OperatorContext,
    orderId: string,
    kind: string,
    input: PageInput,
  ): Promise<OperatorFulfilmentHistoryPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    assertUuid(orderId, "orderId");
    if (!isFulfilmentHistoryKind(kind))
      throw new BadRequestException("kind is invalid");
    if (input.cursor) assertUuid(input.cursor, "cursor");
    const limit = pageLimit(input.limit);
    const nodeId = operatorNode(operator);
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, nodeId);
      const pagination = {
        orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
        take: limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      };
      switch (kind) {
        case "jobs": {
          if (
            input.cursor &&
            !(await tx.job.findFirst({
              where: { id: input.cursor, orderId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          return fulfilmentHistoryPage(
            await tx.job.findMany({
              where: { orderId },
              include: {
                shipmentAssignment: true,
                replacementRequestSource: true,
              },
              ...pagination,
            }),
            limit,
          );
        }
        case "shipments": {
          if (
            input.cursor &&
            !(await tx.shipment.findFirst({
              where: { id: input.cursor, orderId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          return fulfilmentHistoryPage(
            await tx.shipment.findMany({
              where: { orderId },
              include: { jobAssignments: true },
              ...pagination,
            }),
            limit,
          );
        }
        case "slots": {
          if (
            input.cursor &&
            !(await tx.fulfilmentSlot.findFirst({
              where: { id: input.cursor, orderId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          return fulfilmentHistoryPage(
            await tx.fulfilmentSlot.findMany({
              where: { orderId },
              ...pagination,
            }),
            limit,
          );
        }
        case "replacementRequests": {
          if (
            input.cursor &&
            !(await tx.replacementRequest.findFirst({
              where: { id: input.cursor, orderId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          return fulfilmentHistoryPage(
            await tx.replacementRequest.findMany({
              where: { orderId },
              ...pagination,
            }),
            limit,
          );
        }
        case "claims": {
          if (
            input.cursor &&
            !(await tx.claim.findFirst({
              where: { id: input.cursor, orderId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          const page = fulfilmentHistoryPage(
            await tx.claim.findMany({
              where: { orderId },
              include: {
                resolutions: {
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  take: 26,
                },
                refunds: {
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  take: 26,
                },
                reshipmentAuthorizations: {
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  take: 26,
                },
              },
              ...pagination,
            }),
            limit,
          );
          return {
            ...page,
            items: page.items.map((claim) =>
              boundedClaim(claim as FulfilmentClaimDto, 25),
            ),
          };
        }
        case "priceAdjustments": {
          if (
            input.cursor &&
            !(await tx.priceAdjustment.findFirst({
              where: { id: input.cursor, orderId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          return fulfilmentHistoryPage(
            await tx.priceAdjustment.findMany({
              where: { orderId },
              ...pagination,
            }),
            limit,
          );
        }
      }
    });
  }

  async claimChildHistory(
    operator: OperatorContext,
    orderId: string,
    claimId: string,
    kind: string,
    input: PageInput,
  ): Promise<OperatorClaimChildHistoryPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    assertUuid(orderId, "orderId");
    assertUuid(claimId, "claimId");
    if (!isClaimChildHistoryKind(kind))
      throw new BadRequestException("kind is invalid");
    if (input.cursor) assertUuid(input.cursor, "cursor");
    const limit = pageLimit(input.limit);
    const nodeId = operatorNode(operator);
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, nodeId);
      if (
        !(await tx.claim.findFirst({
          where: { id: claimId, orderId },
          select: { id: true },
        }))
      )
        throw new NotFoundException("Claim was not found");
      const pagination = {
        orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
        take: limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      };
      switch (kind) {
        case "resolutions": {
          if (
            input.cursor &&
            !(await tx.claimSlotResolution.findFirst({
              where: { id: input.cursor, claimId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          return claimChildHistoryPage(
            await tx.claimSlotResolution.findMany({
              where: { claimId },
              ...pagination,
            }),
            limit,
          );
        }
        case "refunds": {
          if (
            input.cursor &&
            !(await tx.refundTransaction.findFirst({
              where: { id: input.cursor, claimId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          const page = claimChildHistoryPage(
            await tx.refundTransaction.findMany({
              where: { claimId },
              ...pagination,
            }),
            limit,
          );
          return {
            ...page,
            items: page.items.map((refund) =>
              claimRefund(refund as FulfilmentRefundDto),
            ),
          };
        }
        case "reshipmentAuthorizations": {
          if (
            input.cursor &&
            !(await tx.reshipmentAuthorization.findFirst({
              where: { id: input.cursor, claimId },
              select: { id: true },
            }))
          )
            throw new BadRequestException("cursor is invalid");
          return claimChildHistoryPage(
            await tx.reshipmentAuthorization.findMany({
              where: { claimId },
              ...pagination,
            }),
            limit,
          );
        }
      }
    });
  }

  async jobsPage(
    operator: OperatorContext,
    input: JobPageInput,
  ): Promise<OperatorJobPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    const nodeId = operatorNode(operator);
    const limit = pageLimit(input.limit);
    const status = jobStatus(input.status);
    const machineId = input.machineId;
    if (machineId !== undefined) assertUuid(machineId, "machineId");
    const filterHash = digest({ nodeId, status, machineId });
    const cursor = input.cursor
      ? parseTimeCursor(input.cursor, filterHash, "jobs cursor")
      : undefined;
    const rows = await this.prisma.job.findMany({
      where: {
        nodeId,
        ...(status ? { status } : {}),
        ...(machineId
          ? {
              phaseResourcePlanJob: {
                candidateResourceEstimate: { machineId },
              },
            }
          : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                {
                  createdAt: new Date(cursor.createdAt),
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      include: {
        phaseResourcePlanJob: {
          select: {
            candidateResourceEstimate: { select: { machineId: true } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit).map(jobListItem);
    const last = page.at(-1);
    return {
      items: page,
      ...(rows.length > limit && last
        ? {
            nextCursor: encodeCursor({
              createdAt: last.createdAt,
              id: last.id,
              filterHash,
            }),
          }
        : {}),
    };
  }

  async referenceProfiles(
    operator: OperatorContext,
    input: PageInput,
  ): Promise<ReferenceProfilePageDto> {
    this.requireRead(operator);
    const filterHash = digest({ kind: "reference-profiles" });
    const cursor = pageCursor(
      input.cursor,
      filterHash,
      "reference profiles cursor",
    );
    const rows = await this.prisma.referenceProfile.findMany({
      include: { revision: { select: { digest: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    return pageResult(
      rows,
      pageLimit(input.limit),
      filterHash,
      referenceProfile,
    );
  }

  async referenceProfileDetail(
    operator: OperatorContext,
    id: string,
  ): Promise<ReferenceProfileDetailDto> {
    this.requireRead(operator);
    assertUuid(id, "id");
    const row = await this.prisma.referenceProfile.findUnique({
      where: { id },
      include: { revision: { select: { digest: true } } },
    });
    if (!row) throw new NotFoundException("Reference profile was not found");
    return {
      ...referenceProfile(row),
      settings: row.settings as Record<string, unknown>,
    };
  }

  async referenceProfileActivationNotices(
    operator: OperatorContext,
    input: PageInput,
  ): Promise<ReferenceProfileActivationNoticePageDto> {
    this.requireRead(operator);
    const filterHash = digest({
      kind: "reference-profile-activation-notices",
      version: 1,
    });
    const cursor = input.cursor
      ? parseActivationNoticeCursor(
          input.cursor,
          filterHash,
          "reference profile activation notices cursor",
        )
      : undefined;
    const limit = pageLimit(input.limit);
    const rows = await this.prisma.referenceProfile.findMany({
      where: {
        activatedAt: { not: null },
        ...(cursor
          ? {
              OR: [
                { activatedAt: { lt: new Date(cursor.activatedAt) } },
                {
                  activatedAt: new Date(cursor.activatedAt),
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        material: true,
        quality: true,
        activatedAt: true,
      },
      orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit).map(referenceProfileActivationNotice);
    const last = page.at(-1);
    return {
      items: page,
      ...(rows.length > limit && last
        ? {
            nextCursor: encodeCursor({
              activatedAt: last.activatedAt,
              id: last.referenceProfileId,
              filterHash,
            }),
          }
        : {}),
    };
  }

  async machineProfiles(
    operator: OperatorContext,
    input: PageInput,
  ): Promise<MachineProfilePageDto> {
    this.requireRead(operator);
    const filterHash = digest({ kind: "machine-profiles" });
    const cursor = pageCursor(
      input.cursor,
      filterHash,
      "machine profiles cursor",
    );
    const rows = await this.prisma.machineProfile.findMany({
      include: { revision: { select: { digest: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    return pageResult(rows, pageLimit(input.limit), filterHash, machineProfile);
  }

  async machineProfileDetail(
    operator: OperatorContext,
    id: string,
  ): Promise<MachineProfileDetailDto> {
    this.requireRead(operator);
    assertUuid(id, "id");
    const row = await this.prisma.machineProfile.findUnique({
      where: { id },
      include: { revision: { select: { digest: true } } },
    });
    if (!row) throw new NotFoundException("Machine profile was not found");
    return {
      ...machineProfile(row),
      settings: row.settings as Record<string, unknown>,
    };
  }

  async printConfigRevisions(
    operator: OperatorContext,
    input: PageInput,
  ): Promise<PrintConfigRevisionPageDto> {
    this.requireRead(operator);
    const filterHash = digest({ kind: "print-config-revisions" });
    const cursor = pageCursor(input.cursor, filterHash, "print config cursor");
    const rows = await this.prisma.printConfigRevision.findMany({
      include: { revision: { select: { digest: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    return pageResult(rows, pageLimit(input.limit), filterHash, (row) => ({
      id: row.id,
      digest: row.revision.digest,
      quality: row.quality,
      infillPercent: row.infillPercent,
      layerHeightMicrometers: row.layerHeightMicrometers,
      supportsEnabled: row.supportsEnabled,
      brimEnabled: row.brimEnabled,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async printConfigRevisionDetail(
    operator: OperatorContext,
    id: string,
  ): Promise<PrintConfigRevisionDetailDto> {
    this.requireRead(operator);
    assertUuid(id, "id");
    const row = await this.prisma.printConfigRevision.findUnique({
      where: { id },
      include: { revision: { select: { digest: true } } },
    });
    if (!row) throw new NotFoundException("Print config was not found");
    return {
      id: row.id,
      digest: row.revision.digest,
      quality: row.quality,
      infillPercent: row.infillPercent,
      layerHeightMicrometers: row.layerHeightMicrometers,
      supportsEnabled: row.supportsEnabled,
      brimEnabled: row.brimEnabled,
      createdAt: row.createdAt.toISOString(),
      settings: row.settings as Record<string, unknown>,
    };
  }

  async priceLists(
    operator: OperatorContext,
    input: PageInput,
  ): Promise<PriceListPageDto> {
    this.requireRead(operator);
    const filterHash = digest({ kind: "price-lists" });
    const cursor = pageCursor(input.cursor, filterHash, "price lists cursor");
    const rows = await this.prisma.priceList.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    return pageResult(rows, pageLimit(input.limit), filterHash, (row) => ({
      id: row.id,
      revision: row.revision,
      termsRevision: row.termsRevision,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async priceListDetail(
    operator: OperatorContext,
    id: string,
  ): Promise<PriceListDetailDto> {
    this.requireRead(operator);
    assertUuid(id, "id");
    const row = await this.prisma.priceList.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Price list was not found");
    return {
      id: row.id,
      revision: row.revision,
      termsRevision: row.termsRevision,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
      parameters: row.parameters as unknown as PriceListDetailDto["parameters"],
    };
  }

  async commercialPolicySelection(
    operator: OperatorContext,
    currency: string,
  ): Promise<{
    currency: string;
    priceListId: string;
    selectionVersion: number;
  }> {
    this.requireRead(operator);
    if (currency !== "CZK") {
      throw new NotFoundException("Commercial policy selection was not found");
    }
    const selected = await this.prisma.commercialPolicySelection.findUnique({
      where: { currency },
    });
    if (!selected) {
      throw new NotFoundException("Commercial policy selection was not found");
    }
    return {
      currency: selected.currency,
      priceListId: selected.priceListId,
      selectionVersion: selected.selectionVersion,
    };
  }

  async machineCapabilities(
    operator: OperatorContext,
    input: PageInput,
  ): Promise<MachineCapabilityPageDto> {
    this.requireRead(operator);
    const filterHash = digest({ kind: "machine-capabilities" });
    const cursor = pageCursor(
      input.cursor,
      filterHash,
      "machine capabilities cursor",
    );
    const rows = await this.prisma.machineCapability.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    return pageResult(rows, pageLimit(input.limit), filterHash, (row) => ({
      id: row.id,
      capabilityKey: row.capabilityKey,
      manufacturer: row.manufacturer,
      model: row.model,
      buildVolumeXMicrometers: row.buildVolumeXMicrometers.toString(),
      buildVolumeYMicrometers: row.buildVolumeYMicrometers.toString(),
      buildVolumeZMicrometers: row.buildVolumeZMicrometers.toString(),
      supportedNozzleMicrometers: row.supportedNozzleMicrometers,
      supportedMaterials: row.supportedMaterials,
    }));
  }

  async machineCapabilityDetail(operator: OperatorContext, id: string) {
    this.requireRead(operator);
    assertUuid(id, "id");
    const row = await this.prisma.machineCapability.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException("Machine capability was not found");
    return {
      id: row.id,
      capabilityKey: row.capabilityKey,
      manufacturer: row.manufacturer,
      model: row.model,
      buildVolumeXMicrometers: row.buildVolumeXMicrometers.toString(),
      buildVolumeYMicrometers: row.buildVolumeYMicrometers.toString(),
      buildVolumeZMicrometers: row.buildVolumeZMicrometers.toString(),
      supportedNozzleMicrometers: row.supportedNozzleMicrometers,
      supportedMaterials: row.supportedMaterials,
    };
  }

  async machines(
    operator: OperatorContext,
    nodeId: string,
    input: PageInput,
  ): Promise<MachinePageDto> {
    this.requireNode(operator, nodeId);
    const filterHash = digest({ nodeId, kind: "machines" });
    const cursor = pageCursor(input.cursor, filterHash, "machines cursor");
    const rows = await this.prisma.machine.findMany({
      where: { nodeId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    return pageResult(rows, pageLimit(input.limit), filterHash, (row) => ({
      id: row.id,
      nodeId: row.nodeId,
      machineCapabilityId: row.machineCapabilityId,
      code: row.code,
      displayName: row.displayName,
      status: row.status,
      installedNozzleMicrometers: row.installedNozzleMicrometers,
    }));
  }

  async machineAvailability(
    operator: OperatorContext,
    nodeId: string,
    machineId: string,
    fromInput: string,
    toInput: string,
  ): Promise<MachineAvailabilityReadDto> {
    this.requireNode(operator, nodeId);
    assertUuid(machineId, "machineId");
    const from = strictInstant("from", fromInput);
    const to = strictInstant("to", toInput);
    if (from >= to || to.getTime() - from.getTime() > MAX_RANGE_MILLISECONDS) {
      throw new BadRequestException("availability range is invalid");
    }
    const machine = await this.prisma.machine.findFirst({
      where: { id: machineId, nodeId },
      include: {
        availabilitySelection: {
          include: {
            revision: { include: { windows: { orderBy: { ordinal: "asc" } } } },
          },
        },
      },
    });
    if (!machine) throw new NotFoundException("Machine was not found");
    const occupied = await this.prisma.capacityReservation.findMany({
      where: {
        machineId,
        nodeId,
        status: { in: ["RESERVED", "HELD", "SCHEDULED", "PRINTING"] },
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 1001,
    });
    if (occupied.length > 1000) {
      throw new BadRequestException(
        "availability range contains too many occupied intervals",
      );
    }
    return {
      machineId,
      revisionId: machine.availabilitySelection?.revisionId ?? null,
      selectionVersion: machine.availabilitySelection?.selectionVersion ?? null,
      windows:
        machine.availabilitySelection?.revision.windows.map((window) => ({
          ordinal: window.ordinal,
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
        })) ?? [],
      occupiedIntervals: occupied.map((row) => ({
        id: row.id,
        machineId: row.machineId,
        status: row.status,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
    };
  }

  async inventories(
    operator: OperatorContext,
    nodeId: string,
    input: NodePageInput,
  ): Promise<InventoryPageDto> {
    this.requireNode(operator, nodeId);
    if (input.machineId) assertUuid(input.machineId, "machineId");
    const filterHash = digest({
      nodeId,
      machineId: input.machineId,
      kind: "inventories",
    });
    const cursor = pageCursor(input.cursor, filterHash, "inventories cursor");
    const rows = await this.prisma.inventory.findMany({
      where: {
        nodeId,
        ...(input.machineId ? { machineId: input.machineId } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    const receiptIds = new Set(
      (
        await this.prisma.inventoryReceipt.findMany({
          where: {
            nodeId,
            inventoryId: { in: rows.map(({ id }) => id) },
            kind: "INITIAL",
          },
          select: { inventoryId: true },
        })
      ).map(({ inventoryId }) => inventoryId),
    );
    return pageResult(rows, pageLimit(input.limit), filterHash, (row) => ({
      id: row.id,
      machineId: row.machineId,
      sku: row.sku,
      material: row.material,
      color: row.color,
      remainingMilligrams: row.remainingMilligrams.toString(),
      reservedMilligrams: row.reservedMilligrams.toString(),
      availableMilligrams: (
        row.remainingMilligrams - row.reservedMilligrams
      ).toString(),
      status: row.status,
      mountStatus: row.mountStatus,
      receiptCoverage: receiptIds.has(row.id)
        ? ("RECORDED" as const)
        : ("UNKNOWN" as const),
    }));
  }

  async inventoryDetail(
    operator: OperatorContext,
    nodeId: string,
    id: string,
  ): Promise<InventoryDetailDto> {
    this.requireNode(operator, nodeId);
    assertUuid(id, "id");
    const row = await this.prisma.inventory.findFirst({
      where: { id, nodeId },
      include: { receipts: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    if (!row) throw new NotFoundException("Inventory was not found");
    return {
      id: row.id,
      nodeId: row.nodeId,
      machineId: row.machineId,
      sku: row.sku,
      material: row.material,
      color: row.color,
      remainingMilligrams: row.remainingMilligrams.toString(),
      reservedMilligrams: row.reservedMilligrams.toString(),
      availableMilligrams: (
        row.remainingMilligrams - row.reservedMilligrams
      ).toString(),
      status: row.status,
      mountStatus: row.mountStatus,
      receiptCoverage: row.receipts.some(({ kind }) => kind === "INITIAL")
        ? "RECORDED"
        : "UNKNOWN",
      vendor: row.vendor,
      lotCode: row.lotCode,
      priceMinorUnitsNumerator: row.priceMinorUnitsNumerator.toString(),
      priceMinorUnitsDenominator: row.priceMinorUnitsDenominator.toString(),
      currency: row.currency,
      receipts: row.receipts.map((receipt) => ({
        id: receipt.id,
        kind: receipt.kind,
        supersedesReceiptId: receipt.supersedesReceiptId,
        receivedMilligrams: receipt.receivedMilligrams.toString(),
        vendor: receipt.vendor,
        currency: receipt.currency,
        priceMinorUnitsNumerator: receipt.priceMinorUnitsNumerator.toString(),
        priceMinorUnitsDenominator:
          receipt.priceMinorUnitsDenominator.toString(),
        purchasedAt: receipt.purchasedAt.toISOString(),
        reason: receipt.reason,
        createdAt: receipt.createdAt.toISOString(),
      })),
    };
  }

  async calibrations(
    operator: OperatorContext,
    nodeId: string,
    input: NodePageInput,
  ): Promise<MachineCalibrationPageDto> {
    this.requireNode(operator, nodeId);
    if (input.machineId) assertUuid(input.machineId, "machineId");
    const filterHash = digest({
      nodeId,
      machineId: input.machineId,
      kind: "calibrations",
    });
    const cursor = pageCursor(input.cursor, filterHash, "calibrations cursor");
    const rows = await this.prisma.machineCalibration.findMany({
      where: {
        nodeId,
        ...(input.machineId ? { machineId: input.machineId } : {}),
      },
      include: { revision: { select: { digest: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    return pageResult(rows, pageLimit(input.limit), filterHash, (row) => ({
      id: row.id,
      machineId: row.machineId,
      digest: row.revision.digest,
      state: row.state,
      flowRatioPartsPerMillion: row.flowRatioPartsPerMillion,
      xyCompensationMicrometers: row.xyCompensationMicrometers,
      elephantFootCompensationMicrometers:
        row.elephantFootCompensationMicrometers,
    }));
  }

  async capacityReservations(
    operator: OperatorContext,
    nodeId: string,
    input: CapacityPageInput,
  ): Promise<CapacityReservationPageDto> {
    this.requireNode(operator, nodeId);
    if (input.machineId) assertUuid(input.machineId, "machineId");
    const from = strictInstant("from", input.from);
    const to = strictInstant("to", input.to);
    if (from >= to || to.getTime() - from.getTime() > MAX_RANGE_MILLISECONDS) {
      throw new BadRequestException("capacity range is invalid");
    }
    const status = capacityReservationStatus(input.status);
    const filterHash = digest({
      nodeId,
      machineId: input.machineId,
      status,
      from: from.toISOString(),
      to: to.toISOString(),
      kind: "capacity-reservations",
    });
    const limit = pageLimit(input.limit);
    const cursor = input.cursor
      ? parseStartsAtCursor(input.cursor, filterHash, "capacity cursor")
      : undefined;
    const rows = await this.prisma.capacityReservation.findMany({
      where: {
        nodeId,
        ...(input.machineId ? { machineId: input.machineId } : {}),
        ...(status ? { status } : {}),
        startsAt: { lt: to },
        endsAt: { gt: from },
        ...(cursor
          ? {
              OR: [
                { startsAt: { gt: new Date(cursor.startsAt) } },
                {
                  startsAt: new Date(cursor.startsAt),
                  id: { gt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        machineId: row.machineId,
        status: row.status,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      ...(rows.length > limit && last
        ? {
            nextCursor: encodeCursor({
              startsAt: last.startsAt.toISOString(),
              id: last.id,
              filterHash,
            }),
          }
        : {}),
    };
  }

  private requireRead(operator: OperatorContext): void {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
  }

  private requireNode(operator: OperatorContext, nodeId: string): void {
    this.requireRead(operator);
    assertUuid(nodeId, "nodeId");
    if (operatorNode(operator) !== nodeId) {
      throw new NotFoundException("Node was not found");
    }
  }
}

function orderListItem(row: {
  id: string;
  publicReference: string;
  status: string;
  createdAt: Date;
  confirmedAt: Date | null;
}): OperatorOrderListItemDto {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: iso(row.confirmedAt),
  };
}

function jobListItem(row: {
  id: string;
  orderId: string;
  orderPhaseId: string;
  status: string;
  replacesJobId: string | null;
  createdAt: Date;
  phaseResourcePlanJob: { candidateResourceEstimate: { machineId: string } };
}): OperatorJobListItemDto {
  return {
    id: row.id,
    orderId: row.orderId,
    orderPhaseId: row.orderPhaseId,
    machineId: row.phaseResourcePlanJob.candidateResourceEstimate.machineId,
    status: row.status,
    replacesJobId: row.replacesJobId,
    createdAt: row.createdAt.toISOString(),
  };
}

function referenceProfile(row: {
  id: string;
  revision: { digest: string };
  material: string;
  quality: string;
  slicerEngine: string;
  slicerVersion: string;
  state: string;
  createdAt: Date;
}): ReferenceProfileReadDto {
  return {
    id: row.id,
    digest: row.revision.digest,
    material: row.material,
    quality: row.quality,
    slicerEngine: row.slicerEngine,
    slicerVersion: row.slicerVersion,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
  };
}

function machineProfile(row: {
  id: string;
  revision: { digest: string };
  machineCapabilityId: string;
  referenceProfileId: string;
  material: string;
  quality: string;
  slicerEngine: string;
  slicerVersion: string;
  state: string;
  nozzleDiameterMicrometers: number;
  productionArtifactFormat: string;
  createdAt: Date;
}): MachineProfileReadDto {
  return {
    ...referenceProfile(row),
    machineCapabilityId: row.machineCapabilityId,
    referenceProfileId: row.referenceProfileId,
    nozzleDiameterMicrometers: row.nozzleDiameterMicrometers,
    productionArtifactFormat: row.productionArtifactFormat,
  };
}

function pageResult<T extends { id: string }, R>(
  rows: readonly T[],
  limit: number,
  filterHash: string,
  project: (row: T) => R,
): { items: R[]; nextCursor?: string } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(project),
    ...(rows.length > limit && last
      ? { nextCursor: encodeCursor({ id: last.id, filterHash }) }
      : {}),
  };
}

function acceptedPreflightFindingCodes(
  item: OrderedItemPreflightScope,
  snapshot: AutomaticQuoteItemSnapshot | undefined,
): string[] {
  if (
    !snapshot ||
    snapshot.ordinal !== item.ordinal ||
    snapshot.sourceModelFileId !== item.sourceModelFileId ||
    snapshot.targetModelGeometryId !== item.modelGeometryId ||
    snapshot.printConfigRevisionId !== item.printConfigRevisionId ||
    snapshot.referencePartsPerPlate !== item.referencePartsPerPlate
  ) {
    return [];
  }
  const selectedReferences = [
    item.primaryReferenceSliceResult,
    item.tailReferenceSliceResult,
  ].filter((slice): slice is SelectedReferenceSlice => slice !== null);
  if (
    selectedReferences.length === 0 ||
    selectedReferences.some(
      (slice) =>
        slice.kind !== SliceKind.REFERENCE ||
        slice.modelGeometryId !== item.modelGeometryId ||
        slice.printConfigRevisionId !== item.printConfigRevisionId ||
        slice.referenceProfileId !== snapshot.referenceProfileId,
    )
  ) {
    return [];
  }
  return [
    ...new Set(
      snapshot.riskDecisions
        .filter(
          (decision) =>
            decision.configurationFingerprint ===
            snapshot.configurationFingerprint,
        )
        .map((decision) => decision.preflightFinding.code),
    ),
  ].sort();
}

function acceptedPreflightFindings(
  item: OrderedItemPreflightScope,
  snapshot: AutomaticQuoteItemSnapshot | undefined,
) {
  if (!snapshot) return [];
  const acceptedCodes = new Set(acceptedPreflightFindingCodes(item, snapshot));
  return snapshot.riskDecisions
    .filter(
      (decision) =>
        decision.configurationFingerprint ===
          snapshot.configurationFingerprint &&
        acceptedCodes.has(decision.preflightFinding.code),
    )
    .map((decision) => ({
      findingId: decision.preflightFinding.id,
      code: decision.preflightFinding.code,
      severity: decision.preflightFinding.severity,
      message: decision.preflightFinding.message,
      acknowledgementKey: decision.acknowledgementKey,
    }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
}

function orderTimelineEvent(event: {
  id: string;
  eventType: string;
  actorKind: string;
  reasonCode: string | null;
  reason: string | null;
  createdAt: Date;
}) {
  return {
    id: event.id,
    eventType: event.eventType,
    actorKind: event.actorKind,
    reasonCode: event.reasonCode,
    reason: event.reason,
    occurredAt: event.createdAt.toISOString(),
  };
}

function operatorRefund(
  refund: Prisma.RefundTransactionGetPayload<object>,
): OperatorRefundTransactionDto {
  return {
    id: refund.id,
    claimId: refund.claimId,
    priceAdjustmentId: refund.priceAdjustmentId,
    amountMinor: refund.amountMinor.toString(),
    reason: refund.reason,
    status: refund.status,
    requestedAt: refund.requestedAt.toISOString(),
    completedAt: iso(refund.completedAt),
    replacesRefundTransactionId: refund.replacesRefundTransactionId,
    replacesFailureProviderEventId: refund.replacesFailureProviderEventId,
    providerResultEventId: refund.providerResultEventId,
    sourceSuccessProviderEventId: refund.sourceSuccessProviderEventId,
    provider: refund.provider,
    providerRefundId: refund.providerRefundId,
  };
}

function operatorSettlement(
  settlement: Prisma.OrderSettlementGetPayload<object>,
): OperatorSettlementDto {
  return {
    id: settlement.id,
    kind: settlement.kind,
    currency: settlement.currency,
    contractTotalMinor: settlement.contractTotalMinor.toString(),
    capturedTotalMinor: settlement.capturedTotalMinor.toString(),
    refundAmountMinor: settlement.refundAmountMinor.toString(),
    amountDueMinor: settlement.amountDueMinor.toString(),
    refundableBalanceMinor: settlement.refundableBalanceMinor.toString(),
    settledAt: settlement.settledAt.toISOString(),
  };
}

type FulfilmentHistoryKind =
  | "jobs"
  | "shipments"
  | "slots"
  | "replacementRequests"
  | "claims"
  | "priceAdjustments";

type ClaimChildHistoryKind =
  "resolutions" | "refunds" | "reshipmentAuthorizations";

function isClaimChildHistoryKind(
  value: string,
): value is ClaimChildHistoryKind {
  return ["resolutions", "refunds", "reshipmentAuthorizations"].includes(value);
}

function isFulfilmentHistoryKind(
  value: string,
): value is FulfilmentHistoryKind {
  return [
    "jobs",
    "shipments",
    "slots",
    "replacementRequests",
    "claims",
    "priceAdjustments",
  ].includes(value);
}

function orderedHistory<T extends { id: string; createdAt: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
  );
}

function historySlice<T extends { id: string; createdAt: string }>(
  rows: readonly T[],
  limit: number,
): { items: T[]; nextCursor?: string } {
  const ordered = orderedHistory(rows);
  const items = ordered.slice(0, limit);
  return {
    items,
    ...(ordered.length > limit ? { nextCursor: items.at(-1)!.id } : {}),
  };
}

function fulfilmentHistoryPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): OperatorFulfilmentHistoryPageDto {
  const page = rows.slice(0, limit);
  return {
    items: JSON.parse(
      JSON.stringify(page, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ) as OperatorFulfilmentHistoryPageDto["items"],
    ...(rows.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
  };
}

function claimChildHistoryPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): OperatorClaimChildHistoryPageDto {
  const page = rows.slice(0, limit);
  return {
    items: JSON.parse(
      JSON.stringify(page, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ) as OperatorClaimChildHistoryPageDto["items"],
    ...(rows.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
  };
}

function boundedClaim(
  claim: FulfilmentClaimDto,
  limit: number,
): FulfilmentClaimDto {
  const resolutions = historySlice(claim.resolutions, limit);
  const refunds = historySlice(claim.refunds, limit);
  const reshipmentAuthorizations = historySlice(
    claim.reshipmentAuthorizations,
    limit,
  );
  return {
    ...claim,
    resolutions: resolutions.items,
    refunds: refunds.items.map(claimRefund),
    reshipmentAuthorizations: reshipmentAuthorizations.items,
    historyNextCursors: {
      ...(resolutions.nextCursor
        ? { resolutions: resolutions.nextCursor }
        : {}),
      ...(refunds.nextCursor ? { refunds: refunds.nextCursor } : {}),
      ...(reshipmentAuthorizations.nextCursor
        ? { reshipmentAuthorizations: reshipmentAuthorizations.nextCursor }
        : {}),
    },
  };
}

function claimRefund(refund: FulfilmentRefundDto): FulfilmentRefundDto {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    claimId: refund.claimId,
    priceAdjustmentId: refund.priceAdjustmentId,
    provider: refund.provider,
    providerRefundId: refund.providerRefundId,
    amountMinor: refund.amountMinor,
    reason: refund.reason,
    status: refund.status,
    requestedAt: refund.requestedAt,
    completedAt: refund.completedAt,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
  };
}

function boundedFulfilment(
  full: FulfilmentProjectionDto,
  limit: number,
): {
  projection: FulfilmentProjectionDto;
  nextCursors: OperatorFulfilmentHistoryCursorsDto;
} {
  const jobs = historySlice(full.jobs, limit);
  const shipments = historySlice(full.shipments, limit);
  const slots = historySlice(full.slots, limit);
  const replacementRequests = historySlice(full.replacementRequests, limit);
  const claims = historySlice(full.claims, limit);
  const priceAdjustments = historySlice(full.priceAdjustments, limit);
  return {
    projection: {
      ...full,
      jobs: jobs.items,
      shipments: shipments.items,
      slots: slots.items,
      replacementRequests: replacementRequests.items,
      claims: claims.items.map((claim) => boundedClaim(claim, limit)),
      priceAdjustments: priceAdjustments.items,
    },
    nextCursors: {
      ...(jobs.nextCursor ? { jobs: jobs.nextCursor } : {}),
      ...(shipments.nextCursor ? { shipments: shipments.nextCursor } : {}),
      ...(slots.nextCursor ? { slots: slots.nextCursor } : {}),
      ...(replacementRequests.nextCursor
        ? { replacementRequests: replacementRequests.nextCursor }
        : {}),
      ...(claims.nextCursor ? { claims: claims.nextCursor } : {}),
      ...(priceAdjustments.nextCursor
        ? { priceAdjustments: priceAdjustments.nextCursor }
        : {}),
    },
  };
}

function operatorPayment(
  payment: Prisma.PaymentGetPayload<{ include: { refunds: true } }>,
): OperatorPaymentDto {
  return {
    id: payment.id,
    orderPriceBindingId: payment.orderPriceBindingId,
    priceSnapshotId: payment.priceSnapshotId,
    role: payment.role,
    provider: payment.provider,
    checkoutMethod: payment.checkoutMethod,
    merchantReference: payment.merchantReference,
    requestedAmountMinor: payment.requestedAmountMinor.toString(),
    capturedAmountMinor: payment.capturedAmountMinor?.toString() ?? null,
    currency: payment.currency,
    status: payment.status,
    captureAuthorized: payment.captureAuthorized,
    captureCutoffAt: iso(payment.captureCutoffAt),
    checkoutCaptureExpiresAt: iso(payment.checkoutCaptureExpiresAt),
    balanceDueAt: iso(payment.balanceDueAt),
    capturedAt: iso(payment.capturedAt),
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    refunds: payment.refunds.slice(0, 25).map(operatorRefund),
    ...(payment.refunds.length > 25
      ? { refundsNextCursor: payment.refunds[24]!.id }
      : {}),
  };
}

function orderBarriers(
  fulfilment: FulfilmentProjectionDto,
  payments: ReadonlyArray<{
    role: string;
    status: string;
    refunds: ReadonlyArray<{
      status: string;
      amountMinor: bigint;
      priceAdjustmentId: string | null;
    }>;
  }>,
  settlements: ReadonlyArray<{ amountDueMinor: bigint }>,
  compensation: bigint,
): string[] {
  const codes: string[] = [];
  if (compensation > 0n) codes.push("COMPENSATION_DUE");
  if (
    payments.some((payment) =>
      payment.refunds.some((refund) =>
        ["PENDING", "FAILED", "SUSPENDED"].includes(refund.status),
      ),
    )
  )
    codes.push("REFUND_UNRESOLVED");
  if (
    settlements.at(-1)?.amountDueMinor &&
    settlements.at(-1)!.amountDueMinor > 0n
  )
    codes.push("BALANCE_DUE");
  if (
    fulfilment.shipments.some((shipment) =>
      ["LABEL_CREATED", "CANCELLATION_PENDING"].includes(shipment.status),
    )
  )
    codes.push("LIVE_LABEL");
  if (
    fulfilment.shipments.some((shipment) =>
      ["HANDED_OVER", "IN_TRANSIT", "LOST", "RETURNED"].includes(
        shipment.status,
      ),
    )
  )
    codes.push("SHIPMENT_UNRESOLVED");
  if (
    fulfilment.replacementRequests.some((request) =>
      ["OPEN", "REFUND_REQUIRED"].includes(request.status),
    )
  )
    codes.push("REPLACEMENT_UNRESOLVED");
  if (
    fulfilment.claims.some((claim) => ["OPEN", "ACTIVE"].includes(claim.status))
  )
    codes.push("CLAIM_UNRESOLVED");
  if (
    fulfilment.priceAdjustments.some((adjustment) => {
      const refunded = payments.reduce(
        (sum, payment) =>
          sum +
          payment.refunds
            .filter(
              (refund) =>
                refund.priceAdjustmentId === adjustment.id &&
                refund.status === "SUCCEEDED",
            )
            .reduce((amount, refund) => amount + refund.amountMinor, 0n),
        0n,
      );
      return BigInt(adjustment.refundRequiredMinor) > refunded;
    })
  )
    codes.push("ADJUSTMENT_REFUND_DUE");
  return codes;
}

function orderActions(
  operator: OperatorContext,
  fulfilment: FulfilmentProjectionDto,
  shipmentPlans: ReadonlyArray<{ id: string }>,
  payments: ReadonlyArray<{
    role: string;
    status: string;
    refunds: ReadonlyArray<{ priceAdjustmentId: string | null }>;
  }>,
  barriers: readonly string[],
): OperatorActionDto[] {
  const actions: OperatorActionDto[] = [];
  const canOperate = operator.permissions.includes(
    OPERATOR_PERMISSIONS.OPERATIONS_WRITE,
  );
  const canFinance = operator.permissions.includes(
    OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION,
  );
  const canPay = operator.permissions.includes(
    OPERATOR_PERMISSIONS.PAYMENTS_WRITE,
  );
  const productionOpen = ![
    "CANCELLED",
    "CANCELLED_SETTLED",
    "REFUNDED",
    "COMPLETED",
    "EXPIRED",
  ].includes(fulfilment.orderStatus);
  const add = (
    allowed: boolean,
    action: string,
    targetType: string,
    targetId: string,
    blockingCodes: readonly string[] = [],
    requiresReason = false,
    requiresConfirmation = false,
  ) => {
    if (allowed)
      actions.push({
        action,
        targetType,
        targetId,
        enabled: blockingCodes.length === 0,
        blockingCodes: [...blockingCodes],
        requiresReason,
        requiresConfirmation,
      });
  };
  for (const job of fulfilment.jobs) {
    add(canOperate && job.status === "CREATED", "ACCEPT_JOB", "JOB", job.id);
    add(
      canOperate && job.status === "GCODE_READY",
      "START_PRINTING",
      "JOB",
      job.id,
      ["JOB_DETAIL_REQUIRED"],
    );
    add(
      canOperate && job.status === "PRINTING",
      "FINISH_PRINTING",
      "JOB",
      job.id,
      ["ACTUAL_MATERIAL_REQUIRED"],
    );
    add(canOperate && job.status === "PRINTED", "SUBMIT_QC", "JOB", job.id, [
      "QC_EVIDENCE_REQUIRED",
    ]);
    add(
      canOperate && job.status === "PHOTO_SUBMITTED",
      "APPROVE_QC",
      "JOB",
      job.id,
    );
    if (canOperate && job.status === "QC_APPROVED") {
      const shipment = fulfilment.shipments.find(
        (candidate) =>
          candidate.shipmentPlanId === job.shipmentPlanId &&
          ["PLANNED", "LABEL_CREATED"].includes(candidate.status),
      );
      add(
        true,
        "PACK_JOB",
        "JOB",
        job.id,
        shipment ? [] : ["MATCHING_SHIPMENT_REQUIRED"],
      );
    }
    add(
      canOperate &&
        [
          "ACCEPTED",
          "GCODE_READY",
          "PRINTING",
          "PRINTED",
          "PHOTO_SUBMITTED",
          "QC_APPROVED",
          "PACKED",
        ].includes(job.status),
      "FAIL_JOB",
      "JOB",
      job.id,
      ["FAILURE_DETAILS_REQUIRED"],
      true,
      true,
    );
    add(
      canOperate && ["FAILED", "QC_REJECTED"].includes(job.status),
      "PREPARE_REPLACEMENT",
      "JOB",
      job.id,
      ["FRESH_RESERVATION_REQUIRED"],
      true,
    );
  }
  for (const shipment of fulfilment.shipments) {
    add(
      canOperate && productionOpen && shipment.status === "PLANNED",
      "CREATE_LABEL",
      "SHIPMENT",
      shipment.id,
      ["CARRIER_REFERENCE_REQUIRED"],
    );
    add(
      canOperate && shipment.status === "CANCELLATION_PENDING",
      "CONFIRM_LABEL_VOID",
      "SHIPMENT",
      shipment.id,
      ["PROVIDER_VOID_EVIDENCE_REQUIRED"],
      true,
      true,
    );
    add(
      canOperate && productionOpen && shipment.status === "LABEL_CREATED",
      "HANDOFF_SHIPMENT",
      "SHIPMENT",
      shipment.id,
      ["PROVIDER_ACCEPTANCE_EVIDENCE_REQUIRED"],
      false,
      true,
    );
    add(
      canOperate && ["HANDED_OVER", "IN_TRANSIT"].includes(shipment.status),
      "RECORD_DELIVERY_EVENT",
      "SHIPMENT",
      shipment.id,
      ["PROVIDER_EVENT_REQUIRED"],
    );
  }
  for (const plan of shipmentPlans) {
    const planShipments = fulfilment.shipments.filter(
      (shipment) => shipment.shipmentPlanId === plan.id,
    );
    add(
      canOperate &&
        productionOpen &&
        !planShipments.some(
          (shipment) =>
            !["CANCELLED", "DELIVERED", "RECOVERED"].includes(shipment.status),
        ),
      "CREATE_SHIPMENT",
      "SHIPMENT_PLAN",
      plan.id,
      planShipments.length > 0 ? ["REPLACED_SHIPMENT_ID_REQUIRED"] : [],
    );
  }
  add(
    canFinance &&
      !["CANCELLED", "CANCELLED_SETTLED", "REFUNDED", "COMPLETED"].includes(
        fulfilment.orderStatus,
      ),
    "CANCEL_ORDER",
    "ORDER",
    fulfilment.orderId,
    [
      ...barriers,
      ...(fulfilment.jobs.some((job) => job.status === "PRINTING")
        ? ["PRINTING_CONSUMPTION_REQUIRED"]
        : []),
    ],
    true,
    true,
  );
  add(
    canPay && fulfilment.orderStatus === "AWAITING_BALANCE",
    "CREATE_BALANCE_PAYMENT",
    "ORDER",
    fulfilment.orderId,
    payments.some(
      (payment) =>
        payment.role === "BALANCE" &&
        ["CREATED", "PENDING", "CAPTURED", "REFUND_PENDING"].includes(
          payment.status,
        ),
    )
      ? ["BALANCE_PAYMENT_EXISTS"]
      : ["CHECKOUT_METHOD_REQUIRED"],
  );
  add(
    canOperate && fulfilment.orderStatus === "DELIVERED",
    "COMPLETE_ORDER",
    "ORDER",
    fulfilment.orderId,
    barriers,
  );
  add(
    canOperate &&
      fulfilment.shipments.some((shipment) => shipment.status === "DELIVERED"),
    "CREATE_CLAIM",
    "ORDER",
    fulfilment.orderId,
    ["CLAIM_DETAILS_REQUIRED"],
    true,
  );
  add(
    canFinance,
    "CREATE_PRICE_ADJUSTMENT",
    "ORDER",
    fulfilment.orderId,
    ["ADJUSTMENT_DETAILS_REQUIRED"],
    true,
    true,
  );
  for (const request of fulfilment.replacementRequests) {
    add(
      canOperate && request.status === "OPEN",
      "EXPIRE_REPLACEMENT",
      "REPLACEMENT_REQUEST",
      request.id,
      ["EXPIRY_REASON_REQUIRED"],
      true,
      true,
    );
  }
  for (const adjustment of fulfilment.priceAdjustments) {
    add(
      canFinance && BigInt(adjustment.refundRequiredMinor) > 0n,
      "REFUND_ADJUSTMENT",
      "PRICE_ADJUSTMENT",
      adjustment.id,
      payments.some((payment) =>
        payment.refunds.some(
          (refund) => refund.priceAdjustmentId === adjustment.id,
        ),
      )
        ? ["REFUND_WORK_EXISTS"]
        : ["REFUND_REASON_REQUIRED"],
      true,
      true,
    );
  }
  for (const claim of fulfilment.claims) {
    add(
      canFinance && ["OPEN", "ACTIVE"].includes(claim.status),
      "REFUND_CLAIM",
      "CLAIM",
      claim.id,
      ["REFUND_ALLOCATION_REQUIRED"],
      true,
      true,
    );
    add(
      canFinance && claim.status === "OPEN",
      "REJECT_CLAIM",
      "CLAIM",
      claim.id,
      ["REJECTION_REASON_REQUIRED"],
      true,
      true,
    );
    add(
      canOperate && claim.status === "OPEN",
      "WITHDRAW_CLAIM",
      "CLAIM",
      claim.id,
      ["WITHDRAWAL_REASON_REQUIRED"],
      true,
      true,
    );
  }
  return actions;
}

function operatorReferenceSlice(
  slice: Readonly<{
    id: string;
    kind: string;
    modelGeometryId: string;
    printConfigRevisionId: string;
    referenceProfileId: string | null;
    packageQuantity: number | null;
    packagePlateCount: number | null;
    partsPerPlate: number;
    estimatedPrintSeconds: bigint;
    estimatedMaterialMilligrams: bigint;
    slicerEngine: string;
    slicerVersion: string;
    createdAt: Date;
  }> | null,
) {
  if (!slice) return null;
  return {
    id: slice.id,
    kind: slice.kind,
    modelGeometryId: slice.modelGeometryId,
    printConfigRevisionId: slice.printConfigRevisionId,
    referenceProfileId: slice.referenceProfileId,
    packageQuantity: slice.packageQuantity,
    packagePlateCount: slice.packagePlateCount,
    partsPerPlate: slice.partsPerPlate,
    estimatedPrintSeconds: slice.estimatedPrintSeconds.toString(),
    estimatedMaterialMilligrams: slice.estimatedMaterialMilligrams.toString(),
    slicerEngine: slice.slicerEngine,
    slicerVersion: slice.slicerVersion,
    createdAt: slice.createdAt.toISOString(),
  };
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new BadRequestException("limit is invalid");
  }
  return value;
}

function orderStatus(value: string | undefined): OrderStatus | undefined {
  if (value === undefined) return;
  if (!Object.values(OrderStatus).includes(value as OrderStatus)) {
    throw new BadRequestException("status is invalid");
  }
  return value as OrderStatus;
}

function jobStatus(value: string | undefined): JobStatus | undefined {
  if (value === undefined) return;
  if (!Object.values(JobStatus).includes(value as JobStatus))
    throw new BadRequestException("status is invalid");
  return value as JobStatus;
}

function capacityReservationStatus(
  value: string | undefined,
): CapacityReservationStatus | undefined {
  if (value === undefined) return;
  if (
    !Object.values(CapacityReservationStatus).includes(
      value as CapacityReservationStatus,
    )
  ) {
    throw new BadRequestException("status is invalid");
  }
  return value as CapacityReservationStatus;
}

function pageCursor(
  value: string | undefined,
  filterHash: string,
  name: string,
): Cursor | undefined {
  return value ? parseCursor(value, filterHash, name) : undefined;
}

function parseTimeCursor(
  value: string,
  filterHash: string,
  name: string,
): TimeCursor {
  const cursor = parseCursor(value, filterHash, name) as Partial<TimeCursor>;
  if (typeof cursor.createdAt !== "string")
    throw new BadRequestException(`${name} is invalid`);
  strictInstant(`${name} createdAt`, cursor.createdAt);
  return cursor as TimeCursor;
}

function parseStartsAtCursor(
  value: string,
  filterHash: string,
  name: string,
): StartsAtCursor {
  const cursor = parseCursor(
    value,
    filterHash,
    name,
  ) as Partial<StartsAtCursor>;
  if (typeof cursor.startsAt !== "string")
    throw new BadRequestException(`${name} is invalid`);
  strictInstant(`${name} startsAt`, cursor.startsAt);
  return cursor as StartsAtCursor;
}

function parseActivationNoticeCursor(
  value: string,
  filterHash: string,
  name: string,
): ActivationNoticeCursor {
  const cursor = parseCursor(
    value,
    filterHash,
    name,
  ) as Partial<ActivationNoticeCursor>;
  if (typeof cursor.activatedAt !== "string") {
    throw new BadRequestException(`${name} is invalid`);
  }
  strictInstant(`${name} activatedAt`, cursor.activatedAt);
  return cursor as ActivationNoticeCursor;
}

function parseCursor(value: string, filterHash: string, name: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.id !== "string" ||
      typeof cursor.filterHash !== "string" ||
      !UUID_PATTERN.test(cursor.id) ||
      cursor.filterHash !== filterHash
    )
      throw new Error();
    return cursor as Cursor;
  } catch {
    throw new BadRequestException(`${name} is invalid`);
  }
}

function encodeCursor(
  value: Cursor | TimeCursor | StartsAtCursor | ActivationNoticeCursor,
): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function strictInstant(name: string, value: string): Date {
  if (!INSTANT_PATTERN.test(value))
    throw new BadRequestException(`${name} is an ISO instant`);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) throw new BadRequestException(`${name} is an ISO instant`);
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute =
    offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${name} is an ISO instant`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new BadRequestException(`${name} is an ISO instant`);
  return date;
}

function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value))
    throw new BadRequestException(`${name} is invalid`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
