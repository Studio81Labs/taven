import { createHash } from "node:crypto";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { Job, Queue } from "bullmq";
import type { SlicingJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { PrismaService } from "../../prisma/prisma.service";
import { CandidateEstimateService } from "../resources/candidate-estimate.service";
import {
  ResourceConflictError,
  ResourceNotFoundError,
  ResourceValidationError,
} from "../resources/resource-errors";
import {
  PermanentSlicingResultIngestionError,
  SlicingResultIngestionService,
} from "./slicing-result-ingestion.service";
import { SLICING_QUEUE } from "./slicing.tokens";
import { SlicerProfileSnapshotService } from "./slicer-profile-snapshot.service";

const CLAIM_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const MAX_LAST_ERROR_LENGTH = 1_000;

type ClaimedDispatch = {
  id: string;
  attempts: number;
  payload: Prisma.JsonValue;
};

type QuarantinedQueueJob = Pick<
  Job,
  | "id"
  | "name"
  | "data"
  | "returnvalue"
  | "progress"
  | "opts"
  | "attemptsMade"
  | "failedReason"
>;

function queueJobId(job: SlicingJob): string {
  return `dispatch-${createHash("sha256")
    .update(`${job.idempotencyKey}:${job.attempt}`)
    .digest("hex")}`;
}

function safeLastError(error: unknown): string {
  const value =
    error instanceof Error ? error.message : "unknown dispatch error";
  return value
    .replace(/(?:redis|rediss|https?):\/\/\S+/giu, "service endpoint")
    .replace(
      /\b(?:authorization|bearer|password|secret|token)\b/giu,
      "credential",
    )
    .slice(0, MAX_LAST_ERROR_LENGTH);
}

function isPermanentIngestionError(error: unknown): boolean {
  return (
    error instanceof PermanentSlicingResultIngestionError ||
    error instanceof ResourceConflictError ||
    error instanceof ResourceNotFoundError ||
    error instanceof ResourceValidationError
  );
}

class InvalidSlicingQueueEntryError extends Error {}

function jsonEvidence(value: unknown): Prisma.InputJsonValue | null {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? null
    : (JSON.parse(serialized) as Prisma.InputJsonValue);
}

function queueEvidence(queued: QuarantinedQueueJob) {
  return {
    jobData: jsonEvidence(queued.data),
    terminalReturnValue: jsonEvidence(queued.returnvalue),
    progress: jsonEvidence(queued.progress),
    failedReason: queued.failedReason ?? null,
    attemptsMade: queued.attemptsMade,
    configuredAttempts: queued.opts.attempts ?? null,
  };
}

function queueEvidenceFingerprint(
  queued: QuarantinedQueueJob,
  evidence: ReturnType<typeof queueEvidence>,
): string {
  return createHash("sha256")
    .update(String(queued.id ?? "missing"))
    .update("\0")
    .update(queued.name)
    .update("\0")
    .update(JSON.stringify(evidence))
    .digest("hex");
}

@Injectable()
export class SlicingQueuePublisher implements OnModuleDestroy {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SLICING_QUEUE) private readonly queue: Queue,
    @Inject(CandidateEstimateService)
    private readonly candidateEstimates: CandidateEstimateService,
    @Inject(SlicingResultIngestionService)
    private readonly results: SlicingResultIngestionService,
    @Inject(SlicerProfileSnapshotService)
    private readonly snapshots: SlicerProfileSnapshotService,
  ) {}

  async publishPending(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("slicing dispatch limit must be 1 through 100");
    }
    const claimed = await this.claim(limit);
    let delivered = 0;
    for (const dispatch of claimed) {
      try {
        const payload = dispatch.payload as Record<string, unknown>;
        const { SlicingJobSchema } = await import("@taven/slicer-contracts");
        const job = SlicingJobSchema.parse(payload.job);
        if (job.kind === "production_slice") {
          await this.assertProductionSliceAuthorized(job);
        }
        await this.snapshots.ensureJobSnapshots(job);
        await this.queue.add(job.kind, job, {
          jobId: queueJobId(job),
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: false,
          removeOnFail: false,
        });
        const updated = await this.prisma.outboxMessage.updateMany({
          where: {
            id: dispatch.id,
            status: "PROCESSING",
            attempts: dispatch.attempts,
          },
          data: {
            status: "DELIVERED",
            deliveredAt: new Date(),
            lockedAt: null,
            lastError: null,
          },
        });
        if (updated.count !== 1) {
          throw new Error("slicing dispatch claim was lost after enqueue");
        }
        delivered += 1;
      } catch (error) {
        await this.fail(dispatch, error);
      }
    }
    return delivered;
  }

  async reconcileCompleted(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("slicing result limit must be 1 through 100");
    }
    const queuedJobs = await this.queue.getJobs(
      ["completed", "failed"],
      0,
      limit - 1,
      true,
    );
    let reconciled = 0;
    for (const queued of queuedJobs) {
      const {
        SlicingJobSchema,
        slicingResultFingerprint,
        slicingResultForJobSchema,
      } = await import("@taven/slicer-contracts");
      const parsedJob = SlicingJobSchema.safeParse(queued.data);
      if (!parsedJob.success) {
        await this.deadLetterQueueEntry(
          queued,
          new InvalidSlicingQueueEntryError(
            "queue job payload violates the slicing contract",
          ),
        );
        await queued.remove();
        reconciled += 1;
        continue;
      }
      const job = parsedJob.data;
      let dispatchId: string;
      try {
        dispatchId = await this.assertDurableDispatch(job);
      } catch (error) {
        if (!(error instanceof InvalidSlicingQueueEntryError)) throw error;
        await this.deadLetterQueueEntry(queued, error);
        await queued.remove();
        reconciled += 1;
        continue;
      }
      let result;
      try {
        result = slicingResultForJobSchema(job).parse(
          queued.returnvalue ?? this.exhaustedRetryableResult(queued),
        );
      } catch (error) {
        await this.deadLetter(queued, dispatchId, job, error);
        await queued.remove();
        reconciled += 1;
        continue;
      }
      const resultFingerprintSha256 = slicingResultFingerprint(result);
      try {
        if (result.kind === "candidate_estimate") {
          await this.candidateEstimates.ingest({ result });
        }
        await this.results.ingest({
          dispatchId,
          job,
          result,
          resultFingerprintSha256,
        });
      } catch (error) {
        if (!isPermanentIngestionError(error)) throw error;
        await this.deadLetter(queued, dispatchId, job, error);
        await queued.remove();
        reconciled += 1;
        continue;
      }
      await queued.remove();
      reconciled += 1;
    }
    return reconciled;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  private async claim(limit: number): Promise<ClaimedDispatch[]> {
    const staleBefore = new Date(Date.now() - CLAIM_LEASE_MILLISECONDS);
    return this.prisma.$transaction(
      async (transaction) =>
        transaction.$queryRaw<ClaimedDispatch[]>`
        WITH due AS (
          SELECT id
          FROM outbox_messages
          WHERE message_type LIKE 'slicing.%.requested'
            AND (
              (
                status IN ('PENDING', 'FAILED')
                AND available_at <= clock_timestamp()
              )
              OR (
                status = 'PROCESSING'
                AND locked_at < ${staleBefore}
              )
            )
          ORDER BY available_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE outbox_messages message
        SET status = 'PROCESSING',
            attempts = message.attempts + 1,
            locked_at = clock_timestamp(),
            last_error = NULL,
            updated_at = clock_timestamp()
        FROM due
        WHERE message.id = due.id
        RETURNING message.id, message.attempts, message.payload
      `,
    );
  }

  private async fail(dispatch: ClaimedDispatch, error: unknown): Promise<void> {
    const delay = Math.min(
      60 * 60 * 1_000,
      5_000 * 2 ** Math.min(dispatch.attempts - 1, 8),
    );
    await this.prisma.outboxMessage.updateMany({
      where: {
        id: dispatch.id,
        status: "PROCESSING",
        attempts: dispatch.attempts,
      },
      data: {
        status: "FAILED",
        availableAt: new Date(Date.now() + delay),
        lockedAt: null,
        lastError: safeLastError(error),
      },
    });
  }

  private async assertProductionSliceAuthorized(
    job: Extract<SlicingJob, { kind: "production_slice" }>,
  ): Promise<void> {
    const input = job.input;
    const accepted = await this.prisma.job.findFirst({
      where: {
        id: input.acceptedJobId,
        status: "ACCEPTED",
        acceptedAt: { not: null },
        productionReservations: {
          some: {
            id: input.productionReservationId,
            jobId: input.acceptedJobId,
            status: "HELD",
            machineId: input.machineId,
            printConfigRevisionId: input.printConfig.revisionId,
            machineProfileId: input.machineProfile.revisionId,
            machineCalibrationId: input.machineCalibration.revisionId,
            occupancySliceResult: {
              modelGeometryId: input.geometry.modelGeometryId,
              printConfigRevisionId: input.printConfig.revisionId,
              machineProfileId: input.machineProfile.revisionId,
              machineCalibrationId: input.machineCalibration.revisionId,
              arrangementRevisionId: input.arrangementRevision.revisionId,
              partsPerPlate: input.partsPerPlate,
              modelGeometry: {
                sourceModelFileId: input.geometry.sourceModelFileId,
                canonicalObjectKey: input.geometry.canonicalObjectKey,
                geometryHash: input.geometry.geometrySha256,
                sourceModelFile: {
                  contentHash: input.geometry.sourceContentSha256,
                },
              },
            },
            phaseResourcePlanJob: {
              candidateResourceEstimate: {
                quantity: input.quantity,
                partsPerPlate: input.partsPerPlate,
                arrangementRevisionId: input.arrangementRevision.revisionId,
                arrangementRevision: {
                  contentSha256: input.arrangementRevision.contentSha256,
                },
              },
            },
            printConfigRevision: { id: input.printConfig.revisionId },
            machineProfile: {
              slicerEngine: input.machineProfile.slicerEngine,
              slicerVersion: input.machineProfile.slicerVersion,
            },
            machineCalibration: { id: input.machineCalibration.revisionId },
          },
        },
      },
      select: { id: true },
    });
    if (!accepted) {
      throw new Error(
        "production slicing requires an accepted job and its exact held reservation inputs",
      );
    }
  }

  private exhaustedRetryableResult(queued: {
    attemptsMade: number;
    opts: { attempts?: number };
    progress: unknown;
  }): unknown {
    const attempts = queued.opts.attempts ?? 1;
    if (queued.attemptsMade < attempts) {
      throw new Error("retryable slicing job has not exhausted its attempts");
    }
    const progress = queued.progress as {
      type?: unknown;
      queueAttempt?: unknown;
      result?: unknown;
    };
    if (
      progress?.type !== "retryable-slicing-result" ||
      progress.queueAttempt !== queued.attemptsMade
    ) {
      throw new Error(
        "failed slicing job has no current validated retryable result envelope",
      );
    }
    return progress.result;
  }

  private async deadLetter(
    queued: QuarantinedQueueJob,
    dispatchId: string,
    job: SlicingJob,
    error: unknown,
  ): Promise<void> {
    const evidence = queueEvidence(queued);
    const terminalEvidenceFingerprintSha256 = queueEvidenceFingerprint(
      queued,
      evidence,
    );
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${dispatchId}, 0))::text
      `;
      const messageType = `slicing.${job.kind}.dead-lettered`;
      const existing = await transaction.outboxMessage.findFirst({
        where: {
          aggregateType: "SlicingDispatchDeadLetter",
          aggregateId: dispatchId,
          messageType,
        },
        select: { id: true },
      });
      if (existing) return;
      await transaction.outboxMessage.create({
        data: {
          deduplicationKey: `slicer-dead-letter:v1:${dispatchId}`,
          aggregateType: "SlicingDispatchDeadLetter",
          aggregateId: dispatchId,
          messageType,
          schemaVersion: job.contractVersion,
          payload: {
            dispatchId,
            jobId: job.jobId,
            queueJobId: queued.id ?? null,
            attemptsMade: queued.attemptsMade,
            configuredAttempts: queued.opts.attempts ?? null,
            terminalEvidenceFingerprintSha256,
            failure: safeLastError(error),
            workerFailure: safeLastError(
              queued.failedReason
                ? new Error(queued.failedReason)
                : new Error("queue job returned no validated terminal result"),
            ),
            jobData: evidence.jobData,
            terminalReturnValue: evidence.terminalReturnValue,
            progress: evidence.progress,
          },
        },
      });
    });
  }

  private async deadLetterQueueEntry(
    queued: QuarantinedQueueJob,
    error: unknown,
  ): Promise<void> {
    const evidence = queueEvidence(queued);
    const fingerprintSha256 = queueEvidenceFingerprint(queued, evidence);
    const uuidHex = [...fingerprintSha256.slice(0, 32)];
    uuidHex[12] = "5";
    uuidHex[16] = ((Number.parseInt(uuidHex[16]!, 16) & 0x3) | 0x8).toString(
      16,
    );
    const aggregateId = [
      uuidHex.slice(0, 8).join(""),
      uuidHex.slice(8, 12).join(""),
      uuidHex.slice(12, 16).join(""),
      uuidHex.slice(16, 20).join(""),
      uuidHex.slice(20, 32).join(""),
    ].join("-");

    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${aggregateId}, 0))::text
      `;
      const messageType = "slicing.queue-entry.dead-lettered";
      const existing = await transaction.outboxMessage.findFirst({
        where: {
          aggregateType: "SlicingQueueDeadLetter",
          aggregateId,
          messageType,
        },
        select: { id: true },
      });
      if (existing) return;
      await transaction.outboxMessage.create({
        data: {
          deduplicationKey: `slicer-queue-dead-letter:v1:${fingerprintSha256}`,
          aggregateType: "SlicingQueueDeadLetter",
          aggregateId,
          messageType,
          schemaVersion: 1,
          payload: {
            queueJobId: queued.id ?? null,
            queueJobName: queued.name,
            queueEntryFingerprintSha256: fingerprintSha256,
            attemptsMade: queued.attemptsMade,
            configuredAttempts: queued.opts.attempts ?? null,
            failure: safeLastError(error),
            workerFailure: safeLastError(
              queued.failedReason
                ? new Error(queued.failedReason)
                : new Error("queue job has no validated durable dispatch"),
            ),
            jobData: evidence.jobData,
            terminalReturnValue: evidence.terminalReturnValue,
            progress: evidence.progress,
          },
        },
      });
    });
  }

  private async assertDurableDispatch(job: SlicingJob): Promise<string> {
    const { SlicingJobSchema, slicingDispatchAttemptKey } =
      await import("@taven/slicer-contracts");
    const dispatch = await this.prisma.outboxMessage.findUnique({
      where: {
        deduplicationKey: slicingDispatchAttemptKey(
          job.idempotencyKey,
          job.attempt,
        ),
      },
    });
    const expectedMessageType = `slicing.${job.kind.replaceAll("_", "-")}.requested`;
    if (
      !dispatch ||
      dispatch.status !== "DELIVERED" ||
      dispatch.aggregateId !== job.jobId ||
      dispatch.messageType !== expectedMessageType ||
      dispatch.schemaVersion !== job.contractVersion
    ) {
      throw new InvalidSlicingQueueEntryError(
        "completed slicing job has no matching durable dispatch",
      );
    }
    const payload = dispatch.payload as Record<string, unknown>;
    const persistedJob = SlicingJobSchema.safeParse(payload.job);
    if (
      !persistedJob.success ||
      JSON.stringify(persistedJob.data) !== JSON.stringify(job)
    ) {
      throw new InvalidSlicingQueueEntryError(
        "completed slicing job differs from its durable dispatch",
      );
    }
    return dispatch.id;
  }
}

export const slicingQueueJobId = queueJobId;
