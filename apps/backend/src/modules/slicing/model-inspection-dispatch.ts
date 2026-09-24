import { ModelFileFormat, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

type Transaction = Prisma.TransactionClient;

export const INSPECTION_REVISION = "inspection-v1";
export const INSPECTION_CONFIG_SHA256 = createHash("sha256")
  .update("taven-inspection-v1")
  .digest("hex");
const CANONICALIZER_REVISION = "canonical-v1";
const CANONICALIZER_CONFIG_SHA256 = createHash("sha256")
  .update("taven-canonicalizer-v1")
  .digest("hex");

type InspectionSource = Readonly<{
  id: string;
  format: ModelFileFormat;
  storageObjectKey: string;
  contentHash: string;
}>;

export function modelInspectionInput(
  source: InspectionSource,
  operation: Record<string, unknown>,
) {
  return {
    source: {
      modelFileId: source.id,
      format: source.format === ModelFileFormat.STL ? "stl" : "3mf",
      objectKey: source.storageObjectKey,
      contentSha256: source.contentHash,
    },
    operation,
    inspectionRevision: INSPECTION_REVISION,
    inspectionConfigSha256: INSPECTION_CONFIG_SHA256,
    canonicalizerRevision: CANONICALIZER_REVISION,
    canonicalizerConfigSha256: CANONICALIZER_CONFIG_SHA256,
  };
}

export async function enqueueModelInspection(
  transaction: Transaction,
  input: Readonly<{
    jobId: string;
    correlationId: string;
    source: InspectionSource;
    attempt?: number;
    availableAt?: Date;
    operation: Record<string, unknown>;
  }>,
): Promise<void> {
  const {
    ModelInspectionJobSchema,
    slicingDispatchAttemptKey,
    slicingInputFingerprint,
  } = await import("@taven/slicer-contracts");
  const jobInput = modelInspectionInput(input.source, input.operation);
  const inputFingerprintSha256 = slicingInputFingerprint(
    "model_inspection",
    jobInput,
  );
  const attempt = input.attempt ?? 1;
  const job = ModelInspectionJobSchema.parse({
    contractVersion: 2,
    kind: "model_inspection",
    jobId: input.jobId,
    correlationId: input.correlationId,
    inputFingerprintSha256,
    idempotencyKey: `slicer:v2:model_inspection:${input.jobId}:${inputFingerprintSha256}`,
    attempt,
    input: jobInput,
  });
  const deduplicationKey = slicingDispatchAttemptKey(
    job.idempotencyKey,
    attempt,
  );
  await transaction.outboxMessage.upsert({
    where: { deduplicationKey },
    create: {
      deduplicationKey,
      aggregateType: "ModelInspectionDispatch",
      aggregateId: job.jobId,
      messageType: "slicing.model-inspection.requested",
      schemaVersion: 2,
      payload: { job } as unknown as Prisma.InputJsonObject,
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    },
    update: {},
  });
}
