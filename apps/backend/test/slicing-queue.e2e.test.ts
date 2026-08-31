import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { SlicingJob, SlicingResult } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import {
  SlicingQueuePublisher,
  slicingQueueJobId,
} from "../src/modules/slicing/slicing-queue.publisher";
import { readSlicingQueueConfig } from "../src/modules/slicing/slicing.config";
import { CandidateEstimateService } from "../src/modules/resources/candidate-estimate.service";
import { SlicingResultIngestionService } from "../src/modules/slicing/slicing-result-ingestion.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { PersistenceFactory } from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.TAVEN_REDIS_URL;
const prefix = `taven-slicing-e2e-${randomUUID()}`;
let prisma: PrismaService;
let pool: Pool;
let queue: Queue;
let worker: Worker;
let publisher: SlicingQueuePublisher;
let contracts: typeof import("@taven/slicer-contracts", {
  with: { "resolution-mode": "import" },
});
const queuedResults = new Map<string, SlicingResult>();

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

async function productionFixture(name: string): Promise<{
  job: SlicingJob;
  result: SlicingResult;
  orderId: string;
  paymentId: string;
  phaseReservationSetId: string;
  productionReservationId: string;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fixtures = new PersistenceFactory(client, `${prefix}:${name}`);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 15 * 60_000);
    const startsAt = new Date(createdAt.getTime() + 60_000);
    const endsAt = new Date(startsAt.getTime() + 60_000);
    const { foundation, productions } = await fixtures.createReservationGraph(
      name,
      [{ startsAt, endsAt }],
      {},
      {},
      { createdAt, expiresAt },
    );
    const production = productions[0];
    if (!production) throw new Error("production fixture was not planned");
    await client.query(
      `INSERT INTO inventory_reservations
         (id, node_id, production_reservation_id, inventory_id,
          reserved_milligrams, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [
        production.inventoryReservationId,
        foundation.nodeId,
        production.productionReservationId,
        foundation.inventoryId,
        production.requiredMaterialMilligrams,
        expiresAt,
        createdAt,
      ],
    );
    await client.query(
      `INSERT INTO capacity_reservations
         (id, node_id, production_reservation_id,
          candidate_capacity_interval_id, machine_id, starts_at, ends_at,
          expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fixtures.id(`${name}:capacity-reservation`),
        foundation.nodeId,
        production.productionReservationId,
        production.candidateCapacityIntervalId,
        foundation.machineId,
        startsAt,
        endsAt,
        expiresAt,
        createdAt,
      ],
    );
    await client.query(
      "UPDATE phase_reservation_sets SET status = 'RESERVED' WHERE id = $1",
      [foundation.phaseReservationSetId],
    );
    await client.query(
      "UPDATE inventory_reservations SET status = 'HELD' WHERE production_reservation_id = $1",
      [production.productionReservationId],
    );
    await client.query(
      "UPDATE capacity_reservations SET status = 'HELD' WHERE production_reservation_id = $1",
      [production.productionReservationId],
    );
    await fixtures.createJob(foundation, production);
    await client.query(
      "UPDATE production_reservations SET status = 'HELD', job_id = $2 WHERE id = $1",
      [production.productionReservationId, production.jobId],
    );
    await client.query(
      "UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1",
      [foundation.phaseReservationSetId],
    );
    await fixtures.activatePayment(foundation);
    await client.query(
      `SET CONSTRAINTS
         "payments_capture_activation_reconciled",
         "orders_capture_activation_reconciled",
         "order_phases_capture_activation_reconciled",
         "phase_reservation_sets_capture_activation_reconciled",
         "jobs_captured_reservation_reconciled" IMMEDIATE`,
    );
    await client.query(
      `SET CONSTRAINTS
         "payments_capture_activation_reconciled",
         "orders_capture_activation_reconciled",
         "order_phases_capture_activation_reconciled",
         "phase_reservation_sets_capture_activation_reconciled",
         "jobs_captured_reservation_reconciled" DEFERRED`,
    );
    await client.query(
      `UPDATE jobs
       SET status = 'ACCEPTED', accepted_at = $2,
           payout_amount = 0, payout_currency = 'EUR', updated_at = $2
       WHERE id = $1`,
      [production.jobId, new Date()],
    );
    const persisted = await client.query<{
      job_id: string;
      machine_id: string;
      model_geometry_id: string;
      source_model_file_id: string;
      source_content_sha256: string;
      canonical_object_key: string;
      geometry_sha256: string;
      machine_profile_id: string;
      machine_profile_sha256: string;
      slicer_engine: string;
      slicer_version: string;
      machine_calibration_id: string;
      machine_calibration_sha256: string;
      print_config_revision_id: string;
      print_config_sha256: string;
      arrangement_revision_id: string;
      arrangement_sha256: string;
      quantity: number;
      parts_per_plate: number;
      required_machine_seconds: string;
      required_material_milligrams: string;
    }>(
      `SELECT production.job_id,
              production.machine_id,
              candidate.model_geometry_id,
              geometry.source_model_file_id,
              source.content_hash AS source_content_sha256,
              geometry.canonical_object_key,
              geometry.geometry_hash AS geometry_sha256,
              production.machine_profile_id,
              profile_revision.digest AS machine_profile_sha256,
              profile.slicer_engine,
              profile.slicer_version,
              production.machine_calibration_id,
              calibration_revision.digest AS machine_calibration_sha256,
              production.print_config_revision_id,
              config_revision.digest AS print_config_sha256,
              candidate.arrangement_revision_id,
              arrangement.content_sha256 AS arrangement_sha256,
              candidate.quantity,
              candidate.parts_per_plate,
              production.required_machine_seconds,
              production.required_material_milligrams
       FROM production_reservations production
       JOIN phase_resource_plan_jobs plan_job
         ON plan_job.id = production.phase_resource_plan_job_id
        AND plan_job.node_id = production.node_id
       JOIN candidate_resource_estimates candidate
         ON candidate.id = plan_job.candidate_resource_estimate_id
        AND candidate.node_id = plan_job.node_id
       JOIN model_geometries geometry ON geometry.id = candidate.model_geometry_id
       JOIN model_files source ON source.id = geometry.source_model_file_id
       JOIN machine_profiles profile ON profile.id = production.machine_profile_id
       JOIN revision_identities profile_revision ON profile_revision.id = profile.id
       JOIN revision_identities calibration_revision
         ON calibration_revision.id = production.machine_calibration_id
       JOIN revision_identities config_revision
         ON config_revision.id = production.print_config_revision_id
       JOIN arrangement_revisions arrangement
         ON arrangement.id = candidate.arrangement_revision_id
       WHERE production.id = $1`,
      [production.productionReservationId],
    );
    const row = persisted.rows[0];
    if (!row) throw new Error("production fixture inputs were not persisted");
    await client.query("COMMIT");

    const bodyIds = ["body-0001"];
    const input = {
      geometry: {
        sourceModelFileId: row.source_model_file_id,
        sourceContentSha256: row.source_content_sha256,
        modelGeometryId: row.model_geometry_id,
        canonicalObjectKey: row.canonical_object_key,
        geometrySha256: row.geometry_sha256,
        bodyIds,
        selectionSha256: contracts.geometrySelectionSha256(bodyIds),
      },
      machineId: row.machine_id,
      machineProfile: {
        revisionId: row.machine_profile_id,
        contentSha256: row.machine_profile_sha256,
        slicerEngine: row.slicer_engine,
        slicerVersion: row.slicer_version,
        productionArtifactFormat: "gcode_3mf" as const,
      },
      machineCalibration: {
        revisionId: row.machine_calibration_id,
        contentSha256: row.machine_calibration_sha256,
      },
      printConfig: {
        revisionId: row.print_config_revision_id,
        contentSha256: row.print_config_sha256,
      },
      partsPerPlate: row.parts_per_plate,
      quantity: row.quantity,
      acceptedJobId: row.job_id,
      productionReservationId: production.productionReservationId,
      arrangementRevision: {
        revisionId: row.arrangement_revision_id,
        contentSha256: row.arrangement_sha256,
      },
    };
    const fingerprint = contracts.slicingInputFingerprint(
      "production_slice",
      input,
    );
    const job = contracts.SlicingJobSchema.parse({
      contractVersion: 2,
      kind: "production_slice",
      jobId: row.job_id,
      correlationId: randomUUID(),
      inputFingerprintSha256: fingerprint,
      idempotencyKey: `slicer:v2:production_slice:${row.job_id}:${fingerprint}`,
      attempt: 1,
      input,
    });
    const result = contracts.slicingResultForJobSchema(job).parse({
      ...job,
      engine: {
        name: row.slicer_engine,
        version: row.slicer_version,
        imageSha256: "d".repeat(64),
      },
      outcome: {
        status: "succeeded",
        metrics: {
          boundingBox: {
            xMicrometers: "1",
            yMicrometers: "1",
            zMicrometers: "1",
          },
          objectCount: 1,
          bodyCount: 1,
          topology: {
            watertight: true,
            manifold: true,
            normals: "consistent",
          },
          thinWallFeatureCount: 0,
          supportVolumeRatioPpm: 0,
          hasPaintAssignments: false,
          materialAssignmentCount: 0,
          estimatedPrintSeconds: row.required_machine_seconds,
          estimatedMaterialMilligrams: row.required_material_milligrams,
          plateCount: 1,
        },
        plates: [
          {
            plateOrdinal: 1,
            partsOnPlate: row.quantity,
            estimatedPrintSeconds: row.required_machine_seconds,
            estimatedMaterialMilligrams: row.required_material_milligrams,
          },
        ],
        artifact: {
          format: "gcode_3mf",
          objectKey: `gcode/${row.job_id}/toolpaths.gcode.3mf`,
          sha256: "e".repeat(64),
        },
      },
    });
    return {
      job,
      result,
      orderId: foundation.orderId,
      paymentId: foundation.paymentId,
      phaseReservationSetId: foundation.phaseReservationSetId,
      productionReservationId: production.productionReservationId,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("slicing outbox queue bridge", () => {
  beforeAll(async () => {
    if (!databaseUrl || !redisUrl) {
      throw new Error(
        "DATABASE_URL and TAVEN_REDIS_URL are required for slicing queue e2e",
      );
    }
    contracts = await import("@taven/slicer-contracts");
    pool = new Pool({ connectionString: databaseUrl });
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const connection = readSlicingQueueConfig().connection;
    queue = new Queue(contracts.SLICING_QUEUE_NAME, { connection, prefix });
    worker = new Worker(
      contracts.SLICING_QUEUE_NAME,
      async (queued) => {
        const parsed = contracts.SlicingJobSchema.parse(queued.data);
        const queuedResult = queuedResults.get(parsed.jobId);
        if (queuedResult) return queuedResult;
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
      new SlicingResultIngestionService(prisma),
    );
  });

  afterAll(async () => {
    await worker?.close();
    await publisher?.onModuleDestroy();
    await prisma?.onModuleDestroy();
    await pool?.end();
  });

  it("claims a durable dispatch and persists its validated result before queue cleanup", async () => {
    const job = inspectionJob();
    if (job.kind !== "model_inspection") throw new Error("invalid fixture");
    await prisma.modelFile.create({
      data: {
        id: job.input.source.modelFileId,
        format: "STL",
        originalFilename: "fixture.stl",
        storageObjectKey: job.input.source.objectKey,
        contentHash: job.input.source.contentSha256,
        sizeBytes: 1n,
        uploadedAt: new Date(),
        sourceDeleteAfter: new Date(Date.now() + 60_000),
      },
    });
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
          aggregateType: "SlicingDispatchResult",
          aggregateId: outbox.id,
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

  it("materializes a production result and seals the accepted Job before queue cleanup", async () => {
    const fixture = await productionFixture("production-success");
    queuedResults.set(fixture.job.jobId, fixture.result);
    const dispatch = await prisma.outboxMessage.create({
      data: {
        deduplicationKey: contracts.slicingDispatchAttemptKey(
          fixture.job.idempotencyKey,
          fixture.job.attempt,
        ),
        aggregateType: "ProductionSliceDispatch",
        aggregateId: fixture.job.jobId,
        messageType: "slicing.production-slice.requested",
        schemaVersion: 2,
        payload: { job: fixture.job },
        availableAt: new Date(0),
      },
    });
    const expectedQueueId = slicingQueueJobId(fixture.job);
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("production completion timed out")),
        10_000,
      );
      worker.on("completed", (queued) => {
        if (queued.id !== expectedQueueId) return;
        clearTimeout(timeout);
        resolve();
      });
    });

    await expect(publisher.publishPending(1)).resolves.toBe(1);
    await completed;
    await expect(publisher.reconcileCompleted(10)).resolves.toBe(1);
    await expect(queue.getJob(expectedQueueId)).resolves.toBeUndefined();

    const persistedJob = await prisma.job.findUniqueOrThrow({
      where: { id: fixture.job.jobId },
    });
    expect(persistedJob).toMatchObject({
      status: "GCODE_READY",
      productionArtifactHash: "e".repeat(64),
    });
    expect(persistedJob.gcodeReadyAt).toBeInstanceOf(Date);
    expect(persistedJob.productionSliceResultId).toBeTruthy();
    await expect(
      prisma.productionReservation.findUniqueOrThrow({
        where: { id: fixture.productionReservationId },
      }),
    ).resolves.toMatchObject({
      productionSliceResultId: persistedJob.productionSliceResultId,
    });
    await expect(
      prisma.outboxMessage.findFirstOrThrow({
        where: {
          aggregateType: "SlicingDispatchResult",
          aggregateId: dispatch.id,
          messageType: "slicing.production_slice.result-received",
        },
      }),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("cancels and funds the refund obligation for a terminal production failure", async () => {
    const fixture = await productionFixture("production-failure");
    const result = contracts.slicingResultForJobSchema(fixture.job).parse({
      ...fixture.result,
      outcome: {
        status: "failed",
        failureClass: "deterministic_invalid",
        code: "INVALID_GEOMETRY",
        message: "Pinned slicer rejected the canonical geometry",
        retryable: false,
        retryAfterMilliseconds: null,
      },
    });
    queuedResults.set(fixture.job.jobId, result);
    const dispatch = await prisma.outboxMessage.create({
      data: {
        deduplicationKey: contracts.slicingDispatchAttemptKey(
          fixture.job.idempotencyKey,
          fixture.job.attempt,
        ),
        aggregateType: "ProductionSliceDispatch",
        aggregateId: fixture.job.jobId,
        messageType: "slicing.production-slice.requested",
        schemaVersion: 2,
        payload: { job: fixture.job },
        availableAt: new Date(0),
      },
    });
    const expectedQueueId = slicingQueueJobId(fixture.job);
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("production failure completion timed out")),
        10_000,
      );
      worker.on("completed", (queued) => {
        if (queued.id !== expectedQueueId) return;
        clearTimeout(timeout);
        resolve();
      });
    });

    await expect(publisher.publishPending(1)).resolves.toBe(1);
    await completed;
    await expect(publisher.reconcileCompleted(10)).resolves.toBe(1);
    await expect(queue.getJob(expectedQueueId)).resolves.toBeUndefined();

    await expect(
      prisma.job.findUniqueOrThrow({ where: { id: fixture.job.jobId } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      failureStage: "GCODE",
    });
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } }),
    ).resolves.toMatchObject({ status: "REFUND_PENDING" });
    await expect(
      prisma.refundTransaction.findFirstOrThrow({
        where: {
          paymentId: fixture.paymentId,
          reason: "PRODUCTION_FAILURE",
          status: "PENDING",
        },
      }),
    ).resolves.toMatchObject({
      idempotencyKey: `production-failure:${dispatch.id}:${fixture.paymentId}`,
    });
    await expect(
      prisma.productionReservation.findUniqueOrThrow({
        where: { id: fixture.productionReservationId },
      }),
    ).resolves.toMatchObject({ status: "RELEASED" });
    await expect(
      prisma.phaseReservationSet.findUniqueOrThrow({
        where: { id: fixture.phaseReservationSetId },
      }),
    ).resolves.toMatchObject({ status: "RELEASED" });
  });

  it("quarantines an orphan queue result and continues with later durable work", async () => {
    const orphan = inspectionJob();
    const valid = inspectionJob();
    if (valid.kind !== "model_inspection") throw new Error("invalid fixture");
    await prisma.modelFile.create({
      data: {
        id: valid.input.source.modelFileId,
        format: "STL",
        originalFilename: "valid-after-orphan.stl",
        storageObjectKey: valid.input.source.objectKey,
        contentHash: valid.input.source.contentSha256,
        sizeBytes: 1n,
        uploadedAt: new Date(),
        sourceDeleteAfter: new Date(Date.now() + 60_000),
      },
    });
    const dispatch = await prisma.outboxMessage.create({
      data: {
        deduplicationKey: contracts.slicingDispatchAttemptKey(
          valid.idempotencyKey,
          valid.attempt,
        ),
        aggregateType: "ModelInspectionDispatch",
        aggregateId: valid.jobId,
        messageType: "slicing.model-inspection.requested",
        schemaVersion: valid.contractVersion,
        status: "DELIVERED",
        deliveredAt: new Date(),
        payload: { job: valid },
      },
    });
    const orphanQueueId = slicingQueueJobId(orphan);
    const validQueueId = slicingQueueJobId(valid);
    const orphanCompleted = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("unowned queue completion timed out")),
        10_000,
      );
      worker.on("completed", (queued) => {
        if (queued.id !== orphanQueueId) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    await queue.add(orphan.kind, orphan, { jobId: orphanQueueId });
    await orphanCompleted;
    const validCompleted = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("valid queue completion timed out")),
        10_000,
      );
      worker.on("completed", (queued) => {
        if (queued.id !== validQueueId) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    await queue.add(valid.kind, valid, { jobId: validQueueId });
    await validCompleted;

    await expect(publisher.reconcileCompleted(10)).resolves.toBe(2);
    await expect(queue.getJob(orphanQueueId)).resolves.toBeUndefined();
    await expect(queue.getJob(validQueueId)).resolves.toBeUndefined();
    await expect(
      prisma.outboxMessage.findFirstOrThrow({
        where: {
          aggregateType: "SlicingQueueDeadLetter",
          messageType: "slicing.queue-entry.dead-lettered",
          payload: { path: ["queueJobId"], equals: orphanQueueId },
        },
      }),
    ).resolves.toMatchObject({
      status: "PENDING",
      schemaVersion: 1,
      payload: {
        queueJobId: orphanQueueId,
        jobData: orphan,
        terminalReturnValue: expect.objectContaining({
          kind: "model_inspection",
          jobId: orphan.jobId,
        }),
      },
    });
    await expect(
      prisma.outboxMessage.findFirstOrThrow({
        where: {
          aggregateType: "SlicingDispatchResult",
          aggregateId: dispatch.id,
          messageType: "slicing.model_inspection.result-received",
        },
      }),
    ).resolves.toMatchObject({ status: "PENDING" });
  });
});
