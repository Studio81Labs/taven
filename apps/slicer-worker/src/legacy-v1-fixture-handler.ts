import { createHash } from "node:crypto";
import {
  LEGACY_V1_SLICING_CONTRACT_VERSION,
  LegacyV1SlicingJobSchema,
  LegacyV1SlicingResultSchema,
  type LegacyV1SlicingResult,
} from "@taven/slicer-contracts";

/**
 * Compatibility-only processor for jobs already present on the v1 queue.
 * New producers publish v2 jobs; remove this after the legacy queue drains.
 */
export function runLegacyV1FixtureSlicingJob(
  input: unknown,
): LegacyV1SlicingResult {
  const job = LegacyV1SlicingJobSchema.parse(input);
  const deterministicInput = [
    job.inputSha256,
    job.profileVersion,
    job.profileSha256,
  ].join(":");

  return LegacyV1SlicingResultSchema.parse({
    contractVersion: LEGACY_V1_SLICING_CONTRACT_VERSION,
    jobId: job.jobId,
    engine: {
      name: "fixture",
      version: "0.0.0",
      profileSha256: job.profileSha256,
    },
    output: {
      kind: "fixture",
      metadataSha256: createHash("sha256")
        .update(deterministicInput)
        .digest("hex"),
    },
  });
}
