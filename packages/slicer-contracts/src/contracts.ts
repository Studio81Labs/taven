import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const SLICING_CONTRACT_VERSION = 1 as const;
export const SLICING_QUEUE_NAME = "taven:slicing:v1" as const;

export const SlicingJobSchema = z.object({
  contractVersion: z.literal(SLICING_CONTRACT_VERSION),
  jobId: z.uuid(),
  inputObjectKey: z.string().min(1),
  inputSha256: Sha256Schema,
  profileVersion: z.string().min(1),
  profileSha256: Sha256Schema,
});

export const SlicingResultSchema = z.object({
  contractVersion: z.literal(SLICING_CONTRACT_VERSION),
  jobId: z.uuid(),
  engine: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    profileSha256: Sha256Schema,
  }),
  output: z.object({
    kind: z.literal("fixture"),
    metadataSha256: Sha256Schema,
  }),
});

export type SlicingJob = z.infer<typeof SlicingJobSchema>;
export type SlicingResult = z.infer<typeof SlicingResultSchema>;
