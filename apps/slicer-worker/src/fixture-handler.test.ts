import {
  SlicingJobSchema,
  geometrySelectionSha256,
  machineOccupancyCacheIdentitySha256,
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
  machineProfile: slicerProfile(ids.machineProfile, "1"),
  machineCalibration: revision(ids.calibration, "2"),
  printConfig: revision(ids.printConfig, "f"),
  partsPerPlate: 2,
};
const candidateCacheIdentitySha256 =
  machineOccupancyCacheIdentitySha256(machineInput);

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
const candidateJob = fixtureJob("candidate_estimate", {
  ...machineInput,
  quantity: 3,
  shipmentPlanId: ids.shipment,
  arrangementRevision: revision(ids.arrangement, "3"),
  backingSliceTarget: {
    cacheIdentitySha256: candidateCacheIdentitySha256,
    analysisObjectKey: `slice-metrics/${candidateCacheIdentitySha256}/result.json`,
  },
});
const productionInput = {
  ...machineInput,
  quantity: 5,
  acceptedJobId: ids.productionJob,
  productionReservationId: ids.reservation,
  arrangementRevision: revision(ids.arrangement, "3"),
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
        },
      },
    });
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
          estimatedPrintSeconds: "240",
          estimatedMaterialMilligrams: "4000",
        },
        plates: [
          { plateOrdinal: 1, partsOnPlate: 2 },
          { plateOrdinal: 2, partsOnPlate: 1 },
        ],
        backingSlice: {
          cacheIdentitySha256: candidateCacheIdentitySha256,
          partsPerPlate: 2,
          estimatedPrintSeconds: "120",
          estimatedMaterialMilligrams: "2000",
          artifact: {
            objectKey: `slice-metrics/${candidateCacheIdentitySha256}/result.json`,
          },
        },
      },
    });
  });

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

  it.each([
    ["reference_slice", referenceInput],
    [
      "candidate_estimate",
      {
        ...machineInput,
        quantity: 3,
        shipmentPlanId: ids.shipment,
        arrangementRevision: revision(ids.arrangement, "3"),
        backingSliceTarget: {
          cacheIdentitySha256: candidateCacheIdentitySha256,
          analysisObjectKey: `slice-metrics/${candidateCacheIdentitySha256}/result.json`,
        },
      },
    ],
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
    const job = fixtureJob(
      kind,
      {
        ...input,
        geometry: {
          ...input.geometry,
          bodyIds,
          selectionSha256: geometrySelectionSha256(bodyIds),
        },
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
