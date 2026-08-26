import { describe, expect, it } from "vitest";
import {
  buildCandidateResourceEstimateKey,
  buildProductionSliceCacheKey,
  buildReferenceSliceCacheKey,
} from "./cache-key.js";
import { Sha256Digest } from "../primitives/digest.js";
import { RevisionRef } from "../primitives/revision-ref.js";

const geometryHash = Sha256Digest.parse("a".repeat(64));
const referenceProfileRevision = (id: string) =>
  RevisionRef.create("reference-profile", id);
const machineProfileRevision = (id: string) =>
  RevisionRef.create("machine-profile", id);
const machineCalibrationRevision = (id: string) =>
  RevisionRef.create("machine-calibration", id);
const printConfigRevision = (id: string) =>
  RevisionRef.create("print-config", id);
const arrangementRevision = (id: string) =>
  RevisionRef.create("arrangement", id);

describe("slice cache key builders", () => {
  it("is deterministic and changes for every reference-slice identity input", () => {
    const base = {
      geometryHash,
      referenceProfileRevision: referenceProfileRevision("reference-1"),
      printConfigRevision: printConfigRevision("config-1"),
      partsPerPlate: 4,
    } as const;
    const key = buildReferenceSliceCacheKey(base);

    expect(buildReferenceSliceCacheKey(base)).toBe(key);
    expect(
      buildReferenceSliceCacheKey({
        ...base,
        geometryHash: Sha256Digest.parse("b".repeat(64)),
      }),
    ).not.toBe(key);
    expect(
      buildReferenceSliceCacheKey({
        ...base,
        referenceProfileRevision: referenceProfileRevision("reference-2"),
      }),
    ).not.toBe(key);
    expect(
      buildReferenceSliceCacheKey({
        ...base,
        printConfigRevision: printConfigRevision("config-2"),
      }),
    ).not.toBe(key);
    expect(buildReferenceSliceCacheKey({ ...base, partsPerPlate: 3 })).not.toBe(
      key,
    );
  });

  it("keeps reference and production namespaces separate", () => {
    const reference = buildReferenceSliceCacheKey({
      geometryHash,
      referenceProfileRevision: referenceProfileRevision("profile-1"),
      printConfigRevision: printConfigRevision("config-1"),
      partsPerPlate: 1,
    });
    const production = buildProductionSliceCacheKey({
      geometryHash,
      machineProfileRevision: machineProfileRevision("profile-1"),
      machineCalibrationRevision: machineCalibrationRevision("calibration-1"),
      printConfigRevision: printConfigRevision("config-1"),
      partsPerPlate: 1,
    });

    expect(production).not.toBe(reference);
  });

  it("includes the complete candidate estimate identity", () => {
    const base = {
      geometryHash,
      machineProfileRevision: machineProfileRevision("machine-profile-1"),
      machineCalibrationRevision: machineCalibrationRevision("calibration-1"),
      printConfigRevision: printConfigRevision("config-1"),
      quantity: 8,
      shipmentPlanId: "shipment-plan-1",
      arrangementRevision: arrangementRevision("arrangement-1"),
    } as const;
    const key = buildCandidateResourceEstimateKey(base);

    for (const changed of [
      {
        ...base,
        geometryHash: Sha256Digest.parse("b".repeat(64)),
      },
      {
        ...base,
        machineProfileRevision: machineProfileRevision("machine-profile-2"),
      },
      {
        ...base,
        machineCalibrationRevision: machineCalibrationRevision("calibration-2"),
      },
      { ...base, printConfigRevision: printConfigRevision("config-2") },
      { ...base, quantity: 9 },
      { ...base, shipmentPlanId: "shipment-plan-2" },
      { ...base, arrangementRevision: arrangementRevision("arrangement-2") },
    ]) {
      expect(buildCandidateResourceEstimateKey(changed)).not.toBe(key);
    }
  });

  it("rejects invalid plate and quantity components", () => {
    expect(() =>
      buildReferenceSliceCacheKey({
        geometryHash,
        referenceProfileRevision: referenceProfileRevision("reference-1"),
        printConfigRevision: printConfigRevision("config-1"),
        partsPerPlate: 0,
      }),
    ).toThrow("partsPerPlate must be positive");
    expect(() =>
      buildCandidateResourceEstimateKey({
        geometryHash,
        machineProfileRevision: machineProfileRevision("machine-profile-1"),
        machineCalibrationRevision: machineCalibrationRevision("calibration-1"),
        printConfigRevision: printConfigRevision("config-1"),
        quantity: 1.5,
        shipmentPlanId: "shipment-plan-1",
        arrangementRevision: arrangementRevision("arrangement-1"),
      }),
    ).toThrow("quantity must be a safe integer");
  });
});
