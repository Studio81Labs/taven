import { createHash } from "node:crypto";
import {
  SlicingJobSchema,
  slicingResultForJobSchema,
  type SlicingJob,
  type SlicingResult,
} from "@taven/slicer-contracts";

const FIXTURE_ENGINE = {
  name: "fixture",
  version: "0.0.0",
  imageSha256: "f".repeat(64),
} as const;
const FIXTURE_BOUNDING_BOX = {
  xMicrometers: "20000",
  yMicrometers: "20000",
  zMicrometers: "20000",
} as const;
const FIXTURE_TOPOLOGY = {
  watertight: true,
  manifold: true,
  normals: "consistent",
} as const;

function fixtureHash(...values: readonly (string | number)[]): string {
  return createHash("sha256").update(values.join(":"), "utf8").digest("hex");
}

function plateParts(quantity: number, partsPerPlate: number): number[] {
  const parts: number[] = [];
  for (let remaining = quantity; remaining > 0; remaining -= partsPerPlate) {
    parts.push(Math.min(remaining, partsPerPlate));
  }
  return parts;
}

function resultEnvelope(job: SlicingJob) {
  return {
    contractVersion: job.contractVersion,
    kind: job.kind,
    jobId: job.jobId,
    correlationId: job.correlationId,
    inputFingerprintSha256: job.inputFingerprintSha256,
    idempotencyKey: job.idempotencyKey,
    attempt: job.attempt,
    input: job.input,
    engine: FIXTURE_ENGINE,
  } as const;
}

function sliceMetrics(quantity: number, plateCount: number, bodyCount: number) {
  return {
    boundingBox: FIXTURE_BOUNDING_BOX,
    objectCount: 1,
    bodyCount,
    topology: FIXTURE_TOPOLOGY,
    thinWallFeatureCount: 0,
    supportVolumeRatioPpm: 0,
    hasPaintAssignments: false,
    materialAssignmentCount: 1,
    estimatedPrintSeconds: String(quantity * 60),
    estimatedMaterialMilligrams: String(quantity * 1_000),
    plateCount,
  } as const;
}

/**
 * Deterministic fixture dispatch used until issue #27 installs real processors.
 * Keeping every v2 kind structurally executable prevents one shared queue from
 * rejecting otherwise conforming messages during repository and image tests.
 */
export function runFixtureSlicingJob(input: unknown): SlicingResult {
  const job = SlicingJobSchema.parse(input);
  const envelope = resultEnvelope(job);

  switch (job.kind) {
    case "model_inspection": {
      const bodyIds =
        job.input.operation.mode === "canonicalize_selection"
          ? job.input.operation.bodyIds
          : ["body-0001"];
      const geometrySha256 = fixtureHash(
        job.input.source.contentSha256,
        job.input.canonicalizerRevision,
        job.input.canonicalizerConfigSha256,
        job.input.operation.mode === "canonicalize_selection"
          ? job.input.operation.selectionSha256
          : "source-discovery",
      );
      return slicingResultForJobSchema(job).parse({
        ...envelope,
        outcome: {
          status: "succeeded",
          canonicalGeometry:
            job.input.operation.mode === "canonicalize_selection"
              ? {
                  ...job.input.operation.targetGeometry,
                  geometrySha256,
                  bodyIds,
                  selectionSha256: job.input.operation.selectionSha256,
                }
              : null,
          metrics: {
            boundingBox: FIXTURE_BOUNDING_BOX,
            objectCount: 1,
            bodyCount: bodyIds.length,
            unitHint: "millimeter",
            scaleAssessment: "trusted",
            suggestedScaleFactorPpm: null,
            thinWallFeatureCount: 0,
            hasPaintAssignments: false,
            materialAssignmentCount: 0,
            extruderAssignmentCount: 0,
          },
          bodies: bodyIds.map((bodyId) => ({
            bodyId,
            bodySha256: fixtureHash(
              geometrySha256,
              job.input.inspectionConfigSha256,
              bodyId,
            ),
            boundingBox: FIXTURE_BOUNDING_BOX,
            volumeCubicMicrometers: "8000000000000",
            triangleCount: 12,
            topology: FIXTURE_TOPOLOGY,
            hasPaintAssignments: false,
            materialAssignmentIds: [],
            extruderAssignmentIds: [],
          })),
          findings: [],
        },
      });
    }
    case "reference_slice": {
      const artifactSha256 = fixtureHash(
        job.input.geometry.geometrySha256,
        job.input.geometry.selectionSha256,
        job.input.referenceProfile.contentSha256,
        job.input.printConfig.contentSha256,
        job.input.partsPerPlate,
      );
      return slicingResultForJobSchema(job).parse({
        ...envelope,
        outcome: {
          status: "succeeded",
          metrics: sliceMetrics(
            job.input.partsPerPlate,
            1,
            job.input.geometry.bodyIds.length,
          ),
          findings: [],
          artifact: {
            objectKey: `reference-slices/${job.jobId}/toolpath.gcode`,
            sha256: artifactSha256,
          },
        },
      });
    }
    case "candidate_estimate": {
      const parts = plateParts(job.input.quantity, job.input.partsPerPlate);
      return slicingResultForJobSchema(job).parse({
        ...envelope,
        outcome: {
          status: "succeeded",
          metrics: sliceMetrics(
            job.input.quantity,
            parts.length,
            job.input.geometry.bodyIds.length,
          ),
          plates: parts.map((partsOnPlate, index) => ({
            plateOrdinal: index + 1,
            partsOnPlate,
            estimatedPrintSeconds: String(partsOnPlate * 60),
            estimatedMaterialMilligrams: String(partsOnPlate * 1_000),
          })),
        },
      });
    }
    case "production_slice": {
      return slicingResultForJobSchema(job).parse({
        ...envelope,
        outcome: {
          status: "succeeded",
          metrics: sliceMetrics(
            job.input.quantity,
            1,
            job.input.geometry.bodyIds.length,
          ),
          artifact: {
            format: "gcode_3mf",
            objectKey: `gcode/${job.input.acceptedJobId}/occupancy-${job.input.quantity}/toolpath.gcode.3mf`,
            sha256: fixtureHash(
              job.input.geometry.geometrySha256,
              job.input.geometry.selectionSha256,
              job.input.machineProfile.contentSha256,
              job.input.machineCalibration.contentSha256,
              job.input.printConfig.contentSha256,
              job.input.arrangementRevision.contentSha256,
              job.input.partsPerPlate,
            ),
          },
        },
      });
    }
  }
}
