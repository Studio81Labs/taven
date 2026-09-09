import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditActorKind, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import type { OperatorContext } from "../admin-access/operator-context";
import { requireOperatorPermission } from "../admin-access/operator-command";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import type {
  AuditEventPageDto,
  AuditEventSummaryDto,
  AuditPayloadValue,
} from "./audit.dto";

type Transaction = Prisma.TransactionClient;
type AuditFilters = Readonly<{
  eventType?: string;
  nodeId?: string;
  operatorIdentityId?: string;
  orderId?: string;
  paymentId?: string;
  quoteRequestId?: string;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_MIN_TIMESTAMP_YEAR = -4712;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async recordOperator(
    transaction: Transaction,
    operator: OperatorContext,
    input: Readonly<{
      eventType: string;
      orderId?: string;
      paymentId?: string;
      quoteRequestId?: string;
      quoteId?: string;
      nodeId: string;
      createdAt?: Date;
      correlationId?: string;
      idempotencyKey?: string;
      reasonCode?: string;
      reason?: string;
      payload: Prisma.InputJsonObject;
    }>,
  ): Promise<void> {
    const nodeId = canonicalUuid(input.nodeId);
    if (!operator.nodeIds.includes(nodeId)) {
      throw new BadRequestException("Operator is not granted the audit node");
    }
    const reason = input.reason?.trim();
    const reasonCode = input.reasonCode?.trim();
    if ((reason === undefined) !== (reasonCode === undefined)) {
      throw new BadRequestException(
        "Audit reason and reason code must be paired",
      );
    }
    if (reason === "") {
      throw new BadRequestException("Audit reason is invalid");
    }
    if (reason && reason.length > 1_000) {
      throw new BadRequestException("Audit reason is too long");
    }
    if (reasonCode && !/^[A-Z][A-Z0-9_]{0,99}$/.test(reasonCode)) {
      throw new BadRequestException("Audit reason code is invalid");
    }
    const createdAt = input.createdAt ?? (await databaseNow(transaction));
    await transaction.auditEvent.create({
      data: {
        eventType: input.eventType,
        actorKind: AuditActorKind.OPERATOR,
        actorId: operator.operatorId,
        operatorIdentityId: operator.operatorId,
        nodeId,
        schemaVersion: 2,
        reasonCode: reasonCode ?? null,
        reason: reason ?? null,
        orderId: input.orderId ?? null,
        paymentId: input.paymentId ?? null,
        quoteRequestId: input.quoteRequestId ?? null,
        quoteId: input.quoteId ?? null,
        correlationId: input.correlationId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        payload: input.payload,
        createdAt,
      },
    });
  }

  async list(
    operator: OperatorContext,
    filters: AuditFilters,
    cursor?: string,
    limit = 25,
  ): Promise<AuditEventPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.AUDIT_READ);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("Audit limit is invalid");
    }
    const normalizedFilters = normalizeFilters(filters);
    if (
      normalizedFilters.nodeId &&
      !operator.nodeIds.includes(normalizedFilters.nodeId)
    ) {
      throw new NotFoundException("Audit node was not found");
    }
    const filterHash = digest(normalizedFilters);
    const keyset =
      cursor !== undefined ? parseCursor(cursor, filterHash) : undefined;
    const where: Prisma.AuditEventWhereInput = {
      AND: [
        {
          OR: [
            { nodeId: { in: [...operator.nodeIds] } },
            legacyVisibleScope(operator.nodeIds),
          ],
        },
        normalizedFilters,
        ...(keyset
          ? [
              {
                OR: [
                  { createdAt: { lt: keyset.createdAt } },
                  { createdAt: keyset.createdAt, id: { lt: keyset.id } },
                ],
              },
            ]
          : []),
      ],
    };
    const rows = await this.prisma.auditEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id, filterHash })
        : undefined;
    return {
      items: page.map(toSummary),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}

