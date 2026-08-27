import { buildCanonicalKey } from "./canonical-key.js";
import type { Sha256Digest } from "../primitives/digest.js";
import { DomainError } from "../primitives/errors.js";
import type { RevisionRef } from "../primitives/revision-ref.js";

export type ReferenceProfileRevisionRef = RevisionRef<"reference-profile">;
export type MachineProfileRevisionRef = RevisionRef<"machine-profile">;
export type MachineCalibrationRevisionRef = RevisionRef<"machine-calibration">;
export type PrintConfigRevisionRef = RevisionRef<"print-config">;
export type ArrangementRevisionRef = RevisionRef<"arrangement">;

export type SliceCacheKey = string & { readonly __brand: "SliceCacheKey" };
export type CandidateResourceEstimateKey = string & {
  readonly __brand: "CandidateResourceEstimateKey";
};

export interface ReferenceSliceCacheKeyInput {
  readonly geometryHash: Sha256Digest;
  readonly referenceProfileRevision: ReferenceProfileRevisionRef;
  readonly printConfigRevision: PrintConfigRevisionRef;
  readonly partsPerPlate: number | bigint;
}

export interface ProductionSliceCacheKeyInput {
  readonly geometryHash: Sha256Digest;
  readonly machineProfileRevision: MachineProfileRevisionRef;
  readonly machineCalibrationRevision: MachineCalibrationRevisionRef;
  readonly printConfigRevision: PrintConfigRevisionRef;
  readonly partsPerPlate: number | bigint;
}

export interface CandidateResourceEstimateKeyInput {
  readonly geometryHash: Sha256Digest;
  readonly machineProfileRevision: MachineProfileRevisionRef;
  readonly machineCalibrationRevision: MachineCalibrationRevisionRef;
  readonly printConfigRevision: PrintConfigRevisionRef;
  readonly quantity: number | bigint;
  readonly shipmentPlanId: string;
  readonly arrangementRevision: ArrangementRevisionRef;
}

function assertPositive(value: number | bigint, label: string): void {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new DomainError(
      "INVALID_KEY_COMPONENT",
      `${label} must be a safe integer`,
    );
  }
  if (value <= 0) {
    throw new DomainError("INVALID_KEY_COMPONENT", `${label} must be positive`);
  }
}

export function buildReferenceSliceCacheKey(
  input: ReferenceSliceCacheKeyInput,
): SliceCacheKey {
  assertPositive(input.partsPerPlate, "partsPerPlate");
  return buildCanonicalKey("reference-slice", 1, [
    { name: "geometry_hash", value: input.geometryHash.hex },
    {
      name: "reference_profile_revision_id",
      value: input.referenceProfileRevision.id,
    },
    {
      name: "print_config_revision_id",
      value: input.printConfigRevision.id,
    },
    { name: "parts_per_plate", value: input.partsPerPlate },
  ]) as SliceCacheKey;
}

export function buildProductionSliceCacheKey(
  input: ProductionSliceCacheKeyInput,
): SliceCacheKey {
  assertPositive(input.partsPerPlate, "partsPerPlate");
  return buildCanonicalKey("production-slice", 1, [
    { name: "geometry_hash", value: input.geometryHash.hex },
    {
      name: "machine_profile_revision_id",
      value: input.machineProfileRevision.id,
    },
    {
      name: "machine_calibration_revision_id",
      value: input.machineCalibrationRevision.id,
    },
    {
      name: "print_config_revision_id",
      value: input.printConfigRevision.id,
    },
    { name: "parts_per_plate", value: input.partsPerPlate },
  ]) as SliceCacheKey;
}

export function buildCandidateResourceEstimateKey(
  input: CandidateResourceEstimateKeyInput,
): CandidateResourceEstimateKey {
  assertPositive(input.quantity, "quantity");
  return buildCanonicalKey("candidate-resource-estimate", 1, [
    { name: "geometry_hash", value: input.geometryHash.hex },
    {
      name: "machine_profile_revision_id",
      value: input.machineProfileRevision.id,
    },
    {
      name: "machine_calibration_revision_id",
      value: input.machineCalibrationRevision.id,
    },
    {
      name: "print_config_revision_id",
      value: input.printConfigRevision.id,
    },
    { name: "quantity", value: input.quantity },
    { name: "shipment_plan_id", value: input.shipmentPlanId },
    {
      name: "arrangement_revision_id",
      value: input.arrangementRevision.id,
    },
  ]) as CandidateResourceEstimateKey;
}
