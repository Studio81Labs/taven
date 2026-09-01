import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type {
  CandidateEstimateResult,
  SlicingJob,
} from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { PrismaService } from "../../prisma/prisma.service";
import { CandidateEstimateService } from "../resources/candidate-estimate.service";
import { ResourceNotFoundError } from "../resources/resource-errors";
import { SlicingQueuePublisher } from "./slicing-queue.publisher";
import {
  PermanentSlicingResultIngestionError,
  SlicingResultIngestionService,
} from "./slicing-result-ingestion.service";
import type { SlicerProfileSnapshotService } from "./slicer-profile-snapshot.service";

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

type CandidateResultIngester = {
  ingestCandidateResult(result: CandidateEstimateResult): Promise<void>;
};

async function inspectionTerminal(seed: number) {
  const contracts = await import("@taven/slicer-contracts");
  const uuid = (offset: number) =>
    `00000000-0000-4000-8000-${String(seed * 10 + offset).padStart(12, "0")}`;
  const jobId = uuid(1);
  const modelFileId = uuid(2);
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
    correlationId: uuid(3),
    inputFingerprintSha256: fingerprint,
    idempotencyKey: `slicer:v2:model_inspection:${jobId}:${fingerprint}`,
    attempt: 1,
    input,
  });
  const result = contracts.slicingResultForJobSchema(job).parse({
    ...job,
    engine: {
      name: "fixture",
      version: "0.0.0",
      imageSha256: "d".repeat(64),
    },
    outcome: {
      status: "failed",
      failureClass: "deterministic_invalid",
      code: "INVALID_MODEL",
      message: "Fixture model is invalid",
      retryable: false,
      retryAfterMilliseconds: null,
    },
  });
  return { job, result };
}

function queuedTerminal(
  id: string,
  terminal: Awaited<ReturnType<typeof inspectionTerminal>>,
) {
  return {
    id,
    name: terminal.job.kind,
    data: terminal.job,
    returnvalue: terminal.result,
    progress: 0,
    opts: { attempts: 3 },
    attemptsMade: 1,
    failedReason: undefined,
    remove: vi.fn(),
  };
}

function reconciliationPrisma(
  terminals: readonly Awaited<ReturnType<typeof inspectionTerminal>>[],
) {
  let dispatchIndex = 0;
  const deadLetterCreate = vi.fn().mockResolvedValue({ id: "dead-letter" });
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    outboxMessage: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: deadLetterCreate,
    },
  };
  return {
    prisma: {
      outboxMessage: {
        findUnique: vi.fn().mockImplementation(() => {
          const terminal = terminals[dispatchIndex];
          dispatchIndex += 1;
          if (!terminal) return null;
          return {
            id: `dispatch-${terminal.job.jobId}`,
            status: "DELIVERED",
            aggregateId: terminal.job.jobId,
            messageType: "slicing.model-inspection.requested",
            schemaVersion: terminal.job.contractVersion,
            payload: { job: terminal.job },
          };
        }),
      },
      $transaction: vi
        .fn()
        .mockImplementation(
          async (callback: (value: typeof transaction) => unknown) =>
            callback(transaction),
        ),
    } as unknown as PrismaService,
    deadLetterCreate,
  };
}

describe("SlicingQueuePublisher production authorization", () => {
  it("authorizes package quantity through the planned candidate, not the analysis slice", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "accepted-job" });
    const publisher = new SlicingQueuePublisher(
      { job: { findFirst } } as unknown as PrismaService,
      {} as Queue,
      {} as CandidateEstimateService,
      {} as SlicingResultIngestionService,
      {} as SlicerProfileSnapshotService,
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
      {} as SlicerProfileSnapshotService,
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

  it("cleans unowned candidate metrics before permanent rejection", async () => {
    const result = {
      kind: "candidate_estimate",
      outcome: {
        status: "succeeded",
        occupancySlices: [
          {
            artifact: {
              objectKey: `slice-metrics/${"a".repeat(64)}/result.json`,
            },
          },
        ],
      },
    } as unknown as CandidateEstimateResult;
    const failure = new ResourceNotFoundError("candidate machine was retired");
    const ingest = vi.fn().mockRejectedValue(failure);
    const deleteUnownedUploadedArtifacts = vi.fn().mockResolvedValue(undefined);
    const publisher = new SlicingQueuePublisher(
      {} as PrismaService,
      {} as Queue,
      { ingest } as unknown as CandidateEstimateService,
      {
        deleteUnownedUploadedArtifacts,
      } as unknown as SlicingResultIngestionService,
      {} as SlicerProfileSnapshotService,
    ) as unknown as CandidateResultIngester;

    await expect(publisher.ingestCandidateResult(result)).rejects.toBe(failure);
    expect(deleteUnownedUploadedArtifacts).toHaveBeenCalledWith(result);
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
      {} as SlicerProfileSnapshotService,
    );

    await expect(publisher.reconcileCompleted(1)).rejects.toThrow(
      "database offline",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("quarantines a permanent ingestion mismatch and continues with later jobs", async () => {
    const first = await inspectionTerminal(1);
    const second = await inspectionTerminal(2);
    const firstQueued = queuedTerminal("queue-first", first);
    const secondQueued = queuedTerminal("queue-second", second);
    const queue = {
      getJobs: vi.fn().mockResolvedValue([firstQueued, secondQueued]),
    };
    const { prisma, deadLetterCreate } = reconciliationPrisma([first, second]);
    const ingest = vi
      .fn()
      .mockRejectedValueOnce(
        new PermanentSlicingResultIngestionError(
          "reference profile was retired",
        ),
      )
      .mockResolvedValueOnce(undefined);
    const publisher = new SlicingQueuePublisher(
      prisma,
      queue as unknown as Queue,
      {} as CandidateEstimateService,
      { ingest } as unknown as SlicingResultIngestionService,
      {} as SlicerProfileSnapshotService,
    );

    await expect(publisher.reconcileCompleted(2)).resolves.toBe(2);
    expect(firstQueued.remove).toHaveBeenCalledOnce();
    expect(secondQueued.remove).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(deadLetterCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: "SlicingDispatchDeadLetter",
        aggregateId: `dispatch-${first.job.jobId}`,
        messageType: "slicing.model_inspection.dead-lettered",
        payload: expect.objectContaining({
          failure: "reference profile was retired",
          queueJobId: "queue-first",
        }),
      }),
    });
  });

  it("preserves terminal jobs when ingestion fails transiently", async () => {
    const terminal = await inspectionTerminal(3);
    const queued = queuedTerminal("queue-transient", terminal);
    const queue = { getJobs: vi.fn().mockResolvedValue([queued]) };
    const { prisma, deadLetterCreate } = reconciliationPrisma([terminal]);
    const publisher = new SlicingQueuePublisher(
      prisma,
      queue as unknown as Queue,
      {} as CandidateEstimateService,
      {
        ingest: vi.fn().mockRejectedValue(new Error("database unavailable")),
      } as unknown as SlicingResultIngestionService,
      {} as SlicerProfileSnapshotService,
    );

    await expect(publisher.reconcileCompleted(1)).rejects.toThrow(
      "database unavailable",
    );
    expect(queued.remove).not.toHaveBeenCalled();
    expect(deadLetterCreate).not.toHaveBeenCalled();
  });
});