async function databaseNow(
  transaction: Pick<Transaction, "$queryRaw">,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now
  `;
  const observedAt = rows[0]?.now;
  if (!observedAt) throw new Error("Audit database clock is unavailable");
  return observedAt;
}

function toSummary(
  row: Awaited<ReturnType<PrismaService["auditEvent"]["findMany"]>>[number],
): AuditEventSummaryDto {
  return {
    id: row.id,
    eventType: row.eventType,
    createdAt: row.createdAt.toISOString(),
    ...(row.operatorIdentityId
      ? { operatorIdentityId: row.operatorIdentityId }
      : {}),
    ...(row.schemaVersion === 1 ? { legacy: true } : {}),
    ...(row.nodeId ? { nodeId: row.nodeId } : {}),
    ...(row.orderId ? { orderId: row.orderId } : {}),
    ...(row.paymentId ? { paymentId: row.paymentId } : {}),
    ...(row.refundTransactionId
      ? { refundTransactionId: row.refundTransactionId }
      : {}),
    ...(row.quoteRequestId ? { quoteRequestId: row.quoteRequestId } : {}),
    ...(row.quoteId ? { quoteId: row.quoteId } : {}),
    ...(row.correlationId ? { correlationId: row.correlationId } : {}),
    ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    payload: redactPayload(row.payload),
  };
}

function legacyVisibleScope(
  nodeIds: readonly string[],
): Prisma.AuditEventWhereInput {
  const orderScope = operationalOrderScope(nodeIds);
  return {
    schemaVersion: 1,
    nodeId: null,
    OR: [
      // Assisted intake is platform-level until it becomes an operational
      // Order; it is still protected by the staff-only audit permission.
      {
        AND: [
          { quoteRequestId: { not: null } },
          { orderId: null },
          { paymentId: null },
          { refundTransactionId: null },
        ],
      },
      {
        AND: [
          { quoteId: { not: null } },
          { orderId: null },
          { paymentId: null },
          { refundTransactionId: null },
        ],
      },
      { order: orderScope },
      { payment: { orderPriceBinding: { order: orderScope } } },
      {
        refundTransaction: {
          payment: { orderPriceBinding: { order: orderScope } },
        },
      },
    ],
  };
}

function operationalOrderScope(
  nodeIds: readonly string[],
): Prisma.OrderWhereInput {
  return {
    AND: [
      { jobs: { none: { nodeId: { notIn: [...nodeIds] } } } },
      {
        phases: {
          none: {
            eligibilitySnapshots: { some: { nodeId: { notIn: [...nodeIds] } } },
          },
        },
      },
      {
        OR: [
          { jobs: { some: { nodeId: { in: [...nodeIds] } } } },
          {
            phases: {
              some: {
                eligibilitySnapshots: {
                  some: { nodeId: { in: [...nodeIds] } },
                },
              },
            },
          },
        ],
      },
    ],
  };
}

function redactPayload(
  value: Prisma.JsonValue,
): Record<string, AuditPayloadValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, AuditPayloadValue> = {};
  for (const key of [
    "operation",
    "status",
    "outcome",
    "version",
    "photoAssetId",
    "deltaMilligrams",
  ] as const) {
    const field = value[key];
    if (
      typeof field === "boolean" ||
      typeof field === "number" ||
      typeof field === "string"
    )
      result[key] = field;
  }
  const response = jsonObject(value.response);
  const status = response?.status;
  if (
    typeof status === "boolean" ||
    typeof status === "number" ||
    typeof status === "string"
  ) {
    result.status = status;
  }
  const targets = response ? jsonObject(response.targets) : undefined;
  if (targets) redactTargetIdentifiers(result, targets);
  return result;
}

function jsonObject(
  value: Prisma.JsonValue | undefined,
): Prisma.JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

const AUDIT_TARGET_IDENTIFIER_FIELDS = new Set([
  "authorizationId",
  "claimId",
  "fulfilmentSlotId",
  "fulfilmentSlotIds",
  "jobId",
  "originalShipmentId",
  "phaseReservationSetId",
  "priceAdjustmentId",
  "predecessorShipmentId",
  "replacementJobId",
  "replacementRequestId",
  "replacementShipmentId",
  "refundIds",
  "reshipmentShipmentId",
  "shipmentId",
  "shipmentIds",
  "shipmentPlanId",
  "sourceJobId",
]);
const MAX_AUDIT_TARGET_IDENTIFIERS = 100;

function redactTargetIdentifiers(
  result: Record<string, AuditPayloadValue>,
  targets: Prisma.JsonObject,
): void {
  let remaining = MAX_AUDIT_TARGET_IDENTIFIERS;
  for (const [key, value] of Object.entries(targets)) {
    if (
      !AUDIT_TARGET_IDENTIFIER_FIELDS.has(key) ||
      remaining === 0 ||
      value === undefined
    ) {
      continue;
    }
    const identifiers = identifiersFromJson(value, remaining);
    if (identifiers.length === 0) continue;
    result[key] =
      key.endsWith("Ids") || identifiers.length > 1
        ? identifiers
        : identifiers[0]!;
    remaining -= identifiers.length;
  }
}

function identifiersFromJson(value: Prisma.JsonValue, limit: number): string[] {
  const values = Array.isArray(value) ? value : [value];
  const identifiers: string[] = [];
  for (const candidate of values) {
    if (
      typeof candidate === "string" &&
      UUID_PATTERN.test(candidate) &&
      !identifiers.includes(candidate)
    ) {
      identifiers.push(candidate);
      if (identifiers.length === limit) break;
    }
  }
  return identifiers;
}

function digest(filters: AuditFilters): string {
  return createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("base64url");
}

function encodeCursor(value: {
  createdAt: Date;
  id: string;
  filterHash: string;
}): string {
  return Buffer.from(
    JSON.stringify({ ...value, createdAt: value.createdAt.toISOString() }),
  ).toString("base64url");
}

function parseCursor(
  cursor: string,
  filterHash: string,
): { createdAt: Date; id: string } {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { createdAt?: string; filterHash?: string; id?: string };
    const createdAt = value.createdAt ? new Date(value.createdAt) : undefined;
    if (
      !createdAt ||
      Number.isNaN(createdAt.getTime()) ||
      createdAt.getUTCFullYear() < POSTGRES_MIN_TIMESTAMP_YEAR ||
      !value.id ||
      !UUID_PATTERN.test(value.id) ||
      value.filterHash !== filterHash
    )
      throw new Error();
    return { createdAt, id: value.id };
  } catch {
    throw new BadRequestException("Audit cursor is invalid");
  }
}

function normalizeFilters(filters: AuditFilters): AuditFilters {
  return {
    ...filters,
    ...(filters.nodeId ? { nodeId: canonicalUuid(filters.nodeId) } : {}),
    ...(filters.operatorIdentityId
      ? { operatorIdentityId: canonicalUuid(filters.operatorIdentityId) }
      : {}),
    ...(filters.orderId ? { orderId: canonicalUuid(filters.orderId) } : {}),
    ...(filters.paymentId
      ? { paymentId: canonicalUuid(filters.paymentId) }
      : {}),
    ...(filters.quoteRequestId
      ? { quoteRequestId: canonicalUuid(filters.quoteRequestId) }
      : {}),
  };
}

function canonicalUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException("Audit UUID is invalid");
  }
  return value.toLowerCase();
}
