import { describe, expect, it } from "vitest";
import {
  CandidateEstimateResultSchema,
  LEGACY_V1_SLICING_CONTRACT_VERSION,
  LEGACY_V1_SLICING_QUEUE_NAME,
  LegacyV1SlicingJobSchema,
  LegacyV1SlicingResultSchema,
  ModelInspectionJobSchema,
  ModelInspectionResultSchema,
  ProductionSliceResultSchema,
  ReferenceSliceJobSchema,
  SLICING_CONTRACT_VERSION,
  SLICING_MESSAGE_MAX_BYTES,
  SLICING_QUEUE_NAME,
  SlicingJobSchema,
  SlicingResultSchema,
  slicingInputFingerprint,
  slicingResultForJobSchema,
  type SlicingJobKind,
} from "./contracts.js";

const ids = {
  job: "11111111-1111-4111-8111-111111111111",
  correlation: "22222222-2222-4222-8222-222222222222",
  model: "33333333-3333-4333-8333-333333333333",
  geometryA: "44444444-4444-4444-8444-444444444444",
  geometryB: "55555555-5555-4555-8555-555555555555",
  machine: "66666666-6666-4666-8666-666666666666",
  profile: "77777777-7777-4777-8777-777777777777",
  calibration: "88888888-8888-4888-8888-888888888888",
  config: "99999999-9999-4999-8999-999999999999",
  shipment: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  arrangement: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  acceptedJob: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  reservation: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const hash = (character: string) => character.repeat(64);
const key = (kind: string, value: string) =>
  `slicer:v${SLICING_CONTRACT_VERSION}:${kind}:${value}`;
const source = {
  modelFileId: ids.model,
  format: "stl" as const,
  objectKey: `models/${ids.model}/source`,
  contentSha256: hash("a"),
};
const geometry = (
  modelGeometryId: string,
  bodyId: string,
  geometrySha256 = hash("b"),
) => ({
  sourceModelFileId: ids.model,
  sourceContentSha256: source.contentSha256,
  modelGeometryId,
  canonicalObjectKey: `geometries/${modelGeometryId}/canonical`,
  geometrySha256,
  bodyIds: [bodyId],
  selectionSha256: hash("c"),
});
const revision = (revisionId: string, contentSha256 = hash("d")) => ({
  revisionId,
  contentSha256,
});
const envelope = (
  kind: SlicingJobKind,
  input: unknown,
  overrides: Record<string, unknown> = {},
) => {
  const inputFingerprintSha256 = slicingInputFingerprint(kind, input);
  return {
    contractVersion: SLICING_CONTRACT_VERSION,
    jobId: ids.job,
    correlationId: ids.correlation,
    inputFingerprintSha256,
    idempotencyKey: key(kind, inputFingerprintSha256),
    attempt: 1,
    kind,
    input,
    ...overrides,
  };
};
const inspectionInput = {
  source,
  inspectionRevision: "inspection-v1",
  inspectionConfigSha256: hash("e"),
  canonicalizerRevision: "canonical-v1",
  canonicalizerConfigSha256: hash("1"),
};
const referenceInput = {
  geometry: geometry(ids.geometryA, "body-a"),
  referenceProfile: revision(ids.profile),
  printConfig: revision(ids.config),
  partsPerPlate: 1,
};
const machineInput = {
  geometry: geometry(ids.geometryA, "body-a"),
  machineId: ids.machine,
  machineProfile: revision(ids.profile),
  machineCalibration: revision(ids.calibration),
  printConfig: revision(ids.config),
  partsPerPlate: 2,
};
const candidateInput = {
  ...machineInput,
  quantity: 3,
  shipmentPlanId: ids.shipment,
  arrangementRevision: revision(ids.arrangement),
};
const productionInput = {
  ...machineInput,
  quantity: 2,
  acceptedJobId: ids.acceptedJob,
  productionReservationId: ids.reservation,
};
const legacyV1Job = {
  contractVersion: LEGACY_V1_SLICING_CONTRACT_VERSION,
  jobId: ids.job,
  inputObjectKey: "fixture/input.stl",
  inputSha256: hash("a"),
  profileVersion: "fixture-v1",
  profileSha256: hash("b"),
};
const engine = { name: "orca", version: "2.0", imageSha256: hash("2") };
const sliceMetrics = {
  boundingBox: {
    xMicrometers: "1",
    yMicrometers: "2",
    zMicrometers: "3",
  },
  objectCount: 1,
  bodyCount: 1,
  topology: {
    watertight: true,
    manifold: true,
    normals: "consistent" as const,
  },
  thinWallFeatureCount: 0,
  supportVolumeRatioPpm: 0,
  hasPaintAssignments: false,
  materialAssignmentCount: 0,
  estimatedPrintSeconds: "10",
  estimatedMaterialMilligrams: "20",
};
const inspectionOutcome = {
  status: "succeeded" as const,
  metrics: {
    boundingBox: sliceMetrics.boundingBox,
    objectCount: 1,
    bodyCount: 1,
    unitHint: "millimeter" as const,
    scaleAssessment: "trusted" as const,
    suggestedScaleFactorPpm: null,
    thinWallFeatureCount: 0,
    hasPaintAssignments: false,
    materialAssignmentCount: 0,
    extruderAssignmentCount: 0,
  },
  bodies: [
    {
      bodyId: "body-a",
      bodySha256: hash("3"),
      boundingBox: sliceMetrics.boundingBox,
      volumeCubicMicrometers: "4",
      triangleCount: 1,
      topology: sliceMetrics.topology,
      hasPaintAssignments: false,
      materialAssignmentIds: [],
      extruderAssignmentIds: [],
    },
  ],
  findings: [],
};
const inspectionJob = envelope("model_inspection", inspectionInput);
const referenceJob = envelope("reference_slice", referenceInput);
const candidateJob = envelope("candidate_estimate", candidateInput);
const productionJob = envelope("production_slice", productionInput, {
  jobId: ids.acceptedJob,
});

function result(
  job: Record<string, unknown>,
  outcome: Record<string, unknown>,
): Record<string, unknown> {
  return { ...job, engine, outcome };
}

describe("versioned slicing jobs", () => {
  it("keeps the legacy v1 contract isolated for queue draining", () => {
    expect(LEGACY_V1_SLICING_QUEUE_NAME).toBe("taven:slicing:v1");
    expect(SLICING_QUEUE_NAME).toBe("taven:slicing:v2");
    expect(LEGACY_V1_SLICING_QUEUE_NAME).not.toBe(SLICING_QUEUE_NAME);
    expect(LegacyV1SlicingJobSchema.parse(legacyV1Job)).toEqual(legacyV1Job);
    expect(() => SlicingJobSchema.parse(legacyV1Job)).toThrow();

    const legacyResult = {
      contractVersion: LEGACY_V1_SLICING_CONTRACT_VERSION,
      jobId: ids.job,
      engine: {
        name: "fixture",
        version: "0.0.0",
        profileSha256: legacyV1Job.profileSha256,
      },
      output: { kind: "fixture", metadataSha256: hash("c") },
    };
    expect(LegacyV1SlicingResultSchema.parse(legacyResult)).toEqual(
      legacyResult,
    );
    expect(() => SlicingResultSchema.parse(legacyResult)).toThrow();
  });

  it("accepts all four discriminated job kinds", () => {
    for (const job of [
      inspectionJob,
      referenceJob,
      candidateJob,
      productionJob,
    ]) {
      expect(SlicingJobSchema.parse(job)).toEqual(job);
    }
  });

  it("rejects unknown versions and unknown fields at every level", () => {
    expect(() =>
      SlicingJobSchema.parse({ ...inspectionJob, contractVersion: 999 }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({ ...inspectionJob, unexpected: true }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({
        ...inspectionJob,
        input: { ...inspectionInput, unexpected: true },
      }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({
        ...referenceJob,
        input: {
          ...referenceInput,
          geometry: { ...referenceInput.geometry, unexpected: true },
        },
      }),
    ).toThrow();
  });

  it("keeps reference and machine-bound kinds distinct", () => {
    expect(() =>
      ReferenceSliceJobSchema.parse({
        ...referenceJob,
        input: { ...referenceInput, machineId: ids.machine },
      }),
    ).toThrow();
    expect(() =>
      ModelInspectionJobSchema.parse({
        ...inspectionJob,
        input: { ...inspectionInput, machineId: ids.machine },
      }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({
        ...candidateJob,
        input: { ...candidateInput, machineProfile: undefined },
      }),
    ).toThrow();
  });

  it("rejects unsafe keys, identifiers, hashes, and numeric bounds", () => {
    expect(() =>
      SlicingJobSchema.parse({
        ...inspectionJob,
        input: {
          ...inspectionInput,
          source: { ...source, objectKey: "/etc/passwd" },
        },
      }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({
        ...inspectionJob,
        input: {
          ...inspectionInput,
          source: { ...source, objectKey: `models/${ids.model}/../source` },
        },
      }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({
        ...referenceJob,
        input: { ...referenceInput, partsPerPlate: 0 },
      }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({
        ...candidateJob,
        input: { ...candidateInput, quantity: 100_001 },
      }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse(
        envelope("candidate_estimate", {
          ...candidateInput,
          partsPerPlate: 1,
          quantity: 129,
        }),
      ),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({
        ...referenceJob,
        input: {
          ...referenceInput,
          geometry: {
            ...referenceInput.geometry,
            geometrySha256: "A".repeat(64),
          },
        },
      }),
    ).toThrow();
    expect(() =>
      SlicingJobSchema.parse({
        ...inspectionJob,
        input: {
          ...inspectionInput,
          source: {
            ...source,
            objectKey: `models/${ids.model}/source?token=secret`,
          },
        },
      }),
    ).toThrow();
  });
});

describe("versioned slicing results", () => {
  it("accepts success results for inspection, reference, candidate, and production", () => {
    const inspection = result(inspectionJob, inspectionOutcome);
    const reference = result(referenceJob, {
      status: "succeeded",
      metrics: { ...sliceMetrics, plateCount: 1 },
      findings: [],
      artifact: {
        objectKey: `reference-slices/${ids.job}/toolpath.gcode`,
        sha256: hash("4"),
      },
    });
    const candidate = result(candidateJob, {
      status: "succeeded",
      metrics: {
        ...sliceMetrics,
        estimatedPrintSeconds: "20",
        estimatedMaterialMilligrams: "40",
        plateCount: 2,
      },
      plates: [
        {
          plateOrdinal: 1,
          partsOnPlate: 2,
          estimatedPrintSeconds: "10",
          estimatedMaterialMilligrams: "20",
        },
        {
          plateOrdinal: 2,
          partsOnPlate: 1,
          estimatedPrintSeconds: "10",
          estimatedMaterialMilligrams: "20",
        },
      ],
    });
    const production = result(productionJob, {
      status: "succeeded",
      metrics: { ...sliceMetrics, plateCount: 1 },
      artifact: {
        format: "gcode_3mf",
        objectKey: `gcode/${ids.acceptedJob}/occupancy-2/toolpath.gcode.3mf`,
        sha256: hash("5"),
      },
    });
    for (const value of [inspection, reference, candidate, production])
      expect(SlicingResultSchema.parse(value)).toEqual(value);
    for (const value of [reference, candidate, production]) {
      const outcome = value.outcome as Record<string, unknown>;
      const metrics = outcome.metrics as Record<string, unknown>;
      expect(() =>
        SlicingResultSchema.parse({
          ...value,
          outcome: {
            ...outcome,
            metrics: { ...metrics, bodyCount: 2 },
          },
        }),
      ).toThrow();
    }
    expect(() =>
      ProductionSliceResultSchema.parse({
        ...production,
        outcome: {
          ...(production.outcome as object),
          metrics: {
            ...sliceMetrics,
            plateCount: 2,
          },
        },
      }),
    ).toThrow();
  });

  it("distinguishes deterministic and retryable failures", () => {
    const deterministic = result(inspectionJob, {
      status: "failed",
      failureClass: "deterministic_invalid",
      code: "INVALID_MODEL",
      retryable: false,
      message: "mesh is invalid",
      retryAfterMilliseconds: null,
    });
    const retryable = result(referenceJob, {
      status: "failed",
      failureClass: "retryable_infrastructure",
      code: "ENGINE_TIMEOUT",
      retryable: true,
      message: "engine timed out",
      retryAfterMilliseconds: 1000,
    });
    expect(SlicingResultSchema.parse(deterministic)).toEqual(deterministic);
    expect(SlicingResultSchema.parse(retryable)).toEqual(retryable);
    expect(() =>
      SlicingResultSchema.parse({
        ...deterministic,
        outcome: { ...(deterministic.outcome as object), retryable: true },
      }),
    ).toThrow();
    expect(() =>
      SlicingResultSchema.parse({
        ...retryable,
        outcome: {
          ...(retryable.outcome as object),
          message: "https://secret.example/token",
        },
      }),
    ).toThrow();
    for (const message of [
      "failed reading models/input.stl",
      "failed reading ../input.stl",
      "failed reading foo\\input.stl",
      "failed reading \\\\server\\share\\input.stl",
      "failed reading //server/share/input.stl",
    ]) {
      expect(() =>
        SlicingResultSchema.parse({
          ...retryable,
          outcome: { ...(retryable.outcome as object), message },
        }),
      ).toThrow();
    }
    expect(
      SlicingResultSchema.parse({
        ...retryable,
        outcome: {
          ...(retryable.outcome as object),
          message: "engine input could not be read",
        },
      }),
    ).toBeDefined();
    expect(() =>
      SlicingResultSchema.parse({
        ...retryable,
        engine: { ...engine, version: " 2.0 " },
      }),
    ).toThrow();
    expect(() =>
      SlicingResultSchema.parse({
        ...retryable,
        outcome: {
          ...(retryable.outcome as object),
          message: " engine timed out ",
        },
      }),
    ).toThrow();
  });

  it("reconciles candidate quantity and keeps production to one plate", () => {
    const valid = result(candidateJob, {
      status: "succeeded",
      metrics: {
        ...sliceMetrics,
        estimatedPrintSeconds: "20",
        estimatedMaterialMilligrams: "40",
        plateCount: 2,
      },
      plates: [
        {
          plateOrdinal: 1,
          partsOnPlate: 2,
          estimatedPrintSeconds: "10",
          estimatedMaterialMilligrams: "20",
        },
        {
          plateOrdinal: 2,
          partsOnPlate: 1,
          estimatedPrintSeconds: "10",
          estimatedMaterialMilligrams: "20",
        },
      ],
    });
    expect(CandidateEstimateResultSchema.parse(valid)).toEqual(valid);
    expect(() =>
      CandidateEstimateResultSchema.parse({
        ...valid,
        outcome: {
          ...(valid.outcome as object),
          metrics: { ...sliceMetrics, plateCount: 2 },
        },
      }),
    ).toThrow();
    expect(() =>
      CandidateEstimateResultSchema.parse({
        ...valid,
        outcome: {
          ...(valid.outcome as object),
          plates: [
            {
              plateOrdinal: 1,
              partsOnPlate: 4,
              estimatedPrintSeconds: "10",
              estimatedMaterialMilligrams: "20",
            },
            {
              plateOrdinal: 2,
              partsOnPlate: 1,
              estimatedPrintSeconds: "10",
              estimatedMaterialMilligrams: "20",
            },
          ],
        },
      }),
    ).toThrow();
    const production = result(productionJob, {
      status: "succeeded",
      metrics: { ...sliceMetrics, plateCount: 1 },
      outputs: [
        {
          plateOrdinal: 1,
          partsOnPlate: 1,
          estimatedPrintSeconds: "10",
          estimatedMaterialMilligrams: "20",
          format: "gcode",
          objectKey: `gcode/${ids.acceptedJob}/occupancy-2/toolpath.gcode`,
          sha256: hash("5"),
        },
      ],
    });
    expect(() => ProductionSliceResultSchema.parse(production)).toThrow();
    expect(() =>
      SlicingJobSchema.parse(
        envelope(
          "production_slice",
          { ...productionInput, quantity: 3 },
          { jobId: ids.acceptedJob },
        ),
      ),
    ).toThrow();
  });

  it("binds production authorization and artifact keys to their dispatch", () => {
    expect(() =>
      SlicingJobSchema.parse({
        ...productionJob,
        jobId: ids.job,
      }),
    ).toThrow();

    const reference = result(referenceJob, {
      status: "succeeded",
      metrics: { ...sliceMetrics, plateCount: 1 },
      findings: [],
      artifact: {
        objectKey: `reference-slices/${ids.geometryB}/toolpath.gcode`,
        sha256: hash("4"),
      },
    });
    expect(() => SlicingResultSchema.parse(reference)).toThrow();

    const production = result(productionJob, {
      status: "succeeded",
      metrics: { ...sliceMetrics, plateCount: 1 },
      artifact: {
        format: "gcode",
        objectKey: `gcode/${ids.job}/occupancy-2/toolpath.gcode`,
        sha256: hash("5"),
      },
    });
    expect(() => SlicingResultSchema.parse(production)).toThrow();
  });

  it("gives full and partial plate Jobs distinct occupancy-bound artifacts", () => {
    const fullObjectKey =
      `gcode/${ids.acceptedJob}/occupancy-2/toolpath.gcode` as const;
    const full = result(productionJob, {
      status: "succeeded",
      metrics: { ...sliceMetrics, plateCount: 1 },
      artifact: {
        format: "gcode",
        objectKey: fullObjectKey,
        sha256: hash("5"),
      },
    });
    const partialInput = {
      ...machineInput,
      partsPerPlate: 1,
      quantity: 1,
      acceptedJobId: ids.geometryB,
      productionReservationId: ids.reservation,
    };
    const partialJob = envelope("production_slice", partialInput, {
      jobId: ids.geometryB,
    });
    const partialObjectKey =
      `gcode/${ids.geometryB}/occupancy-1/toolpath.gcode` as const;
    const partial = result(partialJob, {
      status: "succeeded",
      metrics: { ...sliceMetrics, plateCount: 1 },
      artifact: {
        format: "gcode",
        objectKey: partialObjectKey,
        sha256: hash("6"),
      },
    });

    expect(ProductionSliceResultSchema.parse(full)).toEqual(full);
    expect(ProductionSliceResultSchema.parse(partial)).toEqual(partial);
    expect(fullObjectKey).not.toBe(partialObjectKey);
  });

  it("binds results to the exact job and prevents geometry collisions", () => {
    const jobA = { ...referenceJob, input: referenceInput };
    const inputB = {
      ...referenceInput,
      geometry: geometry(ids.geometryB, "body-b", hash("7")),
    };
    const jobB = envelope("reference_slice", inputB, {
      jobId: ids.geometryB,
      correlationId: ids.geometryB,
    });
    expect(JSON.stringify(jobA.input)).not.toBe(JSON.stringify(jobB.input));
    expect(jobA.correlationId).not.toBe(jobB.correlationId);
    expect(jobA.inputFingerprintSha256).not.toBe(jobB.inputFingerprintSha256);
    expect(jobA.idempotencyKey).not.toBe(jobB.idempotencyKey);
    expect(() =>
      SlicingJobSchema.parse({
        ...jobB,
        inputFingerprintSha256: jobA.inputFingerprintSha256,
        idempotencyKey: jobA.idempotencyKey,
      }),
    ).toThrow();
    const success = result(jobA, {
      status: "succeeded",
      metrics: { ...sliceMetrics, plateCount: 1 },
      findings: [],
      artifact: {
        objectKey: `reference-slices/${ids.job}/toolpath.gcode`,
        sha256: hash("4"),
      },
    });
    expect(slicingResultForJobSchema(jobA).parse(success)).toEqual(success);
    expect(() => slicingResultForJobSchema(jobB).parse(success)).toThrow();

    const reorderedInput = {
      partsPerPlate: referenceInput.partsPerPlate,
      printConfig: referenceInput.printConfig,
      referenceProfile: referenceInput.referenceProfile,
      geometry: referenceInput.geometry,
    };
    const reorderedJob = envelope("reference_slice", reorderedInput);
    expect(slicingResultForJobSchema(reorderedJob).parse(success)).toEqual(
      success,
    );
  });

  it("rejects payloads over the wire-size bound", () => {
    const finding = {
      code: "TOO_LARGE",
      severity: "info" as const,
      phase: "inspection" as const,
      message: "x".repeat(512),
      acknowledgementKey: null,
    };
    const oversized = result(inspectionJob, {
      ...inspectionOutcome,
      findings: Array.from({ length: 256 }, () => finding),
    });
    expect(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
    ).toBeGreaterThan(SLICING_MESSAGE_MAX_BYTES);
    expect(() => SlicingResultSchema.parse(oversized)).toThrow();
    expect(() => ModelInspectionResultSchema.parse(oversized)).toThrow();
  });
});
