import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { parseAutomaticQuotePricingParameters } from "../automatic-quotes/automatic-quote-pricing";
import type {
  OperatorWarningDto,
  OperatorWarningsReportDto,
  WarningCode,
} from "./operator-warnings.dto";

type InventoryStateRow = {
  id: string;
  machine_id: string;
  material: string;
  status: string;
  remaining_milligrams: bigint;
  reserved_milligrams: bigint;
  updated_at: Date;
};
type ConflictRow = {
  candidate_id: string;
  interval_id: string;
  machine_id: string;
  reservation_id: string;
  created_at: Date;
};

@Injectable()
export class OperatorWarningsService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    operator: OperatorContext,
    limit = 50,
  ): Promise<OperatorWarningsReportDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.METRICS_READ);
    if (operator.role !== "ADMIN")
      throw new ForbiddenException("Warnings are limited to administrators");
    const nodeId = operatorNode(operator);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException("limit must be between 1 and 100");
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const clock = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`;
        const now = clock[0]?.now;
        if (!now) throw new Error("Warnings database clock is unavailable");
        const take = limit + 1;
        const items: OperatorWarningDto[] = [];
        const add = (
          code: WarningCode,
          sourceType: string,
          sourceId: string,
          observedAt: Date,
          status: string,
          options: Partial<OperatorWarningDto> = {},
        ) => {
          items.push({
            id: options.id ?? `${code}:${sourceId}`,
            code,
            scope: options.scope ?? "PLATFORM",
            sourceType,
            sourceId,
            observedAt: observedAt.toISOString(),
            status,
            evidence: options.evidence ?? {},
            ...(options.nodeId ? { nodeId: options.nodeId } : {}),
            ...(options.orderId ? { orderId: options.orderId } : {}),
            ...(options.dueAt ? { dueAt: options.dueAt } : {}),
          });
        };

        const refunds = await tx.refundTransaction.findMany({
          where: {
            status: { in: ["PENDING", "FAILED", "SUSPENDED"] },
            replacementRefundTransactions: { none: {} },
          },
          include: { payment: { select: { orderId: true, currency: true } } },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take,
        });
        for (const row of refunds)
          add(
            "REFUND_UNRESOLVED",
            "refund",
            row.id,
            row.updatedAt,
            row.status,
            {
              orderId: row.payment.orderId,
              evidence: {
                amountMinor: row.amountMinor.toString(),
                currency: row.payment.currency,
              },
            },
          );

        const compensations = await tx.payment.findMany({
          where: {
            captureAuthorized: false,
            capturedAt: { not: null },
            status: { not: "REFUNDED" },
          },
          orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
          take,
        });
        const refundedByPayment = new Map(
          (compensations.length === 0
            ? []
            : await tx.refundTransaction.groupBy({
                by: ["paymentId"],
                where: {
                  paymentId: { in: compensations.map((row) => row.id) },
                  status: "SUCCEEDED",
                },
                _sum: { amountMinor: true },
              })
          ).map((row) => [row.paymentId, row._sum.amountMinor ?? 0n]),
        );
        for (const row of compensations) {
          const remaining =
            (row.capturedAmountMinor ?? 0n) -
            (refundedByPayment.get(row.id) ?? 0n);
          if (remaining > 0n && row.capturedAt)
            add(
              "CAPTURE_COMPENSATION_DUE",
              "payment",
              row.id,
              row.capturedAt,
              row.status,
              {
                orderId: row.orderId,
                evidence: {
                  uncompensatedMinor: remaining.toString(),
                  currency: row.currency,
                },
              },
            );
        }

        const email = await tx.outboxMessage.findMany({
          where: {
            messageType: { startsWith: "email." },
            OR: [
              { status: "FAILED" },
              {
                status: "PENDING",
                availableAt: { lte: now },
              },
            ],
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take,
        });
        for (const row of email)
          add(
            row.status === "FAILED"
              ? "EMAIL_OUTBOX_FAILED"
              : "EMAIL_OUTBOX_DUE",
            "email-outbox",
            row.id,
            row.updatedAt,
            row.status,
            { dueAt: row.availableAt.toISOString() },
          );

        const retention = await tx.retentionDeletionJob.findMany({
          where: {
            OR: [
              { status: "FAILED" },
              {
                status: "PENDING",
                expectedDeleteAfter: { lte: now },
                availableAt: { lte: now },
              },
              { status: "PROCESSING", leaseUntil: { lt: now } },
            ],
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take,
        });
        for (const row of retention)
          add(
            row.status === "FAILED" ? "RETENTION_FAILED" : "RETENTION_DUE",
            "retention-job",
            row.id,
            row.updatedAt,
            row.status,
            {
              dueAt:
                row.status === "PROCESSING" && row.leaseUntil
                  ? row.leaseUntil.toISOString()
                  : row.expectedDeleteAfter.toISOString(),
            },
          );

        const inventory = await tx.$queryRaw<InventoryStateRow[]>`
          SELECT id, machine_id, material::text, status::text,
                 remaining_milligrams, reserved_milligrams, updated_at
          FROM inventories
          WHERE node_id = ${nodeId}::uuid
            AND (status <> 'AVAILABLE' OR remaining_milligrams <= reserved_milligrams)
          ORDER BY updated_at DESC, id DESC LIMIT ${take}
        `;
        for (const row of inventory)
          add(
            "INVENTORY_UNAVAILABLE",
            "inventory",
            row.id,
            row.updated_at,
            row.status,
            {
              scope: "NODE",
              nodeId,
              evidence: {
                machineId: row.machine_id,
                material: row.material,
                remainingMilligrams: row.remaining_milligrams.toString(),
                reservedMilligrams: row.reserved_milligrams.toString(),
              },
            },
          );

        const profiles = await tx.$queryRaw<
          Array<{ id: string; machine_id: string; material: string }>
        >`
          SELECT DISTINCT ON (inventory.machine_id, inventory.material)
                 inventory.id, inventory.machine_id, inventory.material::text
          FROM inventories inventory
          JOIN machines machine ON machine.id = inventory.machine_id
          WHERE inventory.node_id = ${nodeId}::uuid
            AND machine.status = 'ACTIVE'
            AND inventory.status = 'AVAILABLE'
            AND inventory.remaining_milligrams > inventory.reserved_milligrams
            AND NOT EXISTS (
              SELECT 1 FROM machine_profiles profile
              JOIN reference_profiles reference ON reference.id = profile.reference_profile_id
              WHERE profile.machine_capability_id = machine.machine_capability_id
                AND profile.nozzle_diameter_micrometers = machine.installed_nozzle_micrometers
                AND profile.material = inventory.material
                AND profile.state = 'ACTIVE' AND reference.state = 'ACTIVE'
            )
          ORDER BY inventory.machine_id, inventory.material, inventory.id
          LIMIT ${take}
        `;
        for (const row of profiles)
          add(
            "PROFILE_UNAVAILABLE",
            "inventory",
            row.id,
            now,
            "MISSING_ACTIVE_PROFILE",
            {
              scope: "NODE",
              nodeId,
              evidence: { machineId: row.machine_id, material: row.material },
            },
          );

        const conflicts = await tx.$queryRaw<ConflictRow[]>`
          SELECT candidate.id AS candidate_id, interval.id AS interval_id,
                 candidate.machine_id,
                 reservation.id AS reservation_id, candidate.calculated_at AS created_at
          FROM candidate_resource_estimates candidate
          JOIN candidate_capacity_intervals interval
            ON interval.candidate_resource_estimate_id = candidate.id
          JOIN capacity_reservations reservation
            ON reservation.node_id = candidate.node_id
           AND reservation.machine_id = candidate.machine_id
           AND reservation.candidate_capacity_interval_id <> interval.id
           AND reservation.starts_at < interval.ends_at
           AND interval.starts_at < reservation.ends_at
           AND reservation.ends_at > ${now}
           AND reservation.status IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
           AND (reservation.status <> 'RESERVED' OR reservation.expires_at > ${now})
          WHERE candidate.node_id = ${nodeId}::uuid
            AND candidate.expires_at > ${now}
            AND interval.ends_at > ${now}
          ORDER BY candidate.calculated_at DESC, candidate.id DESC
          LIMIT ${take}
        `;
        for (const row of conflicts)
          add(
            "RESERVATION_CONFLICT",
            "candidate-estimate",
            row.candidate_id,
            row.created_at,
            "OVERLAPS_LIVE_RESERVATION",
            {
              id: `RESERVATION_CONFLICT:${row.candidate_id}:${row.interval_id}:${row.reservation_id}`,
              scope: "NODE",
              nodeId,
              evidence: {
                machineId: row.machine_id,
                candidateIntervalId: row.interval_id,
                conflictReservationId: row.reservation_id,
              },
            },
          );

        const activations = await tx.referenceProfile.findMany({
          where: { activatedAt: { not: null } },
          orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
          take,
        });
        for (const row of activations)
          if (row.activatedAt)
            add(
              "REFERENCE_PROFILE_ACTIVATED",
              "reference-profile",
              row.id,
              row.activatedAt,
              row.state,
              {
                evidence: { material: row.material },
              },
            );

        const unknownReceiptLots = await tx.inventory.count({
          where: { nodeId, receipts: { none: {} } },
        });
        const selection = await tx.commercialPolicySelection.findUnique({
          where: { currency: "CZK" },
          include: { priceList: true },
        });
        let rateLotScanLimited = false;
        if (selection) {
          const rates = parseAutomaticQuotePricingParameters(
            selection.priceList.parameters,
          ).materialRateMinorPerMilligram;
          const lots = await tx.inventory.findMany({
            where: { nodeId, currency: "CZK" },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take,
            select: { id: true, machineId: true, material: true },
          });
          rateLotScanLimited = lots.length === take;
          const receipts = await tx.inventoryReceipt.findMany({
            where: {
              inventoryId: { in: lots.map((lot) => lot.id) },
              corrections: { none: {} },
            },
          });
          const receiptByLot = new Map(
            receipts.map((receipt) => [receipt.inventoryId, receipt]),
          );
          for (const lot of lots) {
            const receipt = receiptByLot.get(lot.id);
            if (!receipt) continue;
            const selected = rates[lot.material];
            const difference =
              selected.numerator * receipt.priceMinorUnitsDenominator -
              receipt.priceMinorUnitsNumerator * selected.denominator;
            if (difference >= 0n) continue;
            add(
              "MATERIAL_RATE_BELOW_PURCHASE",
              "inventory-receipt",
              receipt.id,
              now,
              "SELECTED_RATE_BELOW_PURCHASE_RATE",
              {
                scope: "NODE",
                nodeId,
                evidence: {
                  inventoryId: lot.id,
                  machineId: lot.machineId,
                  material: lot.material,
                  currency: receipt.currency,
                  purchaseRateNumerator:
                    receipt.priceMinorUnitsNumerator.toString(),
                  purchaseRateDenominator:
                    receipt.priceMinorUnitsDenominator.toString(),
                  selectedRateNumerator: selected.numerator.toString(),
                  selectedRateDenominator: selected.denominator.toString(),
                  rateDifferenceNumerator: difference.toString(),
                  rateDifferenceDenominator: (
                    selected.denominator * receipt.priceMinorUnitsDenominator
                  ).toString(),
                },
              },
            );
          }
        }

        items.sort(
          (left, right) =>
            right.observedAt.localeCompare(left.observedAt) ||
            left.id.localeCompare(right.id),
        );
        const sourceScanLimited =
          [
            refunds,
            compensations,
            email,
            retention,
            inventory,
            profiles,
            conflicts,
            activations,
          ].some((rows) => rows.length === take) || rateLotScanLimited;
        return {
          generatedAt: now.toISOString(),
          nodeId,
          items: items.slice(0, limit),
          truncated: items.length > limit,
          coverage: {
            sourceScanLimited,
            emailDeliveryAttempts: "unavailable",
            reservationConflictHistory: "unavailable",
            selectedMaterialRate: selection ? "available" : "unavailable",
            inventoryLotsWithoutReceipt: unknownReceiptLots,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
