import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SlicingJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import {
  SlicingQueuePublisher,
  slicingQueueJobId,
} from "../src/modules/slicing/slicing-queue.publisher";
import { readSlicingQueueConfig } from "../src/modules/slicing/slicing.config";
import { CandidateEstimateService } from "../src/modules/resources/candidate-estimate.service";
import { PrismaService } from "../src/prisma/prisma.service";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.TAVEN_REDIS_URL;
const prefix = `taven-slicing-e2e-${randomUUID()}`;
let prisma: PrismaService;
let queue: Queue;
let worker: Worker;
let publisher: SlicingQueuePublisher;
let contracts: typeof import("@taven/slicer-contracts", {
  with: { "resolution-mode": "import" },
});

function inspectionJob(): SlicingJob {
  const jobId = randomUUID();
  const kind = "model_inspection" as const;
  const input = {
    source: {
      modelFileId: randomUUID(),
      format: "stl" as const,
      objectKey: "" as string,
      contentSha256: "a".repeat(64),
    },
    operation: { mode: "inspect_source" as const },
    inspectionRevision: "inspection-v1",
    inspectionConfigSha256: "b".repeat(64),
    canonicalizerRevision: "canonicalizer-v1",
    canonicalizerConfigSha256: "c".repeat(64),
  };
  input.source.objectKey = `models/${input.source.modelFileId}/source`;
  const fingerprint = contracts.slicingInputFingerprint(kind, input);
  return contracts.SlicingJobSchema.parse({
    contractVersion: 2,
    kind,
    jobId,
    correlationId: randomUUID(),
    inputFingerprintSha256: fingerprint,
    idempotencyKey: `slicer:v2:${kind}:${jobId}:${fingerprint}`,
    attempt: 1,
    input,
  });
}

function unauthorizedProductionJob(): SlicingJob {
  const jobId = randomUUID();
  const kind = "production_slice" as const;
  const revision = () => ({
    revisionId: randomUUID(),
    contentSha256: "b".repeat(64),
  });
  const modelFileId = randomUUID();
  const modelGeometryId = randomUUID();
  const input = {
    geometry: {
      sourceModelFileId: modelFileId,
      sourceContentSha256: "a".repeat(64),
      modelGeometryId,
      canonicalObjectKey: `geometries/${modelGeometryId}/canonical`,
      geometrySha256: "c".repeat(64),
      bodyIds: ["body-0001"],
      selectionSha256: contracts.geometrySelectionSha256(["body-0001"]),
    },
    machineId: randomUUID(),
    machineProfile: {
      ...revision(),
      slicerEngine: "orca",
      slicerVersion: "2.3.1",
      productionArtifactFormat: "gcode" as const,
    },
    machineCalibration: revision(),
    printConfig: revision(),
    partsPerPlate: 1,
    quantity: 1,
    acceptedJobId: jobId,
    productionReservationId: randomUUID(),
    arrangementRevision: revision(),
  };
  const fingerprint = contracts.slicingInputFingerprint(kind, input);
  return contracts.SlicingJobSchema.parse({
    contractVersion: 2,
    kind,
    jobId,
    correlationId: randomUUID(),
    inputFingerprintSha256: fingerprint,
    idempotencyKey: `slicer:v2:${kind}:${jobId}:${fingerprint}`,
    attempt: 1,
    input,
  });
}

