import {
  orderLockTargets,
  type LockTarget,
} from "./transactions/lock-order.js";

/** Integer amounts accepted at an adapter boundary before normalisation. */
export type ResourceAmount = bigint | number | string;

/** The immutable customer inputs which a machine candidate must reproduce. */
export interface FulfilmentSlotResourceInput {
  readonly id: string;
  readonly shipmentPlanId: string;
  readonly modelGeometryId: string;
  readonly printConfigRevisionId: string;
  readonly material: string;
  /** Null means the customer did not constrain the inventory color. */
  readonly color: string | null;
}

/** A machine's currently unreserved stock of one inventory bucket. */
export interface ResourceInventoryAvailability {
  readonly id: string;
  readonly nodeId?: string;
  readonly machineId?: string;
  /** Prefer milligrams; grams are accepted for adapters that expose grams. */
  readonly availableMilligrams?: ResourceAmount;
  readonly availableGrams?: ResourceAmount;
  /** Remaining/reserved are an alternative representation of availability. */
  readonly remainingMilligrams?: ResourceAmount;
  readonly reservedMilligrams?: ResourceAmount;
}

export interface ResourceCapacityInterval {
  readonly id?: string;
  readonly nodeId?: string;
  readonly machineId: string;
  readonly machineProfileId?: string;
  readonly machineCalibrationId?: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** A machine-specific CandidateResourceEstimate snapshot. */
export interface ResourceCandidateEstimate {
  readonly id: string;
  /** Persisted deterministic identity; ID remains the final tie-break. */
  readonly estimateKey?: string;
  /**
   * In-memory identity for one deterministic slot-assignment alternative.
   * Multiple alternatives may reference the same persisted candidate ID, but
   * the solver will select that persisted candidate at most once.
   */
  readonly plannerOptionId?: string;
  readonly nodeId: string;
  readonly machineId: string;
  readonly machineProfileId?: string;
  readonly machineCalibrationId?: string;
  readonly inventoryId: string;
  readonly shipmentPlanId: string;
  readonly modelGeometryId: string;
  readonly printConfigRevisionId: string;
  readonly material: string;
  readonly color: string | null;
  readonly requiredMaterialMilligrams: ResourceAmount;
  readonly requiredMachineSeconds: ResourceAmount;
  readonly expiresAt: Date;
  readonly intervals: readonly ResourceCapacityInterval[];
  /** Candidate estimates may produce one or more slots in one planned job. */
  readonly fulfilmentSlotIds?: readonly string[];
  /** Exact number of compatible slot IDs produced by this candidate. */
  readonly fulfilmentSlotCount?: number;
  /** `slotIds` is accepted as a concise adapter alias for fulfilmentSlotIds. */
  readonly slotIds?: readonly string[];
  /** Singular alias useful when a candidate is known to cover one slot. */
  readonly fulfilmentSlotId?: string;
  /** Any reference-slice marker makes this estimate ineligible. */
  readonly source?: "candidate" | "reference";
  readonly sliceKind?: "CANDIDATE" | "REFERENCE";
  readonly isReferenceSlice?: boolean;
  readonly primarySliceKind?: "CANDIDATE" | "REFERENCE";
  readonly tailSliceKind?: "CANDIDATE" | "REFERENCE";
}

export interface ResourcePlanSelectorInput {
  /** The immutable slot set which must be covered exactly once. */
  readonly requiredFulfilmentSlots?: readonly FulfilmentSlotResourceInput[];
  readonly requiredSlots?: readonly FulfilmentSlotResourceInput[];
  readonly candidates: readonly ResourceCandidateEstimate[];
  readonly inventory: readonly ResourceInventoryAvailability[];
  /** Existing active capacity reservations, represented as half-open ranges. */
  readonly occupiedCapacity?: readonly ResourceCapacityInterval[];
  readonly now: Date;
}

export interface ResourcePlanSlotAssignment {
  readonly fulfilmentSlotId: string;
  readonly candidateResourceEstimateId: string;
}

export interface CompleteResourcePlan {
  readonly candidates: readonly ResourceCandidateEstimate[];
  readonly candidateResourceEstimateIds: readonly string[];
  readonly assignments: readonly ResourcePlanSlotAssignment[];
  readonly requiredMaterialMilligrams: bigint;
  readonly requiredMachineSeconds: bigint;
  /** Targets are ready to acquire in the repository-wide canonical order. */
  readonly lockTargets: readonly LockTarget[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toInteger(value: ResourceAmount, name: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new RangeError(`${name} must be an integer`);
  }
}

function nonNegative(value: ResourceAmount, name: string): bigint {
  const integer = toInteger(value, name);
  if (integer < 0n) throw new RangeError(`${name} must not be negative`);
  return integer;
}

function positive(value: ResourceAmount, name: string): bigint {
  const integer = toInteger(value, name);
  if (integer <= 0n) throw new RangeError(`${name} must be positive`);
  return integer;
}

function requireId(value: string, name: string): void {
  if (value.trim().length === 0)
    throw new RangeError(`${name} must not be blank`);
}

function normaliseColor(color: string | null | undefined): string | null {
  return color ?? null;
}

function availabilityMilligrams(
  inventory: ResourceInventoryAvailability,
): bigint {
  requireId(inventory.id, "inventory ID");
  const supplied = [
    inventory.availableMilligrams !== undefined,
    inventory.availableGrams !== undefined,
    inventory.remainingMilligrams !== undefined,
  ].filter(Boolean).length;
  if (supplied > 1) {
    throw new RangeError(
      `inventory ${inventory.id} must use one availability representation`,
    );
  }
  if (inventory.availableMilligrams !== undefined) {
    return nonNegative(
      inventory.availableMilligrams,
      `inventory ${inventory.id}.availableMilligrams`,
    );
  }
  if (inventory.availableGrams !== undefined) {
    return (
      nonNegative(
        inventory.availableGrams,
        `inventory ${inventory.id}.availableGrams`,
      ) * 1_000n
    );
  }
  if (inventory.remainingMilligrams === undefined) {
    throw new RangeError(
      `inventory ${inventory.id} requires available or remaining milligrams`,
    );
  }
  const remaining = nonNegative(
    inventory.remainingMilligrams,
    `inventory ${inventory.id}.remainingMilligrams`,
  );
  const reserved = nonNegative(
    inventory.reservedMilligrams ?? 0n,
    `inventory ${inventory.id}.reservedMilligrams`,
  );
  if (reserved > remaining) {
    throw new RangeError(`inventory ${inventory.id} is over-reserved`);
  }
  return remaining - reserved;
}

function intervalOverlaps(
  left: ResourceCapacityInterval,
  right: ResourceCapacityInterval,
): boolean {
  return (
    left.machineId === right.machineId &&
    left.startsAt < right.endsAt &&
    right.startsAt < left.endsAt
  );
}

function validIntervals(
  intervals: readonly ResourceCapacityInterval[],
): boolean {
  for (const interval of intervals) {
    if (interval.id !== undefined)
      requireId(interval.id, "capacity interval ID");
    if (interval.nodeId !== undefined)
      requireId(interval.nodeId, "capacity interval node ID");
    requireId(interval.machineId, "capacity machine ID");
    if (
      !(interval.startsAt instanceof Date) ||
      Number.isNaN(interval.startsAt.getTime())
    ) {
      throw new RangeError("capacity interval start must be a valid Date");
    }
    if (
      !(interval.endsAt instanceof Date) ||
      Number.isNaN(interval.endsAt.getTime())
    ) {
      throw new RangeError("capacity interval end must be a valid Date");
    }
    if (interval.startsAt >= interval.endsAt) return false;
  }
  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < intervals.length;
      rightIndex += 1
    ) {
      if (intervalOverlaps(intervals[leftIndex]!, intervals[rightIndex]!))
        return false;
    }
  }
  return true;
}

