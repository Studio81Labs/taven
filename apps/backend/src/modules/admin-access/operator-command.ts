import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OperatorContext } from "./operator-context";
import type { OperatorPermission } from "./operator-permissions";

type Transaction = Prisma.TransactionClient;

/**
 * Application services call this as well as the HTTP guard so that direct
 * callers cannot bypass the permission boundary.
 */
export function requireOperatorPermission(
  operator: OperatorContext,
  permission: OperatorPermission,
): void {
  if (!operator.permissions.includes(permission)) {
    throw new ForbiddenException("Operator permission is insufficient");
  }
}

/**
 * An authenticated v0 operator session has one active operational grant.
 * Refuse an ambiguous or missing grant rather than selecting a node.
 */
export function operatorNode(operator: OperatorContext): string {
  if (operator.nodeIds.length !== 1 || !operator.nodeIds[0]) {
    throw new ForbiddenException("Operator operational scope is unavailable");
  }
  return operator.nodeIds[0];
}

/**
 * Locks the canonical order envelope and verifies every persisted operational
 * lineage row for the order belongs to the actor's active node. The plan rows
 * cover the period before Jobs exist; the Job rows cover the live execution
 * tree. Do not authorize an order from a single matching child.
 */
export async function assertOperationalOrderScope(
  transaction: Transaction,
  orderId: string,
  nodeId: string,
): Promise<void> {
  try {
    await transaction.$queryRaw`
      SELECT taven_lock_order_phase_envelope(${orderId}::uuid)::text
    `;
  } catch (error) {
    if (databaseCode(error) === "23503") {
      throw new NotFoundException("Order was not found");
    }
    throw error;
  }
  const rows = await transaction.$queryRaw<Array<{ node_id: string }>>`
    SELECT DISTINCT scoped.node_id
    FROM (
      SELECT job.node_id
      FROM jobs job
      WHERE job.order_id = ${orderId}::uuid

      UNION

      SELECT plan.node_id
      FROM phase_resource_plans plan
      JOIN order_phases phase ON phase.id = plan.order_phase_id
      WHERE phase.order_id = ${orderId}::uuid

      UNION

      SELECT plan_job.node_id
      FROM phase_resource_plan_jobs plan_job
      JOIN phase_resource_plans plan
        ON plan.id = plan_job.phase_resource_plan_id
      JOIN order_phases phase ON phase.id = plan.order_phase_id
      WHERE phase.order_id = ${orderId}::uuid

      UNION

      SELECT plan_slot.node_id
      FROM phase_resource_plan_slots plan_slot
      JOIN phase_resource_plans plan
        ON plan.id = plan_slot.phase_resource_plan_id
      JOIN order_phases phase ON phase.id = plan.order_phase_id
      WHERE phase.order_id = ${orderId}::uuid
    ) scoped
    ORDER BY scoped.node_id
  `;
  if (rows.length !== 1 || rows[0]?.node_id !== nodeId) {
    throw new NotFoundException("Order was not found");
  }
}

function databaseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return;
  if ("meta" in error) {
    const meta = error.meta;
    if (
      meta &&
      typeof meta === "object" &&
      "code" in meta &&
      typeof meta.code === "string"
    ) {
      return meta.code;
    }
  }
  return "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
