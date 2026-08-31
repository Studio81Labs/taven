import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type { SlicingJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { PrismaService } from "../../prisma/prisma.service";
import { CandidateEstimateService } from "../resources/candidate-estimate.service";
import { SlicingQueuePublisher } from "./slicing-queue.publisher";
import { SlicingResultIngestionService } from "./slicing-result-ingestion.service";

type ProductionAuthorizer = {
  assertProductionSliceAuthorized(
    job: Extract<SlicingJob, { kind: "production_slice" }>,
  ): Promise<void>;
};

type RetryableResultReader = {
  exhaustedRetryableResult(queued: {
    attemptsMade: number;
    opts: { attempts?: number };
    progress: unknown;
  }): unknown;
};

describe("SlicingQueuePublisher production authorization", () => {
  it("authorizes package quantity through the planned candidate, not the analysis slice", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "accepted-job" });
    const publisher = new SlicingQueuePublisher(
      { job: { findFirst } } as unknown as PrismaService,
      {} as Queue,
      {} as CandidateEstimateService,
      {} as SlicingResultIngestionService,
    );
    const job = {
      input: {
        acceptedJobId: "accepted-job",
        productionReservationId: "reservation",
        machineId: "machine",
        quantity: 5,
        partsPerPlate: 2,
        geometry: {
          modelGeometryId: "geometry",
          sourceModelFileId: "source",
          canonicalObjectKey: "geometries/geometry/canonical",
          geometrySha256: "a".repeat(64),
          sourceContentSha256: "b".repeat(64),
        },
        printConfig: { revisionId: "config", contentSha256: "c".repeat(64) },
        machineProfile: {
          revisionId: "profile",
          contentSha256: "d".repeat(64),
        },
        machineCalibration: {
          revisionId: "calibration",
          contentSha256: "e".repeat(64),
        },
        arrangementRevision: {
          revisionId: "arrangement",
          contentSha256: "f".repeat(64),
        },
      },
    } as unknown as Extract<SlicingJob, { kind: "production_slice" }>;

    await expect(
      (
        publisher as unknown as ProductionAuthorizer
      ).assertProductionSliceAuthorized(job),
    ).resolves.toBeUndefined();

    const where = findFirst.mock.calls[0]![0].where;
    const reservation = where.productionReservations.some;
    expect(reservation.occupancySliceResult).not.toHaveProperty(
      "packageQuantity",
    );
    expect(
      reservation.phaseResourcePlanJob.candidateResourceEstimate,
    ).toMatchObject({
      quantity: 5,
      partsPerPlate: 2,
      arrangementRevisionId: "arrangement",
      arrangementRevision: { contentSha256: "f".repeat(64) },
    });
  });

  it("accepts structured retryable progress only after queue attempts are exhausted", () => {
    const publisher = new SlicingQueuePublisher(
      {} as PrismaService,
      {} as Queue,
      {} as CandidateEstimateService,
      {} as SlicingResultIngestionService,
    ) as unknown as RetryableResultReader;
    const result = { outcome: { failureClass: "retryable_infrastructure" } };
    expect(
      publisher.exhaustedRetryableResult({
        attemptsMade: 3,
        opts: { attempts: 3 },
        progress: {
          type: "retryable-slicing-result",
          queueAttempt: 3,
          result,
        },
      }),
    ).toBe(result);
    expect(() =>
      publisher.exhaustedRetryableResult({
        attemptsMade: 1,
        opts: { attempts: 3 },
        progress: {
          type: "retryable-slicing-result",
          queueAttempt: 1,
          result,
        },
      }),
    ).toThrow("has not exhausted");
    expect(() =>
      publisher.exhaustedRetryableResult({
        attemptsMade: 3,
        opts: { attempts: 3 },
        progress: 0,
      }),
    ).toThrow("no current validated retryable result");
    expect(() =>
      publisher.exhaustedRetryableResult({
        attemptsMade: 3,
        opts: { attempts: 3 },
        progress: {
          type: "retryable-slicing-result",
          queueAttempt: 2,
          result,
        },
      }),
    ).toThrow("no current validated retryable result");
  });

  it("leaves a valid completed job in place when dispatch lookup fails transiently", async () => {
    const contracts = await import("@taven/slicer-contracts");
    const jobId = "00000000-0000-4000-8000-000000000001";
    const modelFileId = "00000000-0000-4000-8000-000000000002";
    const input = {
      source: {
        modelFileId,
        format: "stl" as const,
        objectKey: `models/${modelFileId}/source`,
        contentSha256: "a".repeat(64),
      },
      operation: { mode: "inspect_source" as const },
      inspectionRevision: "inspection-v1",
      inspectionConfigSha256: "b".repeat(64),
      canonicalizerRevision: "canonicalizer-v1",
      canonicalizerConfigSha256: "c".repeat(64),
    };
    const fingerprint = contracts.slicingInputFingerprint(
      "model_inspection",
      input,
    );
    const job = contracts.SlicingJobSchema.parse({
      contractVersion: 2,
      kind: "model_inspection",
      jobId,
      correlationId: "00000000-0000-4000-8000-000000000003",
      inputFingerprintSha256: fingerprint,
      idempotencyKey: `slicer:v2:model_inspection:${jobId}:${fingerprint}`,
      attempt: 1,
      input,
    });
    const remove = vi.fn();
    const queue = {
      getJobs: vi.fn().mockResolvedValue([
        {
          id: "queue-job",
          name: job.kind,
          data: job,
          returnvalue: null,
          progress: 0,
          opts: { attempts: 3 },
          attemptsMade: 1,
          failedReason: undefined,
          remove,
        },
      ]),
    };
    const transaction = vi.fn();
    const publisher = new SlicingQueuePublisher(
      {
        outboxMessage: {
          findUnique: vi.fn().mockRejectedValue(new Error("database offline")),
        },
        $transaction: transaction,
      } as unknown as PrismaService,
      queue as unknown as Queue,
      {} as CandidateEstimateService,
      {} as SlicingResultIngestionService,
    );

    await expect(publisher.reconcileCompleted(1)).rejects.toThrow(
      "database offline",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