function intervalDurationSeconds(
  intervals: readonly ResourceCapacityInterval[],
): bigint {
  const milliseconds = intervals.reduce(
    (total, interval) =>
      total + BigInt(interval.endsAt.getTime() - interval.startsAt.getTime()),
    0n,
  );
  return milliseconds / 1_000n;
}

function candidateSlots(
  candidate: ResourceCandidateEstimate,
): readonly string[] {
  const aliases = [candidate.fulfilmentSlotIds, candidate.slotIds].filter(
    (value): value is readonly string[] => value !== undefined,
  );
  if (candidate.fulfilmentSlotId !== undefined)
    aliases.push([candidate.fulfilmentSlotId]);
  if (aliases.length === 0) return [];
  const first = aliases[0]!;
  for (const alias of aliases.slice(1)) {
    if (
      alias.length !== first.length ||
      alias.some((id, index) => id !== first[index])
    )
      return [];
  }
  return first;
}

function matchesSlot(
  candidate: ResourceCandidateEstimate,
  slot: FulfilmentSlotResourceInput,
): boolean {
  return (
    candidate.shipmentPlanId === slot.shipmentPlanId &&
    candidate.modelGeometryId === slot.modelGeometryId &&
    candidate.printConfigRevisionId === slot.printConfigRevisionId &&
    candidate.material === slot.material &&
    (slot.color === null ||
      normaliseColor(candidate.color) === normaliseColor(slot.color))
  );
}

