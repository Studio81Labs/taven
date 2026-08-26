import { createHash } from "node:crypto";
import {
  SLICING_CONTRACT_VERSION,
  SlicingJobSchema,
  SlicingResultSchema,
  type SlicingResult,
} from "@taven/slicer-contracts";

export function runFixtureSlicingJob(input: unknown): SlicingResult {
  const job = SlicingJobSchema.parse(input);
  const deterministicInput = [
    job.inputSha256,
    job.profileVersion,
    job.profileSha256,
  ].join(":");

  return SlicingResultSchema.parse({
    contractVersion: SLICING_CONTRACT_VERSION,
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
