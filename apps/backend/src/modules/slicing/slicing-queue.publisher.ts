import { createHash } from "node:crypto";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { Queue } from "bullmq";
import type { SlicingJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { PrismaService } from "../../prisma/prisma.service";
import { CandidateEstimateService } from "../resources/candidate-estimate.service";
import { SLICING_QUEUE } from "./slicing.tokens";

const CLAIM_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const MAX_LAST_ERROR_LENGTH = 1_000;

type ClaimedDispatch = {
  id: string;
  attempts: number;
  payload: Prisma.JsonValue;
};

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

@Injectable()
export class SlicingQueuePublisher implements OnModuleDestroy {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SLICING_QUEUE) private readonly queue: Queue,
    @Inject(CandidateEstimateService)
    private readonly candidateEstimates: CandidateEstimateService,
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
      ["completed"],
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
      const job = SlicingJobSchema.parse(queued.data);
      await this.assertDurableDispatch(job);
      const result = slicingResultForJobSchema(job).parse(queued.returnvalue);
      const resultFingerprintSha256 = slicingResultFingerprint(result);
      if (result.kind === "candidate_estimate") {
        await this.candidateEstimates.ingest({ result });
      }
      await this.recordResultReceipt(
        result.jobId,
        result.kind,
        resultFingerprintSha256,
        result as unknown as Prisma.InputJsonObject,
      );
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
            printConfigRevision: {
              revision: { digest: input.printConfig.contentSha256 },
            },
            machineProfile: {
              slicerEngine: input.machineProfile.slicerEngine,
              slicerVersion: input.machineProfile.slicerVersion,
              revision: { digest: input.machineProfile.contentSha256 },
            },
            machineCalibration: {
              revision: { digest: input.machineCalibration.contentSha256 },
            },
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

  private async assertDurableDispatch(job: SlicingJob): Promise<void> {
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
      throw new Error("completed slicing job has no matching durable dispatch");
    }
    const payload = dispatch.payload as Record<string, unknown>;
    const persistedJob = SlicingJobSchema.parse(payload.job);
    if (JSON.stringify(persistedJob) !== JSON.stringify(job)) {
      throw new Error(
        "completed slicing job differs from its durable dispatch",
      );
    }
  }

  private async recordResultReceipt(
    jobId: string,
    kind: SlicingJob["kind"],
    resultFingerprintSha256: string,
    result: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${jobId}, 0))::text
      `;
      const messageType = `slicing.${kind}.result-received`;
      const existing = await transaction.outboxMessage.findFirst({
        where: {
          aggregateType: "SlicingResult",
          aggregateId: jobId,
          messageType,
        },
      });
      if (existing) {
        const payload = existing.payload as Record<string, unknown>;
        if (payload.resultFingerprintSha256 !== resultFingerprintSha256) {
          throw new Error("slicing job already has a different result receipt");
        }
        return;
      }
      await transaction.outboxMessage.create({
        data: {
          deduplicationKey: `slicer-result:v2:${resultFingerprintSha256}`,
          aggregateType: "SlicingResult",
          aggregateId: jobId,
          messageType,
          schemaVersion: 2,
          payload: { resultFingerprintSha256, result },
        },
      });
    });
  }
}

export const slicingQueueJobId = queueJobId;
