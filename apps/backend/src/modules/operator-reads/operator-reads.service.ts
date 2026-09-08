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
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { OrdersService } from "../orders/orders.service";
import {
  CapacityReservationPageDto,
  MachineCalibrationPageDto,
  MachineCapabilityPageDto,
  MachinePageDto,
  MachineProfilePageDto,
  OperatorJobPageDto,
  OperatorOrderDetailDto,
  OperatorOrderPageDto,
  PriceListPageDto,
  PrintConfigRevisionPageDto,
  ReferenceProfilePageDto,
  type MachineProfileReadDto,
  type OperatorJobListItemDto,
  type OperatorOrderListItemDto,
  type ReferenceProfileReadDto,
  InventoryPageDto,
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
      preflightFinding: Readonly<{ code: string }>;
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
    const fulfilment = await this.orders.getFulfilment(operator, orderId);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          orderBy: { ordinal: "asc" },
          include: {
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
                  where: { decision: AutomaticQuoteRiskDecision.ACKNOWLEDGED },
                  select: {
                    configurationFingerprint: true,
                    preflightFinding: { select: { code: true } },
                  },
                },
              },
            },
          },
        },
        acceptedPriceBinding: {
          include: { priceSnapshot: { include: { priceList: true } } },
        },
        activeContractPrice: { include: { contractPriceRevision: true } },
        settlements: { orderBy: { settledAt: "asc" } },
        priceBindings: {
          include: { payments: { orderBy: { createdAt: "asc" } } },
        },
      },
    });
    if (!order) throw new NotFoundException("Order was not found");
    const accepted = order.acceptedPriceBinding?.priceSnapshot;
    const active = order.activeContractPrice?.contractPriceRevision;
    const acceptedQuoteItems = new Map(
      (order.automaticQuoteDraft?.items ?? []).map((item) => [
        item.ordinal,
        item,
      ]),
    );
    return {
      id: order.id,
      publicReference: order.publicReference,
      status: order.status,
      confirmedAt: iso(order.confirmedAt),
      acceptedTermsRevision: order.acceptedTermsRevision,
      acceptedPrice: accepted
        ? {
            bindingId: order.acceptedPriceBinding!.id,
            snapshotId: accepted.id,
            contractTotalMinor: accepted.contractTotalMinor.toString(),
            netAmountMinor: accepted.netAmountMinor.toString(),
            vatAmountMinor: accepted.vatAmountMinor.toString(),
            currency: accepted.currency,
            priceListRevision: accepted.priceList.revision,
            termsRevision: accepted.priceList.termsRevision,
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
      })),
      financial: {
        activeContractRevisionId: active?.id ?? null,
        activeContractTotalMinor: active?.contractTotalMinor.toString() ?? null,
        activeContractNetMinor: active?.netAmountMinor.toString() ?? null,
        currency: active?.currency ?? null,
        settlements: order.settlements.map((settlement) => ({
          id: settlement.id,
          kind: settlement.kind,
          currency: settlement.currency,
          contractTotalMinor: settlement.contractTotalMinor.toString(),
          capturedTotalMinor: settlement.capturedTotalMinor.toString(),
          refundAmountMinor: settlement.refundAmountMinor.toString(),
          amountDueMinor: settlement.amountDueMinor.toString(),
          refundableBalanceMinor: settlement.refundableBalanceMinor.toString(),
          settledAt: settlement.settledAt.toISOString(),
        })),
        payments: order.priceBindings
          .flatMap((binding) => binding.payments)
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.id.localeCompare(right.id),
          )
          .map((payment) => ({
            id: payment.id,
            role: payment.role,
            provider: payment.provider,
            checkoutMethod: payment.checkoutMethod,
            merchantReference: payment.merchantReference,
            requestedAmountMinor: payment.requestedAmountMinor.toString(),
            capturedAmountMinor:
              payment.capturedAmountMinor?.toString() ?? null,
            currency: payment.currency,
            status: payment.status,
            captureAuthorized: payment.captureAuthorized,
            captureCutoffAt: iso(payment.captureCutoffAt),
            checkoutCaptureExpiresAt: iso(payment.checkoutCaptureExpiresAt),
            balanceDueAt: iso(payment.balanceDueAt),
            capturedAt: iso(payment.capturedAt),
            createdAt: payment.createdAt.toISOString(),
            updatedAt: payment.updatedAt.toISOString(),
          })),
      },
      fulfilment,
    };
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
    }));
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
    const cursor = pageCursor(input.cursor, filterHash, "capacity cursor");
    const rows = await this.prisma.capacityReservation.findMany({
      where: {
        nodeId,
        ...(input.machineId ? { machineId: input.machineId } : {}),
        ...(status ? { status } : {}),
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: pageLimit(input.limit) + 1,
    });
    return pageResult(rows, pageLimit(input.limit), filterHash, (row) => ({
      id: row.id,
      machineId: row.machineId,
      status: row.status,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));
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

function encodeCursor(value: Cursor | TimeCursor): string {
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