function plannerOptionIdentity(candidate: ResourceCandidateEstimate): string {
  return candidate.plannerOptionId ?? candidate.id;
}

function compareCandidateIds(
  left: ResourceCandidateEstimate,
  right: ResourceCandidateEstimate,
): number {
  return (
    compareStrings(
      left.estimateKey ?? left.id,
      right.estimateKey ?? right.id,
    ) ||
    compareStrings(left.id, right.id) ||
    compareStrings(plannerOptionIdentity(left), plannerOptionIdentity(right))
  );
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

interface UsableCandidate extends ResourceCandidateEstimate {
  readonly slotIds: readonly string[];
  readonly coverageQuantity: number;
  readonly requiredMaterial: bigint;
  readonly requiredMachineSeconds: bigint;
}

interface PlanChoice {
  readonly candidates: readonly UsableCandidate[];
  readonly requiredMaterial: bigint;
  readonly requiredMachineSeconds: bigint;
}

function choiceIsBetter(
  candidate: PlanChoice,
  current: PlanChoice | undefined,
): boolean {
  if (!current) return true;
  if (candidate.candidates.length !== current.candidates.length) {
    return candidate.candidates.length < current.candidates.length;
  }
  if (candidate.requiredMaterial !== current.requiredMaterial) {
    return candidate.requiredMaterial < current.requiredMaterial;
  }
  if (candidate.requiredMachineSeconds !== current.requiredMachineSeconds) {
    return candidate.requiredMachineSeconds < current.requiredMachineSeconds;
  }
  const left = [...candidate.candidates].sort(compareCandidateIds);
  const right = [...current.candidates].sort(compareCandidateIds);
  for (let index = 0; index < left.length; index += 1) {
    const comparison = compareCandidateIds(left[index]!, right[index]!);
    if (comparison !== 0) return comparison < 0;
  }
  return false;
}

function buildLockTargets(
  candidates: readonly UsableCandidate[],
): readonly LockTarget[] {
  const targets: LockTarget[] = [];
  const identities = new Set<string>();
  const add = (target: LockTarget): void => {
    const identity = `${target.kind}\u0000${target.nodeId ?? ""}\u0000${target.id}`;
    if (!identities.has(identity)) {
      identities.add(identity);
      targets.push(target);
    }
  };
  for (const candidate of candidates) {
    add({
      kind: "candidate_resource_estimate",
      id: candidate.id,
      nodeId: candidate.nodeId,
    });
    add({ kind: "machine", id: candidate.machineId, nodeId: candidate.nodeId });
    if (candidate.machineProfileId) {
      add({ kind: "machine_profile", id: candidate.machineProfileId });
    }
    if (candidate.machineCalibrationId) {
      add({
        kind: "machine_calibration",
        id: candidate.machineCalibrationId,
        nodeId: candidate.nodeId,
      });
    }
    add({
      kind: "inventory",
      id: candidate.inventoryId,
      nodeId: candidate.nodeId,
    });
    for (const interval of candidate.intervals) {
      if (interval.id) {
        add({
          kind: "candidate_capacity_interval",
          id: interval.id,
          nodeId: candidate.nodeId,
        });
      }
    }
  }
  return orderLockTargets(targets);
}

/**
 * Visits one canonical selection for every materially different distribution
 * of a candidate's coverage across the remaining slots.
 *
 * Slots with the same usable planner-option set are interchangeable: choosing
 * a different ID from that set cannot change candidate eligibility, inventory,
 * capacity, or the plan ranking.  Assign their lexicographically first IDs
 * instead of enumerating every subset.  Different option sets remain separate
 * groups, so assignments that can change a feasible candidate set are still
 * explored.
 */
function forEachCanonicalSlotSelection(
  requiredSlotId: string,
  compatibleSlotIds: readonly string[],
  quantity: number,
  slotOptionSet: ReadonlyMap<string, string>,
  visit: (slotIds: readonly string[]) => void,
): void {
  if (!compatibleSlotIds.includes(requiredSlotId)) return;
  const slotGroups = new Map<string, string[]>();
  for (const slotId of compatibleSlotIds) {
    const optionSet = slotOptionSet.get(slotId);
    if (optionSet === undefined) return;
    const group = slotGroups.get(optionSet) ?? [];
    group.push(slotId);
    slotGroups.set(optionSet, group);
  }
  const requiredOptionSet = slotOptionSet.get(requiredSlotId);
  if (requiredOptionSet === undefined) return;
  const groups = [...slotGroups.entries()]
    .map(([optionSet, slotIds]) => ({
      optionSet,
      slotIds: slotIds.sort(compareStrings),
      minimum: optionSet === requiredOptionSet ? 1 : 0,
    }))
    .sort(
      (left, right) =>
        compareStrings(left.optionSet, right.optionSet) ||
        compareStrings(left.slotIds[0]!, right.slotIds[0]!),
    );
  const selected: string[] = [];
  const choose = (groupIndex: number, remaining: number): void => {
    if (groupIndex === groups.length) {
      if (remaining === 0) visit([...selected].sort(compareStrings));
      return;
    }
    const group = groups[groupIndex]!;
    const maximum = Math.min(group.slotIds.length, remaining);
    for (let count = group.minimum; count <= maximum; count += 1) {
      if (
        remaining - count >
        groups
          .slice(groupIndex + 1)
          .reduce((total, next) => total + next.slotIds.length, 0)
      ) {
        continue;
      }
      const canonicalSlotIds =
        group.optionSet === requiredOptionSet
          ? [
              requiredSlotId,
              ...group.slotIds
                .filter((slotId) => slotId !== requiredSlotId)
                .slice(0, count - 1),
            ]
          : group.slotIds.slice(0, count);
      selected.push(...canonicalSlotIds);
      choose(groupIndex + 1, remaining - count);
      selected.length -= canonicalSlotIds.length;
    }
  };
  choose(0, quantity);
}

/**
 * Selects one complete, machine-specific resource plan, or returns undefined
 * when no all-or-none plan can cover the requested slot set.
 *
 * Candidates are immutable snapshots: reference slices are never eligible and
 * candidate inputs must match every constrained covered-slot input. Capacity
 * intervals are half-open, so adjacent intervals are allowed while overlaps
 * are not. Plans are ranked by fewest candidates, then material, then machine
 * seconds, then the sorted estimate-key/ID/planner-option tuple. Within an
 * interchangeable slot group, assignments use lexicographically first IDs.
 */
export function selectCompleteResourcePlan(
  input: ResourcePlanSelectorInput,
): CompleteResourcePlan | undefined {
  const slots = input.requiredFulfilmentSlots ?? input.requiredSlots;
  if (!slots || slots.length === 0) return undefined;
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new RangeError("now must be a valid Date");
  }

  const slotById = new Map<string, FulfilmentSlotResourceInput>();
  for (const slot of slots) {
    requireId(slot.id, "fulfilment slot ID");
    if (slotById.has(slot.id)) return undefined;
    slotById.set(slot.id, slot);
  }
  const inventoryAvailability = new Map<string, bigint>();
  for (const inventory of input.inventory) {
    if (inventory.nodeId !== undefined)
      requireId(inventory.nodeId, "inventory node ID");
    if (inventory.machineId !== undefined)
      requireId(inventory.machineId, "inventory machine ID");
    if (inventoryAvailability.has(inventory.id)) return undefined;
    inventoryAvailability.set(inventory.id, availabilityMilligrams(inventory));
  }

  const occupiedCapacity = input.occupiedCapacity ?? [];
  if (!validIntervals(occupiedCapacity)) return undefined;
  const candidatesBySlot = new Map<string, UsableCandidate[]>();
  const plannerOptionIds = new Set<string>();
  const usableCandidates: UsableCandidate[] = [];
  for (const candidate of input.candidates) {
    requireId(candidate.id, "candidate ID");
    if (candidate.plannerOptionId !== undefined) {
      requireId(candidate.plannerOptionId, "candidate planner option ID");
    }
    requireId(candidate.nodeId, "candidate node ID");
    requireId(candidate.machineId, "candidate machine ID");
    requireId(candidate.inventoryId, "candidate inventory ID");
    const plannerOptionId = plannerOptionIdentity(candidate);
    if (plannerOptionIds.has(plannerOptionId)) return undefined;
    plannerOptionIds.add(plannerOptionId);
    if (
      candidate.source === "reference" ||
      candidate.sliceKind === "REFERENCE" ||
      candidate.isReferenceSlice === true ||
      candidate.primarySliceKind === "REFERENCE" ||
      candidate.tailSliceKind === "REFERENCE" ||
      !(candidate.expiresAt instanceof Date) ||
      Number.isNaN(candidate.expiresAt.getTime()) ||
      input.now >= candidate.expiresAt
    )
      continue;
    if (
      candidate.intervals.length === 0 ||
      !validIntervals(candidate.intervals)
    )
      continue;
    const slotIds = candidateSlots(candidate);
    if (slotIds.length === 0 || hasDuplicate(slotIds)) continue;
    if (slotIds.some((slotId) => !slotById.has(slotId))) continue;
    const coverageQuantity = candidate.fulfilmentSlotCount ?? slotIds.length;
    if (
      !Number.isSafeInteger(coverageQuantity) ||
      coverageQuantity < 1 ||
      coverageQuantity > slotIds.length
    )
      continue;
    const requiredMaterial = positive(
      candidate.requiredMaterialMilligrams,
      `candidate ${candidate.id}.requiredMaterialMilligrams`,
    );
    const requiredMachineSeconds = positive(
      candidate.requiredMachineSeconds,
      `candidate ${candidate.id}.requiredMachineSeconds`,
    );
    if (
      candidate.intervals.some(
        (interval) =>
          interval.machineId !== candidate.machineId ||
          (interval.nodeId !== undefined &&
            interval.nodeId !== candidate.nodeId) ||
          interval.startsAt <= input.now,
      ) ||
      hasDuplicate(
        candidate.intervals.flatMap(({ id }) => (id === undefined ? [] : [id])),
      ) ||
      intervalDurationSeconds(candidate.intervals) < requiredMachineSeconds
    )
      continue;
    const available = inventoryAvailability.get(candidate.inventoryId);
    if (available === undefined) continue;
    const inventory = input.inventory.find(
      (item) => item.id === candidate.inventoryId,
    )!;
    if (
      (inventory.nodeId !== undefined &&
        inventory.nodeId !== candidate.nodeId) ||
      (inventory.machineId !== undefined &&
        inventory.machineId !== candidate.machineId)
    )
      continue;
    if (
      candidate.intervals.some((interval) =>
        occupiedCapacity.some((occupied) =>
          intervalOverlaps(interval, occupied),
        ),
      )
    )
      continue;
    const usable: UsableCandidate = {
      ...candidate,
      slotIds,
      coverageQuantity,
      requiredMaterial,
      requiredMachineSeconds,
    };
    if (
      slotIds.some((slotId) => !matchesSlot(candidate, slotById.get(slotId)!))
    )
      continue;
    usableCandidates.push(usable);
    for (const slotId of slotIds) {
      const candidates = candidatesBySlot.get(slotId) ?? [];
      candidates.push(usable);
      candidatesBySlot.set(slotId, candidates);
    }
  }
  usableCandidates.sort(compareCandidateIds);
  for (const candidates of candidatesBySlot.values())
    candidates.sort(compareCandidateIds);
  if (
    [...slotById.keys()].some((slotId) => !candidatesBySlot.get(slotId)?.length)
  )
    return undefined;

  const slotOptionSet = new Map<string, string>();
  for (const [slotId, candidates] of candidatesBySlot) {
    slotOptionSet.set(
      slotId,
      JSON.stringify(candidates.map(plannerOptionIdentity)),
    );
  }

  let best: PlanChoice | undefined;
  const selected = new Set<string>();
  const covered = new Set<string>();
  const usedIntervals: ResourceCapacityInterval[] = [];
  const usedInventory = new Map<string, bigint>();
  const orderedSlotIds = [...slotById.keys()].sort(compareStrings);

  const search = (
    position: number,
    chosen: UsableCandidate[],
    material: bigint,
    machineSeconds: bigint,
  ): void => {
    if (position === orderedSlotIds.length) {
      const choice = {
        candidates: [...chosen],
        requiredMaterial: material,
        requiredMachineSeconds: machineSeconds,
      };
      if (choiceIsBetter(choice, best)) best = choice;
      return;
    }
    const uncoveredSlotId = orderedSlotIds.find(
      (slotId) => !covered.has(slotId),
    );
    if (!uncoveredSlotId) return;
    const options = candidatesBySlot.get(uncoveredSlotId) ?? [];
    for (const candidate of options) {
      if (selected.has(candidate.id)) continue;
      const availableSlotIds = candidate.slotIds.filter(
        (slotId) => !covered.has(slotId),
      );
      if (availableSlotIds.length < candidate.coverageQuantity) continue;
      if (
        candidate.intervals.some((interval) =>
          usedIntervals.some((used) => intervalOverlaps(interval, used)),
        )
      )
        continue;
      const currentInventory = usedInventory.get(candidate.inventoryId) ?? 0n;
      const available = inventoryAvailability.get(candidate.inventoryId)!;
      if (currentInventory + candidate.requiredMaterial > available) continue;
      forEachCanonicalSlotSelection(
        uncoveredSlotId,
        availableSlotIds,
        candidate.coverageQuantity,
        slotOptionSet,
        (selectedSlotIds) => {
          const selectedCandidate = {
            ...candidate,
            slotIds: selectedSlotIds,
          };
          selected.add(candidate.id);
          selectedSlotIds.forEach((slotId) => covered.add(slotId));
          candidate.intervals.forEach((interval) =>
            usedIntervals.push(interval),
          );
          usedInventory.set(
            candidate.inventoryId,
            currentInventory + candidate.requiredMaterial,
          );
          search(
            position + selectedSlotIds.length,
            [...chosen, selectedCandidate],
            material + candidate.requiredMaterial,
            machineSeconds + candidate.requiredMachineSeconds,
          );
          usedInventory.set(candidate.inventoryId, currentInventory);
          candidate.intervals.forEach(() => usedIntervals.pop());
          selectedSlotIds.forEach((slotId) => covered.delete(slotId));
          selected.delete(candidate.id);
        },
      );
    }
  };
  search(0, [], 0n, 0n);
  if (!best) return undefined;

  const selectedCandidates = [...best.candidates].sort(compareCandidateIds);
  const selectedCandidateInputs = selectedCandidates.map((selected) =>
    input.candidates.find(
      (candidate) =>
        plannerOptionIdentity(candidate) === plannerOptionIdentity(selected),
    )!,
  );
  const assignments = selectedCandidates
    .flatMap((candidate) =>
      candidate.slotIds.map((fulfilmentSlotId) => ({
        fulfilmentSlotId,
        candidateResourceEstimateId: candidate.id,
      })),
    )
    .sort(
      (left, right) =>
        compareStrings(left.fulfilmentSlotId, right.fulfilmentSlotId) ||
        compareStrings(
          left.candidateResourceEstimateId,
          right.candidateResourceEstimateId,
        ),
    );
  return {
    candidates: selectedCandidateInputs,
    candidateResourceEstimateIds: selectedCandidates.map(({ id }) => id),
    assignments,
    requiredMaterialMilligrams: best.requiredMaterial,
    requiredMachineSeconds: best.requiredMachineSeconds,
    lockTargets: buildLockTargets(selectedCandidates),
  };
}

/** Concise alias for callers that already operate in the resource-plan domain. */
export const selectResourcePlan = selectCompleteResourcePlan;
