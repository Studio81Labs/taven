import {
  SlicingJobSchema,
  geometrySelectionSha256,
  machineOccupancyCacheIdentitySha256,
  productionArtifactObjectKey,
  slicingInputFingerprint,
  slicingResultForJobSchema,
  type SlicingResult,
} from "@taven/slicer-contracts";
import { describe, expect, it } from "vitest";
import { runFixtureSlicingJob } from "./fixture-handler.js";
import { runLegacyV1FixtureSlicingJob } from "./legacy-v1-fixture-handler.js";

const ids = {
  job: "93ce90b0-3ed3-4d64-8a46-f032f31fa21d",
  productionJob: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  correlation: "bd80ab1d-5648-4f54-ae13-95fa2317150d",
  model: "11111111-1111-4111-8111-111111111111",
  geometry: "22222222-2222-4222-8222-222222222222",
  referenceProfile: "33333333-3333-4333-8333-333333333333",
  printConfig: "44444444-4444-4444-8444-444444444444",
  machine: "55555555-5555-4555-8555-555555555555",
  machineProfile: "66666666-6666-4666-8666-666666666666",
  calibration: "77777777-7777-4777-8777-777777777777",
  shipment: "88888888-8888-4888-8888-888888888888",
  arrangement: "99999999-9999-4999-8999-999999999999",
  reservation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const revision = (revisionId: string, digest: string) => ({
  revisionId,
  contentSha256: digest.repeat(64),
});
const slicerProfile = (revisionId: string, digest: string) => ({
  ...revision(revisionId, digest),
  slicerEngine: "fixture",
  slicerVersion: "0.0.0",
});
const machineSlicerProfile = (
  revisionId: string,
  digest: string,
  productionArtifactFormat: "gcode_3mf" | "bgcode" | "gcode" = "gcode_3mf",
) => ({
  ...slicerProfile(revisionId, digest),
  productionArtifactFormat,
});
const geometry = {
  sourceModelFileId: ids.model,
  sourceContentSha256: "b".repeat(64),
  modelGeometryId: ids.geometry,
  canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
  geometrySha256: "c".repeat(64),
  bodyIds: ["body-0001"],
  selectionSha256: geometrySelectionSha256(["body-0001"]),
};
const referenceInput = {
  geometry,
  referenceProfile: slicerProfile(ids.referenceProfile, "e"),
  printConfig: revision(ids.printConfig, "f"),
  partsPerPlate: 1,
};
const machineInput = {
  geometry,
  machineId: ids.machine,
  machineProfile: machineSlicerProfile(ids.machineProfile, "1"),
  machineCalibration: revision(ids.calibration, "2"),
  printConfig: revision(ids.printConfig, "f"),
  arrangementRevision: revision(ids.arrangement, "3"),
  partsPerPlate: 2,
};
const occupancySliceTarget = (
  input: Parameters<typeof machineOccupancyCacheIdentitySha256>[0],
  partsPerPlate: number,
) => {
  const cacheIdentitySha256 = machineOccupancyCacheIdentitySha256(
    input,
    partsPerPlate,
  );
  return {
    partsPerPlate,
    cacheIdentitySha256,
    analysisObjectKey: `slice-metrics/${cacheIdentitySha256}/result.json`,
  };
};
const candidateOccupancySliceTargets = [2, 1].map((partsPerPlate) =>
  occupancySliceTarget(machineInput, partsPerPlate),
);
const candidateCacheIdentitySha256 =
  candidateOccupancySliceTargets[0]!.cacheIdentitySha256;
const candidateTailCacheIdentitySha256 =
  candidateOccupancySliceTargets[1]!.cacheIdentitySha256;

function fixtureJob(
  kind:
    | "model_inspection"
    | "reference_slice"
    | "candidate_estimate"
    | "production_slice",
  input: unknown,
  jobId = ids.job,
) {
  const inputFingerprintSha256 = slicingInputFingerprint(kind, input);
  return {
    contractVersion: 2 as const,
    kind,
    jobId,
    correlationId: ids.correlation,
    inputFingerprintSha256,
    idempotencyKey: `slicer:v2:${kind}:${jobId}:${inputFingerprintSha256}`,
    attempt: 1,
    input,
  };
}

const inspectionInputBase = {
  source: {
    modelFileId: ids.model,
    format: "stl",
    objectKey: `models/${ids.model}/source`,
    contentSha256: "a".repeat(64),
  },
  inspectionRevision: "inspection-v1",
  inspectionConfigSha256: "b".repeat(64),
  canonicalizerRevision: "canonical-v1",
  canonicalizerConfigSha256: "c".repeat(64),
};
const sourceInspectionInput = {
  ...inspectionInputBase,
  operation: { mode: "inspect_source" as const },
};
const selectionBodyIds = ["body-0001"];
const inspectionJob = fixtureJob("model_inspection", {
  ...inspectionInputBase,
  operation: {
    mode: "canonicalize_selection",
    sourceInspectionFingerprintSha256: slicingInputFingerprint(
      "model_inspection",
      sourceInspectionInput,
    ),
    bodyIds: selectionBodyIds,
    selectionSha256: geometrySelectionSha256(selectionBodyIds),
    confirmedUnitConversion: {
      sourceUnit: "millimeter",
      targetUnit: "millimeter",
      scaleFactorPpm: 1_000_000,
    },
    targetGeometry: {
      modelGeometryId: ids.geometry,
      canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
    },
  },
});
const sourceInspectionJob = fixtureJob(
  "model_inspection",
  sourceInspectionInput,
);
const referenceJob = fixtureJob("reference_slice", referenceInput);
const candidateInput = {
  ...machineInput,
  quantity: 3,
  shipmentPlanId: ids.shipment,
  occupancySliceTargets: candidateOccupancySliceTargets,
};
const candidateJob = fixtureJob("candidate_estimate", candidateInput);
const productionInput = {
  ...machineInput,
  quantity: 5,
  acceptedJobId: ids.productionJob,
  productionReservationId: ids.reservation,
};
const productionJob = fixtureJob(
  "production_slice",
  productionInput,
  ids.productionJob,
);

function artifactSha256(result: SlicingResult): string {
  if (
    (result.kind === "reference_slice" || result.kind === "production_slice") &&
    result.outcome.status === "succeeded"
  ) {
    return result.outcome.artifact.sha256;
  }
  throw new TypeError("expected a successful artifact result");
}

describe("runFixtureSlicingJob", () => {
  it.each([
    ["model_inspection", inspectionJob],
    ["reference_slice", referenceJob],
    ["candidate_estimate", candidateJob],
    ["production_slice", productionJob],
  ] as const)("dispatches a valid %s result", (kind, job) => {
    expect(runFixtureSlicingJob(job)).toMatchObject({
      kind,
      jobId: job.jobId,
      outcome: { status: "succeeded" },
    });
  });

  it("returns identical results for identical immutable input", () => {
    expect(runFixtureSlicingJob(referenceJob)).toEqual(
      runFixtureSlicingJob(referenceJob),
    );
  });

  it("separates source discovery from selected geometry persistence", () => {
    expect(runFixtureSlicingJob(sourceInspectionJob)).toMatchObject({
      outcome: { status: "succeeded", canonicalGeometry: null },
    });
    expect(runFixtureSlicingJob(inspectionJob)).toMatchObject({
      outcome: {
        status: "succeeded",
        canonicalGeometry: {
          modelGeometryId: ids.geometry,
          canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
          bodyIds: selectionBodyIds,
          selectionSha256: geometrySelectionSha256(selectionBodyIds),
          appliedUnitConversion: {
            sourceUnit: "millimeter",
            targetUnit: "millimeter",
            scaleFactorPpm: 1_000_000,
          },
        },
      },
    });
  });

  it("binds confirmed unit conversion to the canonical geometry bytes", () => {
    const millimeter = runFixtureSlicingJob(inspectionJob);
    const inchInput = {
      ...inspectionJob.input,
      operation: {
        ...inspectionJob.input.operation,
        confirmedUnitConversion: {
          sourceUnit: "inch" as const,
          targetUnit: "millimeter" as const,
          scaleFactorPpm: 25_400_000,
        },
      },
    };
    const inch = runFixtureSlicingJob(
      fixtureJob("model_inspection", inchInput),
    );

    expect(inch.inputFingerprintSha256).not.toBe(
      millimeter.inputFingerprintSha256,
    );
    expect(inch).toMatchObject({
      outcome: {
        canonicalGeometry: {
          appliedUnitConversion: inchInput.operation.confirmedUnitConversion,
        },
      },
    });
    if (
      millimeter.outcome.status !== "succeeded" ||
      inch.outcome.status !== "succeeded"
    ) {
      throw new TypeError("expected successful fixture canonicalization");
    }
    expect(inch.outcome.canonicalGeometry?.geometrySha256).not.toBe(
      millimeter.outcome.canonicalGeometry?.geometrySha256,
    );
  });

  it("exposes the fixture engine and normalized plate results", () => {
    expect(runFixtureSlicingJob(candidateJob)).toMatchObject({
      engine: {
        name: "fixture",
        version: "0.0.0",
        imageSha256: "f".repeat(64),
      },
      outcome: {
        status: "succeeded",
        metrics: {
          plateCount: 2,
          estimatedPrintSeconds: "180",
          estimatedMaterialMilligrams: "3000",
        },
        plates: [
          { plateOrdinal: 1, partsOnPlate: 2 },
          { plateOrdinal: 2, partsOnPlate: 1 },
        ],
        occupancySlices: [
          {
            cacheIdentitySha256: candidateCacheIdentitySha256,
            partsPerPlate: 2,
            estimatedPrintSeconds: "120",
            estimatedMaterialMilligrams: "2000",
            artifact: {
              objectKey: `slice-metrics/${candidateCacheIdentitySha256}/result.json`,
            },
          },
          {
            cacheIdentitySha256: candidateTailCacheIdentitySha256,
            partsPerPlate: 1,
            estimatedPrintSeconds: "60",
            estimatedMaterialMilligrams: "1000",
            artifact: {
              objectKey: `slice-metrics/${candidateTailCacheIdentitySha256}/result.json`,
            },
          },
        ],
      },
    });
  });

  it.each([
    { quantity: 1, occupancies: [1], plateCount: 1 },
    { quantity: 4, occupancies: [2], plateCount: 2 },
  ])(
    "emits only reusable occupancies for quantity $quantity",
    ({ quantity, occupancies, plateCount }) => {
      const base = {
        ...machineInput,
        quantity,
        shipmentPlanId: ids.shipment,
      };
      const input = {
        ...base,
        occupancySliceTargets: occupancies.map((partsPerPlate) =>
          occupancySliceTarget(base, partsPerPlate),
        ),
      };
      const result = runFixtureSlicingJob(
        fixtureJob("candidate_estimate", input),
      );

      expect(result).toMatchObject({
        outcome: {
          status: "succeeded",
          metrics: {
            plateCount,
            estimatedPrintSeconds: String(quantity * 60),
            estimatedMaterialMilligrams: String(quantity * 1_000),
          },
          occupancySlices: occupancies.map((partsPerPlate) => ({
            partsPerPlate,
          })),
        },
      });
    },
  );

  it("emits one persistence-compatible package for a multi-plate Job", () => {
    expect(runFixtureSlicingJob(productionJob)).toMatchObject({
      outcome: {
        status: "succeeded",
        metrics: {
          plateCount: 3,
          estimatedPrintSeconds: "300",
          estimatedMaterialMilligrams: "5000",
        },
        plates: [
          { plateOrdinal: 1, partsOnPlate: 2 },
          { plateOrdinal: 2, partsOnPlate: 2 },
          { plateOrdinal: 3, partsOnPlate: 1 },
        ],
        artifact: {
          format: "gcode_3mf",
          objectKey: `gcode/${ids.productionJob}/toolpaths.gcode.3mf`,
        },
      },
    });
  });

  it.each(["gcode_3mf", "bgcode", "gcode"] as const)(
    "emits the machine-profile %s production package",
    (format) => {
      const input = {
        ...productionInput,
        machineProfile: machineSlicerProfile(ids.machineProfile, "1", format),
      };
      const job = fixtureJob("production_slice", input, ids.productionJob);

      expect(runFixtureSlicingJob(job)).toMatchObject({
        outcome: {
          artifact: {
            format,
            objectKey: productionArtifactObjectKey(ids.productionJob, format),
          },
        },
      });
    },
  );

  it.each([
    ["reference_slice", referenceInput],
    ["candidate_estimate", candidateInput],
    [
      "production_slice",
      {
        ...machineInput,
        quantity: 2,
        acceptedJobId: ids.productionJob,
        productionReservationId: ids.reservation,
        arrangementRevision: revision(ids.arrangement, "3"),
      },
    ],
  ] as const)("derives %s bodyCount from selected geometry", (kind, input) => {
    const bodyIds = ["body-0001", "body-0002"];
    const jobId = kind === "production_slice" ? ids.productionJob : ids.job;
    const selectedInput = {
      ...input,
      geometry: {
        ...input.geometry,
        bodyIds,
        selectionSha256: geometrySelectionSha256(bodyIds),
      },
    };
    const occupancySliceTargets =
      kind === "candidate_estimate"
        ? [2, 1].map((partsPerPlate) =>
            occupancySliceTarget(
              selectedInput as Parameters<
                typeof machineOccupancyCacheIdentitySha256
              >[0],
              partsPerPlate,
            ),
          )
        : undefined;
    const job = fixtureJob(
      kind,
      {
        ...selectedInput,
        ...(occupancySliceTargets === undefined
          ? {}
          : {
              occupancySliceTargets,
            }),
      },
      jobId,
    );

    expect(runFixtureSlicingJob(job)).toMatchObject({
      outcome: { status: "succeeded", metrics: { bodyCount: 2 } },
    });
  });

  it.each([
    ["reference_slice", referenceInput],
    [
      "production_slice",
      {
        ...machineInput,
        quantity: 2,
        acceptedJobId: ids.productionJob,
        productionReservationId: ids.reservation,
        arrangementRevision: revision(ids.arrangement, "3"),
      },
    ],
  ] as const)(
    "binds %s artifact hashes to the selected body set",
    (kind, input) => {
      const jobId = kind === "production_slice" ? ids.productionJob : ids.job;
      const first = fixtureJob(kind, input, jobId);
      const secondInput = {
        ...input,
        geometry: {
          ...input.geometry,
          bodyIds: ["body-0002"],
          selectionSha256: geometrySelectionSha256(["body-0002"]),
        },
      };
      const second = fixtureJob(kind, secondInput, jobId);

      expect(artifactSha256(runFixtureSlicingJob(first))).not.toBe(
        artifactSha256(runFixtureSlicingJob(second)),
      );
    },
  );

  it("binds production identity and output to the accepted arrangement", () => {
    const changedInput = {
      ...productionInput,
      arrangementRevision: revision(ids.arrangement, "4"),
    };
    const changedJob = fixtureJob(
      "production_slice",
      changedInput,
      ids.productionJob,
    );
    const originalResult = runFixtureSlicingJob(productionJob);
    const changedResult = runFixtureSlicingJob(changedJob);

    expect(changedJob.inputFingerprintSha256).not.toBe(
      productionJob.inputFingerprintSha256,
    );
    expect(changedJob.idempotencyKey).not.toBe(productionJob.idempotencyKey);
    expect(artifactSha256(changedResult)).not.toBe(
      artifactSha256(originalResult),
    );
    expect(() =>
      slicingResultForJobSchema(SlicingJobSchema.parse(changedJob)).parse(
        originalResult,
      ),
    ).toThrow();
  });
});

describe("runLegacyV1FixtureSlicingJob", () => {
  const legacyJob = {
    contractVersion: 1 as const,
    jobId: ids.job,
    inputObjectKey: "fixture/input.stl",
    inputSha256: "a".repeat(64),
    profileVersion: "fixture-v1",
    profileSha256: "b".repeat(64),
  };

  it("keeps queued v1 jobs executable during the drain window", () => {
    expect(runLegacyV1FixtureSlicingJob(legacyJob)).toMatchObject({
      contractVersion: 1,
      jobId: ids.job,
      engine: { profileSha256: legacyJob.profileSha256 },
      output: { kind: "fixture" },
    });
  });

  it("does not accept v2 jobs on the v1 processor", () => {
    expect(() => runLegacyV1FixtureSlicingJob(referenceJob)).toThrow();
  });
});
