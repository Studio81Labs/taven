import { DomainError } from "../primitives/errors.js";

export const lockTargetRank = {
  idempotency_record: 0,
  provider_event: 0,
  legal_document: 1,
  commercial_policy_selection: 2,
  quote_request: 3,
  order: 3,
  order_phase: 4,
  fulfilment_slot: 5,
  claim: 6,
  claim_slot_resolution: 6,
  job: 7,
  shipment: 7,
  shipment_plan: 7,
  payment: 8,
  refund_transaction: 8,
  component_allocation: 9,
  price_snapshot: 9,
  eligibility_snapshot: 9,
  phase_resource_plan: 9,
  candidate_resource_estimate: 10,
  machine_profile: 11,
  machine: 12,
  machine_calibration: 13,
  inventory: 14,
  candidate_capacity_interval: 15,
  phase_reservation_set: 16,
  production_reservation: 17,
  inventory_reservation: 18,
  capacity_reservation: 19,
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
