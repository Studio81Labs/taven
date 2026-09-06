import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditActorKind, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import type { OperatorContext } from "../admin-access/operator-context";
import type { AuditEventPageDto, AuditEventSummaryDto } from "./audit.dto";

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
      nodeId?: string;
      correlationId?: string;
      idempotencyKey?: string;
      reasonCode?: string;
      reason?: string;
      payload: Prisma.InputJsonObject;
    }>,
  ): Promise<void> {
    if (input.nodeId && !operator.nodeIds.includes(input.nodeId)) {
      throw new BadRequestException("Operator is not granted the audit node");
    }
    const reason = input.reason?.trim();
    if ((reason === undefined) !== (input.reasonCode === undefined)) {
      throw new BadRequestException(
        "Audit reason and reason code must be paired",
      );
    }
    await transaction.auditEvent.create({
      data: {
        eventType: input.eventType,
        actorKind: AuditActorKind.OPERATOR,
        actorId: operator.operatorId,
        operatorIdentityId: operator.operatorId,
        nodeId: input.nodeId ?? null,
        schemaVersion: 2,
        reasonCode: input.reasonCode ?? null,
        reason: reason ?? null,
        orderId: input.orderId ?? null,
        paymentId: input.paymentId ?? null,
        quoteRequestId: input.quoteRequestId ?? null,
        correlationId: input.correlationId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        payload: input.payload,
      },
    });
  }

  async list(
    operator: OperatorContext,
    filters: AuditFilters,
    cursor?: string,
    limit = 25,
  ): Promise<AuditEventPageDto> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new BadRequestException("Audit limit is invalid");
    }
    const normalizedLimit = Math.min(Math.max(limit, 1), 100);
    if (filters.nodeId && !operator.nodeIds.includes(filters.nodeId)) {
      throw new NotFoundException("Audit node was not found");
    }
    const filterHash = digest(filters);
    const keyset = cursor ? parseCursor(cursor, filterHash) : undefined;
    const where: Prisma.AuditEventWhereInput = {
      AND: [
        { nodeId: { in: [...operator.nodeIds] } },
        filters,
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
      take: normalizedLimit + 1,
    });
    const page = rows.slice(0, normalizedLimit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > normalizedLimit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id, filterHash })
        : undefined;
    return {
      items: page.map(toSummary),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
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
    ...(row.nodeId ? { nodeId: row.nodeId } : {}),
    ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    payload: redactPayload(row.payload),
  };
}

function redactPayload(
  value: Prisma.JsonValue,
): Record<string, boolean | number | string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean | number | string> = {};
  for (const key of ["operation", "status", "outcome", "version"] as const) {
    const field = value[key];
    if (
      typeof field === "boolean" ||
      typeof field === "number" ||
      typeof field === "string"
    )
      result[key] = field;
  }
  return result;
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
