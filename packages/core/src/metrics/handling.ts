import { DomainError } from "../primitives/errors.js";
import {
  assertRational,
  ceilDivide,
  floorDivide,
} from "../pricing/arithmetic.js";
import type { Rational } from "../pricing/types.js";

export type HandlingAllocationTarget = Readonly<{
  id: string;
  servedUnits: bigint;
}>;

export type HandlingAllocation = Readonly<{
  targetId: string;
  allocatedDurationMilliseconds: bigint;
  allocatedCostMinor: bigint;
}>;

/**
 * Calculates one session's rounded labor cost. The rate is in minor units per
 * second and must be rounded only at the session boundary.
 */
export function calculateHandlingCostMinor(
  durationMilliseconds: bigint,
  laborRateMinorPerSecond: Rational,
): bigint {
  if (durationMilliseconds <= 0n) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "handling duration must be positive",
    );
  }
  assertRational(laborRateMinorPerSecond, "labor rate");
  return ceilDivide(
    durationMilliseconds * laborRateMinorPerSecond.numerator,
    1_000n * laborRateMinorPerSecond.denominator,
  );
}

/**
 * Reconciles duration and the already-rounded session cost exactly. Both are
 * split by served units using the largest remainder method and a stable target
 * ID tie-breaker.
 */
export function allocateHandlingSession(
  durationMilliseconds: bigint,
  costMinor: bigint,
  targets: readonly HandlingAllocationTarget[],
): readonly HandlingAllocation[] {
  if (durationMilliseconds <= 0n) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "handling duration must be positive",
    );
  }
  if (costMinor < 0n) {
    throw new DomainError(
      "NEGATIVE_RESULT",
      "handling cost must not be negative",
    );
  }
  validateTargets(targets);

  const durations = allocateByServedUnits(durationMilliseconds, targets);
  const costs = allocateByServedUnits(costMinor, targets);
  return targets.map((target) => ({
    targetId: target.id,
    allocatedDurationMilliseconds: durations.get(target.id) ?? 0n,
    allocatedCostMinor: costs.get(target.id) ?? 0n,
  }));
}

function validateTargets(targets: readonly HandlingAllocationTarget[]): void {
  if (targets.length === 0) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "handling allocation needs at least one target",
    );
  }
  const ids = new Set<string>();
  for (const target of targets) {
    if (target.id.trim().length === 0) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "handling allocation target ID must not be blank",
      );
    }
    if (target.servedUnits <= 0n) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "handling allocation served units must be positive",
      );
    }
    if (ids.has(target.id)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "handling allocation target IDs must be unique",
      );
    }
    ids.add(target.id);
  }
}

function allocateByServedUnits(
  total: bigint,
  targets: readonly HandlingAllocationTarget[],
): ReadonlyMap<string, bigint> {
  const totalUnits = targets.reduce(
    (sum, target) => sum + target.servedUnits,
    0n,
  );
  const values = targets.map((target) => {
    const numerator = total * target.servedUnits;
    return {
      target,
      amount: floorDivide(numerator, totalUnits),
      remainder: numerator % totalUnits,
    };
  });
  let remaining = total - values.reduce((sum, value) => sum + value.amount, 0n);
  const allocations = new Map(
    values.map((value) => [value.target.id, value.amount]),
  );
  for (const value of [...values].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return left.target.id.localeCompare(right.target.id);
  })) {
    if (remaining === 0n) break;
    allocations.set(
      value.target.id,
      (allocations.get(value.target.id) ?? 0n) + 1n,
    );
    remaining -= 1n;
  }
  return allocations;
}
