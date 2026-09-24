import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { IdempotencyStatus, OrderStatus, Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { AuditService } from "../audit/audit.service";
import { AutomaticQuotesService } from "../automatic-quotes/automatic-quotes.service";
import { databaseNow } from "../legal-approvals/legal-approvals.service";
import { EligibilityPlanService } from "../resources/eligibility-plan.service";
import { ResourceConflictError } from "../resources/resource-errors";
import type {
  IndividualResourcePreparationDto,
  PrepareIndividualOrderResourcesDto,
} from "./individual-resource-preparation.dto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_DAYS = 7;

@Injectable()
export class IndividualResourcePreparationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly automaticQuotes: AutomaticQuotesService,
    private readonly eligibilityPlans: EligibilityPlanService,
    private readonly audit: AuditService,
  ) {}

  async prepare(
    operator: OperatorContext,
    orderId: string,
    input: PrepareIndividualOrderResourcesDto,
    key: string | undefined,
  ): Promise<IndividualResourcePreparationDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_WRITE);
    const nodeId = operatorNode(operator);
    if (!UUID.test(orderId))
      throw new BadRequestException("orderId is invalid");
    const reason = input?.reason?.trim();
    if (!reason || reason.length < 3 || reason.length > 2000) {
      throw new BadRequestException("reason is invalid");
    }
    if (!key || key.trim().length < 8 || key.trim().length > 255) {
      throw new BadRequestException("Idempotency-Key is invalid");
    }
    key = key.trim();
    const namespace = `individual-order.resource-preparation:${orderId}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ orderId, nodeId, reason }))
      .digest("hex");
    const replay = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${key}`}, 0))::text
      `;
      const previous = await tx.idempotencyRecord.findFirst({
        where: { namespace, idempotencyKey: key },
        orderBy: { generation: "desc" },
      });
      const now = await databaseNow(tx);
      if (!previous || previous.expiresAt <= now) return null;
      if (previous.requestFingerprint !== fingerprint) {
        throw new ConflictException(
          "Idempotency key was used with other input",
        );
      }
      if (
        previous.status !== IdempotencyStatus.COMPLETED ||
        !previous.responseBody
      ) {
        throw new ConflictException("Resource preparation is incomplete");
      }
      return previous.responseBody as unknown as IndividualResourcePreparationDto;
    });
    if (replay) return replay;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        individualOrigin: true,
        phases: {
          include: {
            eligibilitySnapshots: {
              include: { phaseResourcePlans: { select: { nodeId: true } } },
            },
          },
        },
        activePriceBinding: true,
      },
    });
    if (
      !order?.individualOrigin ||
      order.phases.length !== 1 ||
      !order.activePriceBinding
    ) {
      throw new NotFoundException("Individual order is unavailable");
    }
    if (
      order.phases[0]!.eligibilitySnapshots.some((snapshot) =>
        snapshot.phaseResourcePlans.some((plan) => plan.nodeId !== nodeId),
      )
    ) {
      throw new NotFoundException(
        "Individual order is unavailable for this node",
      );
    }
    if (
      order.status !== OrderStatus.DRAFT &&
      order.status !== OrderStatus.QUOTED
    ) {
      throw new ConflictException(
        "Individual order is no longer awaiting resource preparation",
      );
    }
    const activeInitialPayment = await this.prisma.payment.findFirst({
      where: {
        orderId,
        role: { in: ["DEPOSIT", "FULL"] },
        status: { in: ["CREATED", "PENDING", "CAPTURED"] },
      },
      select: { id: true },
    });
    if (activeInitialPayment) {
      throw new ConflictException("Initial payment already owns this order");
    }
    const phase = order.phases[0]!;
    if (
      phase.kind !== "SINGLE" ||
      phase.status !== "QUOTED" ||
      order.acceptedOrderPriceBindingId !==
        order.activePriceBinding.orderPriceBindingId
    ) {
      throw new ConflictException("Accepted order topology is unavailable");
    }

    await this.automaticQuotes.dispatchOrderCandidates(
      orderId,
      order.activePriceBinding.orderPriceBindingId,
      nodeId,
    );
    let plan: Awaited<
      ReturnType<EligibilityPlanService["createCompletePlan"]>
    > | null = null;
    try {
      plan = await this.eligibilityPlans.createCompletePlan({
        nodeId,
        orderPhaseId: phase.id,
        planKey: `individual:${orderId}:${nodeId}:${createHash("sha256").update(key).digest("hex")}`,
        exclusiveOrderNode: true,
      });
    } catch (error) {
      if (
        error instanceof ResourceConflictError &&
        error.constraint === "individual_order_node_scope"
      ) {
        throw new NotFoundException(
          "Individual order is unavailable for this node",
        );
      }
      if (!(
        error instanceof ResourceConflictError &&
        error.constraint === "complete_phase_resource_plan_required"
      )) {
        throw error;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${key}`}, 0))::text
      `;
      await tx.$queryRaw`
        SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
      `;
      const now = await databaseNow(tx);
      const previous = await tx.idempotencyRecord.findFirst({
        where: { namespace, idempotencyKey: key },
        orderBy: { generation: "desc" },
      });
      if (previous && previous.expiresAt > now) {
        if (previous.requestFingerprint !== fingerprint) {
          throw new ConflictException(
            "Idempotency key was used with other input",
          );
        }
        if (
          previous.status === IdempotencyStatus.COMPLETED &&
          previous.responseBody
        ) {
          return previous.responseBody as unknown as IndividualResourcePreparationDto;
        }
        throw new ConflictException("Resource preparation is incomplete");
      }
      const current = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      if (
        current.status !== OrderStatus.DRAFT &&
        current.status !== OrderStatus.QUOTED
      ) {
        throw new ConflictException("Individual order resource state changed");
      }
      const livePayment = await tx.payment.findFirst({
        where: {
          orderId,
          role: { in: ["DEPOSIT", "FULL"] },
          status: { in: ["CREATED", "PENDING", "CAPTURED"] },
        },
        select: { id: true },
      });
      if (livePayment)
        throw new ConflictException("Initial payment already owns this order");
      const validPlan = plan && plan.expiresAt > now ? plan : null;
      if (validPlan && current.status === OrderStatus.DRAFT) {
        if (!current.withdrawalExceptionAcknowledgedAt) {
          throw new ConflictException("Accepted order evidence is unavailable");
        }
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.QUOTED,
            quotedAt: current.withdrawalExceptionAcknowledgedAt,
            updatedAt: now,
          },
        });
      }
      const result: IndividualResourcePreparationDto = {
        orderId,
        status: validPlan ? "READY" : "PENDING",
        phaseResourcePlanId: validPlan?.phaseResourcePlanId ?? null,
        planExpiresAt: validPlan?.expiresAt.toISOString() ?? null,
      };
      await tx.idempotencyRecord.create({
        data: {
          namespace,
          idempotencyKey: key,
          generation: (previous?.generation ?? 0) + 1,
          requestFingerprint: fingerprint,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_DAYS * 86_400_000),
          status: IdempotencyStatus.COMPLETED,
          responseStatusCode: 200,
          responseBody: result as unknown as Prisma.InputJsonObject,
        },
      });
      await this.audit.recordOperator(tx, operator, {
        orderId,
        nodeId,
        eventType: "individual_order.resource_preparation",
        idempotencyKey: key,
        correlationId: randomUUID(),
        payload: {
          reason,
          nodeId,
          status: result.status,
          phaseResourcePlanId: result.phaseResourcePlanId,
        },
      });
      return result;
    });
  }
}