describe("slicing outbox queue bridge", () => {
  beforeAll(async () => {
    if (!databaseUrl || !redisUrl) {
      throw new Error(
        "DATABASE_URL and TAVEN_REDIS_URL are required for slicing queue e2e",
      );
    }
    contracts = await import("@taven/slicer-contracts");
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const connection = readSlicingQueueConfig().connection;
    queue = new Queue(contracts.SLICING_QUEUE_NAME, { connection, prefix });
    worker = new Worker(
      contracts.SLICING_QUEUE_NAME,
      async (queued) => {
        const parsed = contracts.SlicingJobSchema.parse(queued.data);
        if (parsed.kind !== "model_inspection") {
          throw new Error("unexpected slicing kind");
        }
        return contracts.slicingResultForJobSchema(parsed).parse({
          ...parsed,
          engine: {
            name: "fixture",
            version: "0.0.0",
            imageSha256: "d".repeat(64),
          },
          outcome: {
            status: "succeeded",
            canonicalGeometry: null,
            metrics: {
              boundingBox: {
                xMicrometers: "1000",
                yMicrometers: "1000",
                zMicrometers: "1000",
              },
              objectCount: 1,
              bodyCount: 1,
              unitHint: "unknown",
              scaleAssessment: "confirmation_required",
              suggestedScaleFactorPpm: null,
              thinWallFeatureCount: 0,
              hasPaintAssignments: false,
              materialAssignmentCount: 0,
              extruderAssignmentCount: 0,
            },
            bodies: [
              {
                bodyId: "body-0001",
                bodySha256: "e".repeat(64),
                boundingBox: {
                  xMicrometers: "1000",
                  yMicrometers: "1000",
                  zMicrometers: "1000",
                },
                volumeCubicMicrometers: "1000000000",
                triangleCount: 12,
                topology: {
                  watertight: true,
                  manifold: true,
                  normals: "consistent",
                },
                hasPaintAssignments: false,
                materialAssignmentIds: [],
                extruderAssignmentIds: [],
              },
            ],
            findings: [],
          },
        });
      },
      { connection, prefix },
    );
    await worker.waitUntilReady();
    publisher = new SlicingQueuePublisher(
      prisma,
      queue,
      new CandidateEstimateService(prisma),
    );
  });

  afterAll(async () => {
    await worker?.close();
    await publisher?.onModuleDestroy();
    await prisma?.onModuleDestroy();
  });

  it("claims a durable dispatch and persists its validated result before queue cleanup", async () => {
    const job = inspectionJob();
    const outbox = await prisma.outboxMessage.create({
      data: {
        deduplicationKey: contracts.slicingDispatchAttemptKey(
          job.idempotencyKey,
          job.attempt,
        ),
        aggregateType: "ModelInspectionDispatch",
        aggregateId: job.jobId,
        messageType: "slicing.model-inspection.requested",
        schemaVersion: 2,
        payload: { job },
        availableAt: new Date(0),
      },
    });
    const expectedQueueId = slicingQueueJobId(job);
    const completed = new Promise<{ kind: string; jobId: string }>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("queue completion timed out")),
          10_000,
        );
        worker.on("completed", (queued, result) => {
          if (queued.id !== expectedQueueId) return;
          clearTimeout(timeout);
          resolve(result as { kind: string; jobId: string });
        });
      },
    );

    await expect(publisher.publishPending(1)).resolves.toBe(1);
    await expect(completed).resolves.toMatchObject({
      kind: "model_inspection",
      jobId: job.jobId,
    });
    await expect
      .poll(() => publisher.reconcileCompleted(10), { timeout: 3_000 })
      .toBe(1);
    await expect(
      prisma.outboxMessage.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).resolves.toMatchObject({
      status: "DELIVERED",
      attempts: 1,
      lockedAt: null,
      lastError: null,
    });
    await expect(queue.getJob(expectedQueueId)).resolves.toBeUndefined();
    await expect(
      prisma.outboxMessage.findFirstOrThrow({
        where: {
          aggregateType: "SlicingResult",
          aggregateId: job.jobId,
          messageType: "slicing.model_inspection.result-received",
        },
      }),
    ).resolves.toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("does not enqueue production slicing without a persisted accepted job", async () => {
    const job = unauthorizedProductionJob();
    const outbox = await prisma.outboxMessage.create({
      data: {
        deduplicationKey: contracts.slicingDispatchAttemptKey(
          job.idempotencyKey,
          job.attempt,
        ),
        aggregateType: "ProductionSliceDispatch",
        aggregateId: job.jobId,
        messageType: "slicing.production-slice.requested",
        schemaVersion: 2,
        payload: { job },
        availableAt: new Date(0),
      },
    });

    await expect(publisher.publishPending(1)).resolves.toBe(0);
    await expect(queue.getJob(slicingQueueJobId(job))).resolves.toBeUndefined();
    await expect(
      prisma.outboxMessage.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      attempts: 1,
      lockedAt: null,
      lastError:
        "production slicing requires an accepted job and its exact held reservation inputs",
    });
  });

  it("does not reconcile a queue result without its durable dispatch", async () => {
    const job = inspectionJob();
    const expectedQueueId = slicingQueueJobId(job);
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("unowned queue completion timed out")),
        10_000,
      );
      worker.on("completed", (queued) => {
        if (queued.id !== expectedQueueId) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    await queue.add(job.kind, job, { jobId: expectedQueueId });
    await completed;

    await expect(publisher.reconcileCompleted(10)).rejects.toThrow(
      "no matching durable dispatch",
    );
    const queued = await queue.getJob(expectedQueueId);
    expect(queued).toBeDefined();
    await queued!.remove();
  });
});
