import { createHash } from "node:crypto";
import {
  SLICING_CONTRACT_VERSION,
  ReferenceSliceJobSchema,
  SlicingResultSchema,
  type SlicingResult,
} from "@taven/slicer-contracts";

export function runFixtureSlicingJob(input: unknown): SlicingResult {
  const job = ReferenceSliceJobSchema.parse(input);
  const deterministicInput = [
    job.input.geometry.geometrySha256,
    job.input.referenceProfile.contentSha256,
    job.input.printConfig.contentSha256,
    job.input.partsPerPlate,
  ].join(":");
  const artifactSha256 = createHash("sha256")
    .update(deterministicInput)
    .digest("hex");

  return SlicingResultSchema.parse({
    contractVersion: SLICING_CONTRACT_VERSION,
    kind: job.kind,
    jobId: job.jobId,
    correlationId: job.correlationId,
    inputFingerprintSha256: job.inputFingerprintSha256,
    idempotencyKey: job.idempotencyKey,
    attempt: job.attempt,
    input: job.input,
    engine: {
      name: "fixture",
      version: "0.0.0",
      imageSha256: "f".repeat(64),
    },
    outcome: {
      status: "succeeded",
      metrics: {
        boundingBox: {
          xMicrometers: "20000",
          yMicrometers: "20000",
          zMicrometers: "20000",
        },
        objectCount: 1,
        bodyCount: job.input.geometry.bodyIds.length,
        topology: {
          watertight: true,
          manifold: true,
          normals: "consistent",
        },
        thinWallFeatureCount: 0,
        supportVolumeRatioPpm: 0,
        hasPaintAssignments: false,
        materialAssignmentCount: 1,
        estimatedPrintSeconds: "60",
        estimatedMaterialMilligrams: "1000",
        plateCount: 1,
      },
      findings: [],
      artifact: {
        objectKey: `reference-slices/${job.jobId}/toolpath.gcode`,
        sha256: artifactSha256,
      },
    },
  });
}
