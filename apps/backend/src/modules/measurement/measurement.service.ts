import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AcquisitionChannel,
  ActualCostCategory,
  ActualCostSource,
  HandlingComponent,
  HandlingSessionLifecycle,
  HandlingSource,
  IdempotencyStatus,
  OperatorRole,
  Prisma,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import type { OperatorContext } from "../admin-access/operator-context";
import { AuditService } from "../audit/audit.service";
import type {
  CompleteHandlingSessionDto,
  HandlingAllocationInputDto,
  MeasurementCommandResultDto,
  RecordAcquisitionSpendDto,
  RecordActualCostDto,
  RecordManualHandlingSessionDto,
  StartHandlingSessionDto,
  VoidHandlingSessionDto,
} from "./measurement.dto";

type Transaction = Prisma.TransactionClient;
type AllocationInput = Readonly<{
  orderId: string;
  orderItemId?: string;
  jobId?: string;
  shipmentId?: string;
  servedUnits: bigint;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_DAYS = 30;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_INT32 = 2_147_483_647n;

@Injectable()
export class MeasurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  start(
    operator: OperatorContext,
    body: StartHandlingSessionDto,
    key: string | undefined,
  ): Promise<MeasurementCommandResultDto> {
    const nodeId = operatorNode(operator);
    const input = parseSessionInput(body);
    return this.command(
      operatorCommandNamespace("handling:start", operator),
      key,
      { nodeId, ...input },
      async (tx) => {
        const now = await databaseNow(tx);
        try {
          const session = await tx.handlingSession.create({
            data: {
              nodeId,
              operatorIdentityId: operator.operatorId,
              component: input.component,
              source: HandlingSource.TIMER,
              startedAt: now,
              laborRateNumerator: input.rateNumerator,
              laborRateDenominator: input.rateDenominator,
              currency: input.currency,
              commandIdempotencyKey: requiredKey(key),
            },
          });
          await this.audit.recordOperator(tx, operator, {
            eventType: "handling.started",
            nodeId,
            correlationId: session.id,
            idempotencyKey: requiredKey(key),
            payload: { operation: "start", status: "OPEN" },
          });
          return { id: session.id, status: session.lifecycle };
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictException("Operator already has an open timer");
          }
          throw error;
        }
      },
    );
  }

  complete(
    operator: OperatorContext,
    sessionId: string,
    body: CompleteHandlingSessionDto,
    key: string | undefined,
  ): Promise<MeasurementCommandResultDto> {
    sessionId = uuid(sessionId, "sessionId");
    const allocations = parseAllocations(body.allocations);
    const nodeId = operatorNode(operator);
    return this.command(
      operatorCommandNamespace(`handling:stop:${sessionId}`, operator),
      key,
      allocations,
      async (tx) => {
        const session = await this.lockSession(tx, sessionId, nodeId);
        if (session.operatorIdentityId !== operator.operatorId) {
          throw new ForbiddenException(
            "Handling timer belongs to another operator",
          );
        }
        if (session.lifecycle !== HandlingSessionLifecycle.OPEN) {
          throw new ConflictException("Handling session is already closed");
        }
        const endedAt = await databaseNow(tx);
        const duration = BigInt(
          endedAt.getTime() - session.startedAt.getTime(),
        );
        if (duration <= 0n)
          throw new ConflictException("Handling timer has no elapsed duration");
        return this.completeSession(
          tx,
          operator,
          session,
          endedAt,
          duration,
          allocations,
          requiredKey(key),
        );
      },
    );
  }

  async recordManual(
    operator: OperatorContext,
    body: RecordManualHandlingSessionDto,
    key: string | undefined,
  ): Promise<MeasurementCommandResultDto> {
    if (operator.role !== OperatorRole.ADMIN) {
      throw new ForbiddenException(
        "Manual handling evidence requires an administrator",
      );
    }
    const nodeId = operatorNode(operator);
    const input = parseSessionInput(body);
    const reason = requiredText(body.reason, "reason", 1000);
    const startedAt = parseTimestamp(body.startedAt, "startedAt");
    const endedAt = parseTimestamp(body.endedAt, "endedAt");
    const duration = positiveBigInt(
      body.durationMilliseconds,
      "durationMilliseconds",
    );
    if (BigInt(endedAt.getTime()) - BigInt(startedAt.getTime()) !== duration) {
      throw new BadRequestException(
        "Manual duration must match start and end evidence",
      );
    }
    const allocations = parseAllocations(body.allocations);
    return this.command(
      operatorCommandNamespace("handling:manual", operator),
      key,
      { ...input, startedAt, endedAt, duration, reason, allocations },
      async (tx) => {
        const overlappingTimer = await tx.handlingSession.findFirst({
          where: {
            operatorIdentityId: operator.operatorId,
            source: HandlingSource.TIMER,
            lifecycle: {
              in: [
                HandlingSessionLifecycle.OPEN,
                HandlingSessionLifecycle.COMPLETED,
              ],
            },
            startedAt: { lt: endedAt },
            OR: [
              { lifecycle: HandlingSessionLifecycle.OPEN },
              { endedAt: { gt: startedAt } },
            ],
          },
        });
        if (overlappingTimer)
          throw new ConflictException(
            "Manual handling cannot overlap timer evidence",
          );
        const session = await tx.handlingSession.create({
          data: {
            nodeId,
            operatorIdentityId: operator.operatorId,
            component: input.component,
            source: HandlingSource.MANUAL,
            startedAt,
            laborRateNumerator: input.rateNumerator,
            laborRateDenominator: input.rateDenominator,
            currency: input.currency,
            reason,
            commandIdempotencyKey: requiredKey(key),
          },
        });
        return this.completeSession(
          tx,
          operator,
          session,
          endedAt,
          duration,
          allocations,
          requiredKey(key),
          await databaseNow(tx),
        );
      },
    );
  }

  void(
    operator: OperatorContext,
    sessionId: string,
    body: VoidHandlingSessionDto,
    key: string | undefined,
  ): Promise<MeasurementCommandResultDto> {
    if (operator.role !== OperatorRole.ADMIN) {
      throw new ForbiddenException(
        "Voiding handling evidence requires an administrator",
      );
    }
    sessionId = uuid(sessionId, "sessionId");
    const reason = requiredText(body.reason, "reason", 1000);
    const nodeId = operatorNode(operator);
    return this.command(
      operatorCommandNamespace(`handling:void:${sessionId}`, operator),
      key,
      { reason },
      async (tx) => {
        const session = await this.lockSession(tx, sessionId, nodeId);
        if (session.lifecycle === HandlingSessionLifecycle.VOIDED) {
          throw new ConflictException("Handling session is already voided");
        }
        const voided = await tx.handlingSession.update({
          where: { id: session.id },
          data: {
            lifecycle: HandlingSessionLifecycle.VOIDED,
            voidedAt: await databaseNow(tx),
            voidReason: reason,
          },
        });
        await this.audit.recordOperator(tx, operator, {
          eventType: "handling.voided",
          nodeId,
          correlationId: session.id,
          idempotencyKey: requiredKey(key),
          reasonCode: "MEASUREMENT_CORRECTION",
          reason,
          payload: { operation: "void", status: "VOIDED" },
        });
        return { id: voided.id, status: voided.lifecycle };
      },
    );
  }

  recordActualCost(
    operator: OperatorContext,
    orderId: string,
    body: RecordActualCostDto,
    key: string | undefined,
  ): Promise<MeasurementCommandResultDto> {
    orderId = uuid(orderId, "orderId");
    const input = parseActualCost(body);
    const nodeId = operatorNode(operator);
    return this.command(
      operatorCommandNamespace(`actual-cost:${orderId}`, operator),
      key,
      input,
      async (tx) => {
        await this.assertOrderNode(tx, orderId, nodeId);
        if (input.supersedesId)
          await this.assertActualCostSupersession(
            tx,
            input.supersedesId,
            orderId,
            input.category,
            input.currency,
          );
        try {
          const cost = await tx.orderActualCost.create({
            data: { orderId, ...input },
          });
          await this.audit.recordOperator(tx, operator, {
            eventType: "actual_cost.recorded",
            orderId,
            nodeId,
            correlationId: cost.id,
            idempotencyKey: requiredKey(key),
            payload: { operation: "record_actual_cost", status: "RECORDED" },
          });
          await tx.businessEvent.create({
            data: {
              eventType: "actual-cost.recorded",
              dedupeKey: cost.id,
              observedAt: cost.recordedAt,
              source: "SERVER",
              orderId,
              nodeId,
              payload: { category: cost.category },
            },
          });
          return { id: cost.id, status: "RECORDED" };
        } catch (error) {
          if (isUniqueViolation(error))
            throw new ConflictException(
              "Cost evidence source or correction was already recorded",
            );
          throw error;
        }
      },
    );
  }

  recordAcquisitionSpend(
    operator: OperatorContext,
    body: RecordAcquisitionSpendDto,
    key: string | undefined,
  ): Promise<MeasurementCommandResultDto> {
    const input = parseAcquisitionSpend(body);
    const nodeId = operatorNode(operator);
    return this.command(
      operatorCommandNamespace("acquisition-spend", operator),
      key,
      input,
      async (tx) => {
        if (input.supersedesId)
          await this.assertSpendSupersession(
            tx,
            input.supersedesId,
            input.channel,
            input.currency,
          );
        try {
          const spend = await tx.acquisitionSpend.create({ data: input });
          await this.audit.recordOperator(tx, operator, {
            eventType: "acquisition_spend.recorded",
            nodeId,
            correlationId: spend.id,
            idempotencyKey: requiredKey(key),
            payload: {
              operation: "record_acquisition_spend",
              status: "RECORDED",
            },
          });
          return { id: spend.id, status: "RECORDED" };
        } catch (error) {
          if (isUniqueViolation(error))
            throw new ConflictException(
              "Spend source or correction was already recorded",
            );
          throw error;
        }
      },
    );
  }

  private async completeSession(
    tx: Transaction,
    operator: OperatorContext,
    session: {
      id: string;
      component: HandlingComponent;
      nodeId: string;
      operatorIdentityId: string;
      startedAt: Date;
      laborRateNumerator: bigint;
      laborRateDenominator: bigint;
      currency: string;
    },
    endedAt: Date,
    duration: bigint,
    allocations: AllocationInput[],
    key: string,
    completedAt: Date = endedAt,
  ): Promise<MeasurementCommandResultDto> {
    const cost = await handlingCost(
      duration,
      session.laborRateNumerator,
      session.laborRateDenominator,
    );
    await this.writeAllocations(tx, session, duration, cost, allocations);
    const completed = await tx.handlingSession.update({
      where: { id: session.id },
      data: {
        lifecycle: HandlingSessionLifecycle.COMPLETED,
        endedAt,
        durationMilliseconds: duration,
        totalCostMinor: cost,
        completedAt,
      },
    });
    await this.recordCompletionEvidence(tx, operator, completed, key);
    return { id: completed.id, status: "COMPLETED" };
  }

  private async writeAllocations(
    tx: Transaction,
    session: {
      id: string;
      component: HandlingComponent;
      nodeId: string;
      currency: string;
    },
    duration: bigint,
    cost: bigint,
    inputs: AllocationInput[],
  ): Promise<void> {
    await this.assertAllocationLineage(
      tx,
      session.nodeId,
      session.component,
      inputs,
    );
    const allocations = await allocateSession(
      duration,
      cost,
      inputs.map((input) => ({
        id: allocationTargetKey(input),
        servedUnits: input.servedUnits,
      })),
    );
    await tx.handlingAllocation.createMany({
      data: inputs.map((input) => {
        const value = allocations.find(
          (allocation) => allocation.targetId === allocationTargetKey(input),
        );
        if (!value)
          throw new BadRequestException("Allocation target is invalid");
        return {
          handlingSessionId: session.id,
          orderId: input.orderId,
          orderItemId: input.orderItemId ?? null,
          jobId: input.jobId ?? null,
          shipmentId: input.shipmentId ?? null,
          targetKey: value.targetId,
          servedUnitCount: Number(input.servedUnits),
          allocatedDurationMilliseconds: value.allocatedDurationMilliseconds,
          allocatedCostMinor: value.allocatedCostMinor,
          currency: session.currency,
        };
      }),
    });
  }

  private async recordCompletionEvidence(
    tx: Transaction,
    operator: OperatorContext,
    session: {
      id: string;
      component: HandlingComponent;
      nodeId: string;
    },
    key: string,
  ): Promise<void> {
    await this.audit.recordOperator(tx, operator, {
      eventType: "handling.completed",
      nodeId: session.nodeId,
      correlationId: session.id,
      idempotencyKey: key,
      payload: { operation: "complete", status: "COMPLETED" },
    });
    await tx.businessEvent.create({
      data: {
        eventType: "handling.completed",
        dedupeKey: session.id,
        observedAt: await databaseNow(tx),
        source: "SERVER",
        nodeId: session.nodeId,
        payload: { component: session.component },
      },
    });
  }

  private async assertAllocationLineage(
    tx: Transaction,
    nodeId: string,
    component: HandlingComponent,
    inputs: AllocationInput[],
  ): Promise<void> {
    if (
      component === HandlingComponent.HANDLING_ORDER_FIX &&
      inputs.length !== 1
    ) {
      throw new BadRequestException(
        "Order-fix handling requires exactly one order allocation",
      );
    }
    for (const input of inputs) {
      if (
        component === HandlingComponent.HANDLING_ORDER_FIX &&
        (input.orderItemId ||
          input.jobId ||
          input.shipmentId ||
          input.servedUnits !== 1n)
      )
        throw new BadRequestException(
          "Order-fix handling must target one order once",
        );
      if (
        (component === HandlingComponent.HANDLING_PLATE ||
          component === HandlingComponent.HANDLING_PIECE) &&
        (!input.orderItemId || input.shipmentId)
      )
        throw new BadRequestException(
          "Plate and piece handling require an order item",
        );
      if (
        component === HandlingComponent.HANDLING_PACK &&
        (!input.shipmentId ||
          input.orderItemId ||
          input.jobId ||
          input.servedUnits !== 1n)
      )
        throw new BadRequestException(
          "Pack handling requires one actual shipment per allocation",
        );
      if (
        component === HandlingComponent.SHIPPING_TRIP &&
        (!input.shipmentId ||
          input.orderItemId ||
          input.jobId ||
          input.servedUnits !== 1n)
      )
        throw new BadRequestException(
          "Shipping trip allocations require one actual shipment",
        );
      if (
        component === HandlingComponent.POSTPROCESSING_ITEM &&
        (!input.orderItemId ||
          input.jobId ||
          input.shipmentId ||
          input.servedUnits !== 1n)
      )
        throw new BadRequestException(
          "Postprocessing allocations require one order item",
        );
      await this.assertOrderNode(tx, input.orderId, nodeId);
      if (input.orderItemId) {
        const item = await tx.orderItem.findFirst({
          where: { id: input.orderItemId, orderId: input.orderId },
        });
        if (!item)
          throw new BadRequestException("Allocation item is outside its order");
      }
      if (input.jobId) {
        const job = await tx.job.findFirst({
          where: { id: input.jobId, orderId: input.orderId, nodeId },
        });
        if (!job)
          throw new BadRequestException(
            "Allocation job is outside its order or node",
          );
      }
      if (input.shipmentId) {
        const shipment = await tx.shipment.findFirst({
          where: { id: input.shipmentId, orderId: input.orderId },
        });
        if (!shipment)
          throw new BadRequestException(
            "Allocation shipment is outside its order",
          );
      }
    }
  }

  private async assertOrderNode(
    tx: Transaction,
    orderId: string,
    nodeId: string,
  ): Promise<void> {
    const jobs = await tx.job.findMany({
      where: { orderId },
      select: { nodeId: true },
      distinct: ["nodeId"],
    });
    if (jobs.length === 0)
      throw new ConflictException("Order has no operational node");
    if (jobs.length !== 1 || jobs[0]?.nodeId !== nodeId)
      throw new NotFoundException("Order was not found");
  }

  private async lockSession(tx: Transaction, id: string, nodeId: string) {
    await tx.$queryRaw`SELECT id FROM handling_sessions WHERE id = ${id}::uuid FOR UPDATE`;
    const session = await tx.handlingSession.findFirst({
      where: { id, nodeId },
    });
    if (!session) throw new NotFoundException("Handling session was not found");
    return session;
  }

  private async assertActualCostSupersession(
    tx: Transaction,
    id: string,
    orderId: string,
    category: ActualCostCategory,
    currency: string,
  ) {
    assertUuid(id, "supersedesId");
    const prior = await tx.orderActualCost.findUnique({ where: { id } });
    if (
      !prior ||
      prior.orderId !== orderId ||
      prior.category !== category ||
      prior.currency !== currency
    )
      throw new BadRequestException(
        "Cost correction must preserve order, category, and currency",
      );
  }

  private async assertSpendSupersession(
    tx: Transaction,
    id: string,
    channel: AcquisitionChannel,
    currency: string,
  ) {
    assertUuid(id, "supersedesId");
    const prior = await tx.acquisitionSpend.findUnique({ where: { id } });
    if (!prior || prior.channel !== channel || prior.currency !== currency)
      throw new BadRequestException(
        "Spend correction must preserve channel and currency",
      );
  }

  private async command<T extends MeasurementCommandResultDto>(
    namespace: string,
    key: string | undefined,
    input: unknown,
    execute: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    const idempotencyKey = requiredKey(key);
    const fingerprint = createHash("sha256")
      .update(canonicalCommandInput(input))
      .digest("hex");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${idempotencyKey}`}, 0))::text`;
      const now = await databaseNow(tx);
      const existing = await tx.idempotencyRecord.findFirst({
        where: { namespace, idempotencyKey },
        orderBy: { generation: "desc" },
      });
      if (existing && existing.expiresAt > now) {
        if (existing.requestFingerprint !== fingerprint)
          throw new ConflictException(
            "Idempotency key was already used with different input",
          );
        if (
          existing.status !== IdempotencyStatus.COMPLETED ||
          !existing.responseBody
        )
          throw new ConflictException("Idempotent command is incomplete");
        return existing.responseBody as unknown as T;
      }
      const record = await tx.idempotencyRecord.create({
        data: {
          namespace,
          idempotencyKey,
          generation: (existing?.generation ?? 0) + 1,
          requestFingerprint: fingerprint,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_DAYS * 86_400_000),
        },
      });
      const response = await execute(tx);
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
  }
}

