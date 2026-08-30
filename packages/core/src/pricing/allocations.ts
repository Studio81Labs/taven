import { DomainError } from "../primitives/errors.js";
import { Money } from "../primitives/money.js";
import { floorDivide } from "./arithmetic.js";
import type {
  AllocatedPriceComponent,
  AllocationTarget,
  MonetaryAllocation,
  PriceComponentAllocationInput,
} from "./types.js";

interface AllocationRemainder {
  readonly target: AllocationTarget;
  readonly amount: bigint;
  readonly remainder: bigint;
}

function assertTarget(target: AllocationTarget): void {
  if (target.id.trim().length === 0) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "allocation target ID must not be blank",
    );
  }
  if (target.basis < 0n) {
    throw new DomainError(
      "NEGATIVE_RESULT",
      "allocation target basis must not be negative",
    );
  }
}

function orderRemainders(
  values: readonly AllocationRemainder[],
): AllocationRemainder[] {
  return [...values].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return left.target.id < right.target.id
      ? -1
      : left.target.id > right.target.id
        ? 1
        : 0;
  });
}

/**
 * Splits a non-negative monetary component exactly. Positive bases receive a
 * proportional largest-remainder split; an all-zero basis deliberately falls
 * back to a deterministic equal split.
 */
export function allocateMoney(
  amount: Money,
  targets: readonly AllocationTarget[],
): readonly MonetaryAllocation[] {
  if (targets.length === 0) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "a monetary allocation needs a target",
    );
  }

  const targetIds = new Set<string>();
  for (const target of targets) {
    assertTarget(target);
    if (targetIds.has(target.id)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "allocation target IDs must be unique",
      );
    }
    targetIds.add(target.id);
  }

  const totalBasis = targets.reduce((sum, target) => sum + target.basis, 0n);
  const denominator = totalBasis === 0n ? BigInt(targets.length) : totalBasis;
  const weighted = targets.map((target) => {
    const numerator =
      totalBasis === 0n ? amount.minorUnits : amount.minorUnits * target.basis;
    return {
      target,
      amount: floorDivide(numerator, denominator),
      remainder: numerator % denominator,
    };
  });

  let unallocated =
    amount.minorUnits - weighted.reduce((sum, value) => sum + value.amount, 0n);
  const byTargetId = new Map(
    weighted.map((value) => [value.target.id, value.amount]),
  );
  for (const value of orderRemainders(weighted)) {
    if (unallocated === 0n) break;
    byTargetId.set(
      value.target.id,
      (byTargetId.get(value.target.id) ?? 0n) + 1n,
    );
    unallocated -= 1n;
  }

  return targets.map((target) => ({
    targetId: target.id,
    amount: Money.of(byTargetId.get(target.id) ?? 0n, amount.currency),
  }));
}

/** Produces independently reconcilable, immutable allocation records. */
export function allocatePriceComponents(
  components: readonly PriceComponentAllocationInput[],
): readonly AllocatedPriceComponent[] {
  const componentIds = new Set<string>();
  return components.map((component) => {
    if (component.componentId.trim().length === 0) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "price component ID must not be blank",
      );
    }
    if (componentIds.has(component.componentId)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "price component IDs must be unique",
      );
    }
    componentIds.add(component.componentId);
    return {
      componentId: component.componentId,
      amount: component.amount,
      allocations: allocateMoney(component.amount, component.targets),
    };
  });
}
