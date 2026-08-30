import { DomainError } from "../primitives/errors.js";

export const lockTargetRank = {
  idempotency_record: 0,
  provider_event: 0,
  quote_request: 1,
  order: 1,
  order_phase: 2,
  fulfilment_slot: 3,
  claim: 4,
  claim_slot_resolution: 4,
  job: 5,
  shipment: 5,
  shipment_plan: 5,
  payment: 6,
  refund_transaction: 6,
  component_allocation: 7,
  price_snapshot: 7,
  eligibility_snapshot: 7,
  phase_resource_plan: 7,
  candidate_resource_estimate: 8,
  machine_profile: 9,
  machine: 10,
  machine_calibration: 11,
  inventory: 12,
  candidate_capacity_interval: 13,
  phase_reservation_set: 14,
  production_reservation: 15,
  inventory_reservation: 16,
  capacity_reservation: 17,
} as const;

export type LockTargetKind = keyof typeof lockTargetRank;

export interface LockTarget {
  readonly kind: LockTargetKind;
  readonly id: string;
  /** Mandatory for operational data that can never be queried across nodes. */
  readonly nodeId?: string;
}

const nodeScopedKinds = new Set<LockTargetKind>([
  "job",
  "candidate_resource_estimate",
  "candidate_capacity_interval",
  "machine_calibration",
  "inventory",
  "machine",
  "eligibility_snapshot",
  "phase_resource_plan",
  "phase_reservation_set",
  "inventory_reservation",
  "capacity_reservation",
  "production_reservation",
]);

function canonicalIdentity(target: LockTarget): string {
  const components = [
    target.kind,
    nodeScopedKinds.has(target.kind) ? (target.nodeId ?? "") : "",
    target.id,
  ];
  return components.map((value) => `${value.length}:${value}`).join("|");
}

/** Returns the only supported acquisition order without mutating the input. */
export function orderLockTargets(
  targets: readonly LockTarget[],
): readonly LockTarget[] {
  const identities = new Set<string>();
  for (const target of targets) {
    if (target.id.trim().length === 0) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Lock target ID must not be blank.",
      );
    }
    if (nodeScopedKinds.has(target.kind) && !target.nodeId?.trim()) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        `${target.kind} lock targets require node scope.`,
      );
    }
    if (!nodeScopedKinds.has(target.kind) && target.nodeId !== undefined) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        `${target.kind} lock targets must not include node scope.`,
      );
    }
    const identity = canonicalIdentity(target);
    if (identities.has(identity)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        `Duplicate lock target ${identity}.`,
      );
    }
    identities.add(identity);
  }

  return [...targets].sort((left, right) => {
    const rank = lockTargetRank[left.kind] - lockTargetRank[right.kind];
    if (rank !== 0) return rank;
    const leftIdentity = canonicalIdentity(left);
    const rightIdentity = canonicalIdentity(right);
    return leftIdentity < rightIdentity
      ? -1
      : leftIdentity > rightIdentity
        ? 1
        : 0;
  });
}
