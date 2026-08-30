import { buildCanonicalKey } from "./canonical-key.js";
import { Sha256Digest } from "../primitives/digest.js";
import { DomainError } from "../primitives/errors.js";
import type { RevisionRef } from "../primitives/revision-ref.js";

export type ReferenceProfileRevisionRef = RevisionRef<"reference-profile">;
export type MachineProfileRevisionRef = RevisionRef<"machine-profile">;
export type MachineCalibrationRevisionRef = RevisionRef<"machine-calibration">;
export type PrintConfigRevisionRef = RevisionRef<"print-config">;
export type ArrangementRevisionRef = RevisionRef<"arrangement">;

export type SliceCacheKey = string & { readonly __brand: "SliceCacheKey" };
export type ProductionPackageKey = string & {
  readonly __brand: "ProductionPackageKey";
};
export type MachineOccupancySliceCacheKey = string & {
  readonly __brand: "MachineOccupancySliceCacheKey";
};
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

export interface MachineOccupancySliceCacheKeyInput extends ProductionSliceCacheKeyInput {
  readonly modelGeometryId: string;
  readonly geometrySelectionHash: Sha256Digest;
  readonly arrangementRevision: ArrangementRevisionRef;
}

export interface ProductionPackageKeyInput extends MachineOccupancySliceCacheKeyInput {
  readonly quantity: number | bigint;
  readonly acceptedJobId: string;
}

export interface CandidateResourceEstimateKeyInput extends MachineOccupancySliceCacheKeyInput {
  readonly quantity: number | bigint;
  readonly shipmentPlanId: string;
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

function buildPersistableIdentityKey(
  namespace: string,
  version: number,
  components: Parameters<typeof buildCanonicalKey>[2],
): string {
  const identitySha256 = buildIdentitySha256(namespace, version, components);
  return buildCanonicalKey(namespace, version, [
    {
      name: "identity_sha256",
      value: identitySha256.hex,
    },
  ]);
}

function buildIdentitySha256(
  namespace: string,
  version: number,
  components: Parameters<typeof buildCanonicalKey>[2],
): Sha256Digest {
  return Sha256Digest.of(buildCanonicalKey(namespace, version, components));
}

function machineOccupancyComponents(
  input: MachineOccupancySliceCacheKeyInput,
): Parameters<typeof buildCanonicalKey>[2] {
  return [
    { name: "geometry_hash", value: input.geometryHash.hex },
    { name: "model_geometry_id", value: input.modelGeometryId },
    {
      name: "geometry_selection_hash",
      value: input.geometrySelectionHash.hex,
    },
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
    {
      name: "arrangement_revision_id",
      value: input.arrangementRevision.id,
    },
    { name: "parts_per_plate", value: input.partsPerPlate },
  ];
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

/**
 * @deprecated Retained for persisted v0 per-occupancy keys only. Candidate
 * metrics must use buildMachineOccupancySliceCacheKey and accepted multi-plate
 * jobs must use buildProductionPackageKey so selection and arrangement remain
 * part of their identities.
 */
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

export function buildMachineOccupancySliceCacheKey(
  input: MachineOccupancySliceCacheKeyInput,
): MachineOccupancySliceCacheKey {
  assertPositive(input.partsPerPlate, "partsPerPlate");
  return buildPersistableIdentityKey(
    "machine-occupancy-slice",
    1,
    machineOccupancyComponents(input),
  ) as MachineOccupancySliceCacheKey;
}

export function machineOccupancySliceIdentitySha256(
  input: MachineOccupancySliceCacheKeyInput,
): Sha256Digest {
  assertPositive(input.partsPerPlate, "partsPerPlate");
  return buildIdentitySha256(
    "machine-occupancy-slice",
    1,
    machineOccupancyComponents(input),
  );
}

export function buildProductionPackageKey(
  input: ProductionPackageKeyInput,
): ProductionPackageKey {
  assertPositive(input.partsPerPlate, "partsPerPlate");
  assertPositive(input.quantity, "quantity");
  return buildPersistableIdentityKey("production-package", 1, [
    ...machineOccupancyComponents(input),
    { name: "quantity", value: input.quantity },
    { name: "accepted_job_id", value: input.acceptedJobId },
  ]) as ProductionPackageKey;
}

export function buildCandidateResourceEstimateKey(
  input: CandidateResourceEstimateKeyInput,
): CandidateResourceEstimateKey {
  assertPositive(input.partsPerPlate, "partsPerPlate");
  assertPositive(input.quantity, "quantity");
  return buildPersistableIdentityKey("candidate-resource-estimate", 2, [
    ...machineOccupancyComponents(input),
    { name: "quantity", value: input.quantity },
    { name: "shipment_plan_id", value: input.shipmentPlanId },
  ]) as CandidateResourceEstimateKey;
}