function parseSessionInput(body: StartHandlingSessionDto) {
  if (
    !Object.values(HandlingComponent).includes(
      body.component as HandlingComponent,
    )
  )
    throw new BadRequestException("component is invalid");
  return {
    component: body.component as HandlingComponent,
    rateNumerator: nonNegativeBigInt(
      body.laborRateNumerator,
      "laborRateNumerator",
    ),
    rateDenominator: positiveBigInt(
      body.laborRateDenominator,
      "laborRateDenominator",
    ),
    currency: currency(body.currency),
  };
}
function parseAllocations(
  value: HandlingAllocationInputDto[] | undefined,
): AllocationInput[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new BadRequestException("allocations must not be empty");
  const result = value.map((item) => ({
    orderId: uuid(item.orderId, "orderId"),
    ...(item.orderItemId
      ? { orderItemId: uuid(item.orderItemId, "orderItemId") }
      : {}),
    ...(item.jobId ? { jobId: uuid(item.jobId, "jobId") } : {}),
    ...(item.shipmentId
      ? { shipmentId: uuid(item.shipmentId, "shipmentId") }
      : {}),
    servedUnits: positiveBigInt(
      item.servedUnitCount,
      "servedUnitCount",
      MAX_INT32,
    ),
  }));
  if (new Set(result.map(allocationTargetKey)).size !== result.length)
    throw new BadRequestException("Allocation targets must be unique");
  return result;
}
function parseActualCost(body: RecordActualCostDto) {
  if (
    !Object.values(ActualCostCategory).includes(
      body.category as ActualCostCategory,
    ) ||
    !Object.values(ActualCostSource).includes(body.source as ActualCostSource)
  )
    throw new BadRequestException("Cost category or source is invalid");
  const reason = optionalText(body.reason, "reason", 1000);
  if ((body.source === ActualCostSource.MANUAL || body.supersedesId) && !reason)
    throw new BadRequestException("Manual cost evidence requires a reason");
  return {
    category: body.category as ActualCostCategory,
    amountMinor: nonNegativeBigInt(body.amountMinor, "amountMinor"),
    currency: currency(body.currency),
    occurredAt: parseTimestamp(body.occurredAt, "occurredAt"),
    source: body.source as ActualCostSource,
    sourceKey: requiredText(body.sourceKey, "sourceKey", 255),
    sourceEntityType: requiredText(
      body.sourceEntityType,
      "sourceEntityType",
      80,
    ),
    sourceEntityId: body.sourceEntityId
      ? uuid(body.sourceEntityId, "sourceEntityId")
      : null,
    supersedesId: body.supersedesId
      ? uuid(body.supersedesId, "supersedesId")
      : null,
    reason: reason ?? null,
  };
}
function parseAcquisitionSpend(body: RecordAcquisitionSpendDto) {
  if (
    !Object.values(AcquisitionChannel).includes(
      body.channel as AcquisitionChannel,
    )
  )
    throw new BadRequestException("channel is invalid");
  const start = parseTimestamp(body.periodStart, "periodStart");
  const end = parseTimestamp(body.periodEnd, "periodEnd");
  if (end <= start)
    throw new BadRequestException("periodEnd must be after periodStart");
  const reason = optionalText(body.reason, "reason", 1000);
  if (body.supersedesId && !reason)
    throw new BadRequestException("Spend corrections require a reason");
  return {
    channel: body.channel as AcquisitionChannel,
    periodStart: start,
    periodEnd: end,
    amountMinor: nonNegativeBigInt(body.amountMinor, "amountMinor"),
    currency: currency(body.currency),
    sourceKey: requiredText(body.sourceKey, "sourceKey", 255),
    sourceEntityType: requiredText(
      body.sourceEntityType,
      "sourceEntityType",
      80,
    ),
    supersedesId: body.supersedesId
      ? uuid(body.supersedesId, "supersedesId")
      : null,
    reason: reason ?? null,
  };
}
function allocationTargetKey(input: AllocationInput): string {
  return [
    input.orderId,
    input.orderItemId ?? "",
    input.jobId ?? "",
    input.shipmentId ?? "",
  ].join(":");
}
function operatorNode(operator: OperatorContext): string {
  if (operator.nodeIds.length !== 1)
    throw new ForbiddenException("Operator node scope is invalid");
  return operator.nodeIds[0]!;
}
function operatorCommandNamespace(
  namespace: string,
  operator: OperatorContext,
): string {
  return `${namespace}:${operator.operatorId}`;
}
function requiredKey(value: string | undefined): string {
  return requiredText(value, "Idempotency-Key", 255, 8);
}
function currency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value))
    throw new BadRequestException("currency is invalid");
  return value;
}
function uuid(value: string, name: string): string {
  assertUuid(value, name);
  return value.toLowerCase();
}
function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value))
    throw new BadRequestException(`${name} is invalid`);
}
function parseTimestamp(value: string, name: string): Date {
  if (typeof value !== "string")
    throw new BadRequestException(`${name} is invalid`);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(
    value,
  );
  if (!match) throw new BadRequestException(`${name} is invalid`);
  const result = new Date(value);
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  if (Number.isNaN(result.getTime()) || result.toISOString() !== normalized)
    throw new BadRequestException(`${name} is invalid`);
  return result;
}
function requiredText(
  value: string | undefined,
  name: string,
  max: number,
  min = 1,
): string {
  const result = value?.trim();
  if (!result || result.length < min || result.length > max)
    throw new BadRequestException(`${name} is invalid`);
  return result;
}
function optionalText(
  value: string | undefined,
  name: string,
  max: number,
): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, max);
}
function positiveBigInt(
  value: string,
  name: string,
  maximum = MAX_INT64,
): bigint {
  const result = nonNegativeBigInt(value, name, maximum);
  if (result <= 0n) throw new BadRequestException(`${name} must be positive`);
  return result;
}
function nonNegativeBigInt(
  value: string,
  name: string,
  maximum = MAX_INT64,
): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new BadRequestException(`${name} is invalid`);
  const result = BigInt(value);
  if (result > maximum) throw new BadRequestException(`${name} is invalid`);
  return result;
}
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
async function databaseNow(tx: Transaction): Promise<Date> {
  const rows = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  return rows[0]!.now;
}
async function handlingCost(
  duration: bigint,
  numerator: bigint,
  denominator: bigint,
): Promise<bigint> {
  const { calculateHandlingCostMinor } = await import("@taven/core");
  const cost = calculateHandlingCostMinor(duration, { numerator, denominator });
  if (cost > MAX_INT64)
    throw new BadRequestException("handling cost exceeds storage range");
  return cost;
}
async function allocateSession(
  duration: bigint,
  cost: bigint,
  targets: readonly { id: string; servedUnits: bigint }[],
) {
  const { allocateHandlingSession } = await import("@taven/core");
  return allocateHandlingSession(duration, cost, targets);
}

function canonicalCommandInput(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
