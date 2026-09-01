import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Prisma } from "@prisma/client";
import type {
  CandidateEstimateJob,
  CandidateEstimateResult,
} from "@taven/slicer-contracts" with { "resolution-mode": "import" };
import { CandidateEstimateService } from "../src/modules/resources/candidate-estimate.service";
import {
  ResourceConflictError,
  ResourceNotFoundError,
  ResourceValidationError,
} from "../src/modules/resources/resource-errors";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  SlicerProfileSnapshotService,
  slicerSettingsSnapshot,
} from "../src/modules/slicing/slicer-profile-snapshot.service";
import type { ObjectStorage } from "../src/modules/storage/object-storage.port";
import { PersistenceFactory, testTimes } from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const testScope = `candidate-estimate-${randomUUID()}`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

let pool: Pool;
let prisma: PrismaService;
let candidates: CandidateEstimateService;
let snapshots: SlicerProfileSnapshotService;
let contracts: typeof import("@taven/slicer-contracts", {
  with: { "resolution-mode": "import" },
});

type CandidateFixture = {
  dispatchId: string;
  nodeId: string;
  inventoryId: string;
  job: CandidateEstimateJob;
  success: CandidateEstimateResult;
  failure: CandidateEstimateResult;
};

function resultFor(
  job: CandidateEstimateJob,
  outcome: CandidateEstimateResult["outcome"],
): CandidateEstimateResult {
  return contracts.CandidateEstimateResultSchema.parse({
    ...job,
    engine: { name: "orca", version: "test", imageSha256: "b".repeat(64) },
    outcome,
  });
}

async function createFixture(
  name: string,
  {
    persistDispatch = true,
    dispatchableGeometry = false,
  }: { persistDispatch?: boolean; dispatchableGeometry?: boolean } = {},
): Promise<CandidateFixture> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fixtures = new PersistenceFactory(client, `${testScope}:${name}`);
    const foundation = await fixtures.createFoundation(name);
    const bodyIds = ["body-1"];
    const modelGeometryId = dispatchableGeometry
      ? fixtures.id(`${name}:dispatchable-geometry`)
      : foundation.modelGeometryId;
    const geometry = {
      sourceModelFileId: foundation.modelFileId,
      sourceContentSha256: "a".repeat(64),
      modelGeometryId: foundation.modelGeometryId,
      canonicalObjectKey: `geometries/${foundation.modelGeometryId}/canonical`,
      geometrySha256: hash(`${name}:geometry:0`),
      bodyIds,
      selectionSha256: contracts.geometrySelectionSha256(bodyIds),
    };
    if (dispatchableGeometry) {
      await client.query(
        `INSERT INTO model_geometries (
           id,
           source_model_file_id,
           canonical_object_key,
           geometry_hash,
           canonicalizer_revision,
           volume_cubic_micrometers,
           bounds_x_micrometers,
           bounds_y_micrometers,
           bounds_z_micrometers,
           triangle_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          modelGeometryId,
          foundation.modelFileId,
          `geometries/${modelGeometryId}/canonical`,
          hash(`${name}:dispatchable-geometry`),
          "test-canonicalizer",
          1,
          1,
          1,
          1,
          1,
        ],
      );
      const persistedGeometry = await client.query<{
        id: string;
        source_model_file_id: string;
        content_hash: string;
        canonical_object_key: string;
        geometry_hash: string;
      }>(
        `SELECT geometry.id,
                geometry.source_model_file_id,
                source.content_hash,
                geometry.canonical_object_key,
                geometry.geometry_hash
         FROM model_geometries geometry
         JOIN model_files source ON source.id = geometry.source_model_file_id
         WHERE geometry.id = $1`,
        [modelGeometryId],
      );
      const geometryRow = persistedGeometry.rows[0];
      if (!geometryRow) {
        throw new Error("candidate fixture geometry was not persisted");
      }
      Object.assign(geometry, {
        sourceModelFileId: geometryRow.source_model_file_id,
        sourceContentSha256: geometryRow.content_hash,
        modelGeometryId: geometryRow.id,
        canonicalObjectKey: geometryRow.canonical_object_key,
        geometrySha256: geometryRow.geometry_hash,
      });
    }
    const persistedRevisions = await client.query<{
      profile_settings: Prisma.JsonValue;
      calibration_settings: Prisma.JsonValue;
      config_settings: Prisma.JsonValue;
      slicer_engine: string;
      slicer_version: string;
    }>(
      `SELECT profile.settings AS profile_settings,
                  calibration.settings AS calibration_settings,
                  config.settings AS config_settings,
                  profile.slicer_engine,
                  profile.slicer_version
           FROM machine_profiles profile
           JOIN machine_calibrations calibration ON calibration.id = $2
           JOIN print_config_revisions config ON config.id = $3
           WHERE profile.id = $1`,
      [
        foundation.machineProfileId,
        foundation.machineCalibrationId,
        foundation.printConfigRevisionId,
      ],
    );
    const revisions = persistedRevisions.rows[0];
    if (!revisions) {
      throw new Error("candidate fixture revisions were not persisted");
    }
    const inputBase = {
      geometry,
      machineId: foundation.machineId,
      machineProfile: {
        revisionId: foundation.machineProfileId,
        contentSha256: slicerSettingsSnapshot(revisions.profile_settings)
          .contentSha256,
        slicerEngine: revisions.slicer_engine,
        slicerVersion: revisions.slicer_version,
        productionArtifactFormat: "gcode_3mf" as const,
      },
      machineCalibration: {
        revisionId: foundation.machineCalibrationId,
        contentSha256: slicerSettingsSnapshot(revisions.calibration_settings)
          .contentSha256,
      },
      printConfig: {
        revisionId: foundation.printConfigRevisionId,
        contentSha256: slicerSettingsSnapshot(revisions.config_settings)
          .contentSha256,
      },
      partsPerPlate: 1,
      quantity: 1,
      shipmentPlanId: foundation.shipmentPlanId,
      arrangementRevision: {
        revisionId: fixtures.id(`${name}:arrangement`),
        contentSha256: hash(`${name}:arrangement`),
      },
    };
    const cacheIdentitySha256 = contracts.machineOccupancyCacheIdentitySha256(
      inputBase,
      1,
    );
    const input = {
      ...inputBase,
      occupancySliceTargets: [
        {
          partsPerPlate: 1,
          cacheIdentitySha256,
          analysisObjectKey: `slice-metrics/${cacheIdentitySha256}/result.json`,
        },
      ],
    };
    const jobId = fixtures.id(`${name}:dispatch-job`);
    const inputFingerprintSha256 = contracts.slicingInputFingerprint(
      "candidate_estimate",
      input,
    );
    const job = contracts.CandidateEstimateJobSchema.parse({
      contractVersion: 2,
      kind: "candidate_estimate",
      jobId,
      correlationId: fixtures.id(`${name}:correlation`),
      inputFingerprintSha256,
      idempotencyKey: `slicer:v2:candidate_estimate:${jobId}:${inputFingerprintSha256}`,
      attempt: 1,
      input,
    });
    const success = resultFor(job, {
      status: "succeeded",
      metrics: {
        boundingBox: {
          xMicrometers: "1",
          yMicrometers: "1",
          zMicrometers: "1",
        },
        objectCount: 1,
        bodyCount: 1,
        topology: { watertight: true, manifold: true, normals: "consistent" },
        thinWallFeatureCount: 0,
        supportVolumeRatioPpm: 0,
        hasPaintAssignments: false,
        materialAssignmentCount: 0,
        estimatedPrintSeconds: "60",
        estimatedMaterialMilligrams: "60",
        plateCount: 1,
      },
      plates: [
        {
          plateOrdinal: 1,
          partsOnPlate: 1,
          estimatedPrintSeconds: "60",
          estimatedMaterialMilligrams: "60",
        },
      ],
      occupancySlices: [
        {
          partsPerPlate: 1,
          cacheIdentitySha256,
          estimatedPrintSeconds: "60",
          estimatedMaterialMilligrams: "60",
          artifact: {
            objectKey: `slice-metrics/${cacheIdentitySha256}/result.json`,
            sha256: "c".repeat(64),
          },
        },
      ],
    });
    const failure = resultFor(job, {
      status: "failed",
      failureClass: "retryable_infrastructure",
      code: "ENGINE_TIMEOUT",
      retryable: true,
      message: "engine timed out",
      retryAfterMilliseconds: 1_000,
    });
    const dispatchId = fixtures.id(`${name}:outbox`);
    if (persistDispatch) {
      await client.query(
        `INSERT INTO arrangement_revisions (id, content_sha256)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [
          job.input.arrangementRevision.revisionId,
          job.input.arrangementRevision.contentSha256,
        ],
      );
      await client.query(
        'INSERT INTO "outbox_messages" ("id", "deduplication_key", "aggregate_type", "aggregate_id", "message_type", "schema_version", "payload", "status", "attempts", "available_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $10, $10)',
        [
          dispatchId,
          contracts.slicingDispatchAttemptKey(job.idempotencyKey, job.attempt),
          "CandidateEstimateDispatch",
          job.jobId,
          "slicing.candidate-estimate.requested",
          2,
          JSON.stringify({
            nodeId: foundation.nodeId,
            inventoryId: foundation.inventoryId,
            job,
          }),
          "PENDING",
          0,
          testTimes.createdAt,
        ],
      );
    }
    await client.query("COMMIT");
    return {
      dispatchId,
      nodeId: foundation.nodeId,
      inventoryId: foundation.inventoryId,
      job,
      success,
      failure,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function ingestInput(result: CandidateEstimateResult) {
  return {
    result,
    capacityWindows: [
      { startsAt: testTimes.capacityStart, endsAt: testTimes.capacityEnd },
    ],
    expiresAt: testTimes.expiresAt,
  };
}

function withMachineSlicerProfile(
  job: CandidateEstimateJob,
  slicerEngine: string,
  slicerVersion: string,
): CandidateEstimateJob {
  const input = {
    ...job.input,
    machineProfile: {
      ...job.input.machineProfile,
      slicerEngine,
      slicerVersion,
    },
  };
  const inputFingerprintSha256 = contracts.slicingInputFingerprint(
    "candidate_estimate",
    input,
  );
  return contracts.CandidateEstimateJobSchema.parse({
    ...job,
    input,
    inputFingerprintSha256,
    idempotencyKey: `slicer:v2:candidate_estimate:${job.jobId}:${inputFingerprintSha256}`,
  });
}

function retryWithCorrelation(
  job: CandidateEstimateJob,
  correlationId: string,
): CandidateEstimateJob {
  return contracts.CandidateEstimateJobSchema.parse({
    ...job,
    attempt: 2,
    correlationId,
  });
}

function redispatch(job: CandidateEstimateJob): CandidateEstimateJob {
  const jobId = randomUUID();
  return contracts.CandidateEstimateJobSchema.parse({
    ...job,
    jobId,
    correlationId: randomUUID(),
    idempotencyKey: `slicer:v2:candidate_estimate:${jobId}:${job.inputFingerprintSha256}`,
  });
}

async function terminalRows(dispatchId: string) {
  return pool.query<{
    outcome: string;
    candidate_resource_estimate_id: string | null;
    status: string;
  }>(
    `SELECT receipt.outcome::text,
            receipt.candidate_resource_estimate_id,
            message.status::text
     FROM candidate_estimate_terminal_results receipt
     JOIN outbox_messages message ON message.id = receipt.outbox_message_id
     WHERE receipt.outbox_message_id = $1`,
    [dispatchId],
  );
}

describe("candidate estimate terminal receipts", () => {
  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required for candidate estimate e2e tests",
      );
    }
    pool = new Pool({ connectionString: databaseUrl });
    prisma = new PrismaService();
    await prisma.onModuleInit();
    snapshots = new SlicerProfileSnapshotService(prisma, {
      putImmutableObject: async () => undefined,
    } as unknown as ObjectStorage);
    candidates = new CandidateEstimateService(prisma, snapshots);
    contracts = await import("@taven/slicer-contracts");
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await pool.end();
  });

  it("anchors every dispatched resource revision to its settings snapshot", async () => {
    const fixture = await createFixture("dispatch-slicer-identity", {
      persistDispatch: false,
      dispatchableGeometry: true,
    });
    const dispatch = (job: CandidateEstimateJob) =>
      candidates.dispatch({
        nodeId: fixture.nodeId,
        inventoryId: fixture.inventoryId,
        job,
      });

    for (const mismatch of [
      withMachineSlicerProfile(fixture.job, "mismatched-engine", "test"),
      withMachineSlicerProfile(fixture.job, "orca", "mismatched-version"),
    ]) {
      await expect(dispatch(mismatch)).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
    }
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM outbox_messages
         WHERE aggregate_id = $1`,
        [fixture.job.jobId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(dispatch(fixture.job)).resolves.toEqual(fixture.job);
    await expect(
      pool.query<{ content_sha256: string }>(
        `SELECT content_sha256
         FROM arrangement_revisions
         WHERE id = $1`,
        [fixture.job.input.arrangementRevision.revisionId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          content_sha256: fixture.job.input.arrangementRevision.contentSha256,
        },
      ],
    });

    const conflictingInput = {
      ...fixture.job.input,
      arrangementRevision: {
        ...fixture.job.input.arrangementRevision,
        contentSha256: hash("conflicting-arrangement-content"),
      },
    };
    const conflictingJobId = randomUUID();
    const conflictingFingerprint = contracts.slicingInputFingerprint(
      "candidate_estimate",
      conflictingInput,
    );
    const conflictingJob = contracts.CandidateEstimateJobSchema.parse({
      ...fixture.job,
      jobId: conflictingJobId,
      correlationId: randomUUID(),
      input: conflictingInput,
      inputFingerprintSha256: conflictingFingerprint,
      idempotencyKey: `slicer:v2:candidate_estimate:${conflictingJobId}:${conflictingFingerprint}`,
    });
    await expect(dispatch(conflictingJob)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM outbox_messages
         WHERE aggregate_id IN ($1, $2)`,
        [fixture.job.jobId, conflictingJob.jobId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("accepts a retry whose correlation ID changes without changing its effect", async () => {
    const fixture = await createFixture("retry-correlation", {
      persistDispatch: false,
      dispatchableGeometry: true,
    });
    const dispatch = (job: CandidateEstimateJob) =>
      candidates.dispatch({
        nodeId: fixture.nodeId,
        inventoryId: fixture.inventoryId,
        job,
      });

    await expect(dispatch(fixture.job)).resolves.toEqual(fixture.job);
    const firstDispatch = await pool.query<{ id: string }>(
      `SELECT id
       FROM outbox_messages
       WHERE aggregate_id = $1`,
      [fixture.job.jobId],
    );
    const firstDispatchId = firstDispatch.rows[0]?.id;
    if (!firstDispatchId) {
      throw new Error("first candidate retry dispatch was not persisted");
    }
    await pool.query(
      `INSERT INTO candidate_estimate_terminal_results (
         outbox_message_id,
         result_fingerprint_sha256,
         outcome,
         failure_class,
         failure_code
       ) VALUES ($1, $2, 'FAILED', $3, $4)`,
      [
        firstDispatchId,
        hash("retry-correlation:failure"),
        "retryable_infrastructure",
        "ENGINE_TIMEOUT",
      ],
    );

    const retry = retryWithCorrelation(fixture.job, randomUUID());
    expect(retry.correlationId).not.toBe(fixture.job.correlationId);
    await expect(dispatch(retry)).resolves.toEqual(retry);
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM outbox_messages
         WHERE aggregate_id = $1`,
        [fixture.job.jobId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });

    const retrySuccess = resultFor(retry, fixture.success.outcome);
    const ingested = await candidates.ingest(ingestInput(retrySuccess));
    expect(ingested).toMatchObject({
      status: "succeeded",
      replayed: false,
    });
    if (ingested.status !== "succeeded") {
      throw new Error("candidate retry success was not ingested");
    }
    await expect(candidates.ingest(ingestInput(retrySuccess))).resolves.toEqual(
      {
        ...ingested,
        replayed: true,
      },
    );
  });

  it("rejects a success delivered after a terminal failure", async () => {
    const fixture = await createFixture("failure-then-success");

    await expect(
      candidates.ingest(ingestInput(fixture.failure)),
    ).resolves.toEqual({
      status: "failed",
      jobId: fixture.job.jobId,
      failureClass: "retryable_infrastructure",
      code: "ENGINE_TIMEOUT",
    });
    await expect(
      candidates.ingest(ingestInput(fixture.success)),
    ).rejects.toBeInstanceOf(ResourceConflictError);
    expect((await terminalRows(fixture.dispatchId)).rows).toEqual([
      {
        outcome: "FAILED",
        candidate_resource_estimate_id: null,
        status: "PENDING",
      },
    ]);
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM candidate_resource_estimates
         WHERE resource_snapshot ->> 'dispatchJobId' = $1`,
        [fixture.job.jobId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      candidates.ingest(ingestInput(fixture.failure)),
    ).resolves.toEqual({
      status: "failed",
      jobId: fixture.job.jobId,
      failureClass: "retryable_infrastructure",
      code: "ENGINE_TIMEOUT",
    });
  });

  it("rejects a failure delivered after a terminal success and replays that success", async () => {
    const fixture = await createFixture("success-then-failure");

    const first = await candidates.ingest(ingestInput(fixture.success));
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    if (first.status !== "succeeded") {
      throw new Error("candidate success ingestion unexpectedly failed");
    }
    if (fixture.success.outcome.status !== "succeeded") {
      throw new Error("candidate success fixture unexpectedly failed");
    }
    await expect(
      candidates.ingest(ingestInput(fixture.failure)),
    ).rejects.toBeInstanceOf(ResourceConflictError);
    await expect(
      candidates.ingest(ingestInput(fixture.success)),
    ).resolves.toEqual({
      ...first,
      replayed: true,
    });
    const rows = (await terminalRows(fixture.dispatchId)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "SUCCEEDED",
      status: "PENDING",
    });
    expect(rows[0]?.candidate_resource_estimate_id).toBe(
      first.candidateResourceEstimateId,
    );
    await expect(
      pool.query<{ kind: string; artifact_object_key: string }>(
        `SELECT slice.kind::text, slice.artifact_object_key
         FROM candidate_estimate_terminal_results receipt
         JOIN candidate_resource_estimates candidate
           ON candidate.id = receipt.candidate_resource_estimate_id
         JOIN slice_results slice ON slice.id = candidate.slice_result_id
         WHERE receipt.outbox_message_id = $1`,
        [fixture.dispatchId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          kind: "ANALYSIS",
          artifact_object_key:
            fixture.success.outcome.occupancySlices[0]!.artifact.objectKey,
        },
      ],
    });
  });

  it("derives a future capacity window when queue reconciliation supplies only a success", async () => {
    const fixture = await createFixture("derived-capacity-window");
    if (fixture.success.outcome.status !== "succeeded") {
      throw new Error("candidate success fixture unexpectedly failed");
    }
    const successOutcome = fixture.success.outcome;

    const ingested = await candidates.ingest({ result: fixture.success });
    expect(ingested).toMatchObject({ status: "succeeded", replayed: false });
    const rows = await pool.query<{
      calculated_at: Date;
      expires_at: Date;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT candidate.calculated_at, candidate.expires_at,
              candidate_interval.starts_at, candidate_interval.ends_at
       FROM candidate_resource_estimates candidate
       JOIN candidate_capacity_intervals candidate_interval
         ON candidate_interval.candidate_resource_estimate_id = candidate.id
       WHERE candidate.resource_snapshot ->> 'dispatchJobId' = $1
       ORDER BY candidate_interval.interval_index`,
      [fixture.job.jobId],
    );
    expect(rows.rows).toHaveLength(successOutcome.plates.length);
    expect(
      rows.rows[0]!.expires_at.getTime() -
        rows.rows[0]!.calculated_at.getTime(),
    ).toBe(30 * 60 * 1_000);
    rows.rows.forEach((row, index) => {
      expect(row.starts_at.getTime()).toBeGreaterThanOrEqual(
        row.expires_at.getTime(),
      );
      expect(row.ends_at.getTime() - row.starts_at.getTime()).toBe(
        Number(
          BigInt(successOutcome.plates[index]!.estimatedPrintSeconds) * 1_000n,
        ),
      );
      if (index > 0) {
        expect(row.starts_at.getTime()).toBeGreaterThanOrEqual(
          rows.rows[index - 1]!.ends_at.getTime(),
        );
      }
    });
  });

  it("coordinates live candidate windows for the same order phase and machine", async () => {
    const fixture = await createFixture("coordinated-candidate-windows", {
      dispatchableGeometry: true,
    });
    if (fixture.success.outcome.status !== "succeeded") {
      throw new Error("candidate success fixture unexpectedly failed");
    }
    const first = await candidates.ingest({ result: fixture.success });
    if (first.status !== "succeeded") {
      throw new Error("first candidate ingestion unexpectedly failed");
    }

    const siblingJob = redispatch(fixture.job);
    await candidates.dispatch({
      nodeId: fixture.nodeId,
      inventoryId: fixture.inventoryId,
      job: siblingJob,
    });
    const sibling = await candidates.ingest({
      result: resultFor(siblingJob, fixture.success.outcome),
    });
    if (sibling.status !== "succeeded") {
      throw new Error("sibling candidate ingestion unexpectedly failed");
    }

    const rows = await pool.query<{
      candidate_resource_estimate_id: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT candidate_interval.candidate_resource_estimate_id,
              candidate_interval.starts_at,
              candidate_interval.ends_at
       FROM candidate_capacity_intervals candidate_interval
       WHERE candidate_interval.candidate_resource_estimate_id = ANY($1::uuid[])
       ORDER BY candidate_interval.starts_at, candidate_interval.interval_index`,
      [
        [
          first.candidateResourceEstimateId,
          sibling.candidateResourceEstimateId,
        ],
      ],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[1]!.starts_at.getTime()).toBeGreaterThanOrEqual(
      rows.rows[0]!.ends_at.getTime(),
    );
  });

  it("rejects caller-supplied windows that overlap live same-phase demand", async () => {
    const fixture = await createFixture("overlapping-candidate-window", {
      dispatchableGeometry: true,
    });
    if (fixture.success.outcome.status !== "succeeded") {
      throw new Error("candidate success fixture unexpectedly failed");
    }
    const first = await candidates.ingest({ result: fixture.success });
    if (first.status !== "succeeded") {
      throw new Error("first candidate ingestion unexpectedly failed");
    }
    const existing = await pool.query<{ starts_at: Date; ends_at: Date }>(
      `SELECT starts_at, ends_at
       FROM candidate_capacity_intervals
       WHERE candidate_resource_estimate_id = $1
       ORDER BY interval_index`,
      [first.candidateResourceEstimateId],
    );
    const siblingJob = redispatch(fixture.job);
    await candidates.dispatch({
      nodeId: fixture.nodeId,
      inventoryId: fixture.inventoryId,
      job: siblingJob,
    });

    await expect(
      candidates.ingest({
        result: resultFor(siblingJob, fixture.success.outcome),
        capacityWindows: existing.rows.map((window) => ({
          startsAt: window.starts_at,
          endsAt: window.ends_at,
        })),
      }),
    ).rejects.toBeInstanceOf(ResourceValidationError);
  });

  it("records a new resource snapshot after an equivalent candidate expires", async () => {
    const fixture = await createFixture("expired-candidate-refresh", {
      dispatchableGeometry: true,
    });
    const firstExpiresAt = new Date(Date.now() + 2_000);
    const firstCapacityWindows = [
      { startsAt: testTimes.capacityStart, endsAt: testTimes.capacityEnd },
    ];
    const firstInput = {
      result: fixture.success,
      capacityWindows: firstCapacityWindows,
      expiresAt: firstExpiresAt,
    };
    const first = await candidates.ingest(firstInput);
    if (first.status !== "succeeded") {
      throw new Error("initial candidate ingestion unexpectedly failed");
    }

    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.max(0, firstExpiresAt.getTime() - Date.now() + 25),
      );
    });

    const refreshedJob = redispatch(fixture.job);
    const refreshedSuccess = resultFor(refreshedJob, fixture.success.outcome);
    const refreshedCapacityWindows = [
      {
        startsAt: testTimes.capacityOneAndHalfHours,
        endsAt: testTimes.capacityTwoHours,
      },
    ];
    await expect(
      candidates.dispatch({
        nodeId: fixture.nodeId,
        inventoryId: fixture.inventoryId,
        job: refreshedJob,
      }),
    ).resolves.toEqual(refreshedJob);

    const refreshed = await candidates.ingest({
      result: refreshedSuccess,
      capacityWindows: refreshedCapacityWindows,
      expiresAt: testTimes.expiresAt,
    });
    expect(refreshed).toMatchObject({ status: "succeeded", replayed: false });
    if (refreshed.status !== "succeeded") {
      throw new Error("refreshed candidate ingestion unexpectedly failed");
    }
    expect(refreshed.candidateResourceEstimateId).not.toBe(
      first.candidateResourceEstimateId,
    );
    expect(refreshed.estimateKey).not.toBe(first.estimateKey);
    await expect(candidates.ingest(firstInput)).resolves.toEqual({
      ...first,
      replayed: true,
    });

    const snapshots = await pool.query<{
      dispatch_job_id: string;
      expires_at: Date;
      primary_slice_result_id: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT candidate.resource_snapshot ->> 'dispatchJobId' AS dispatch_job_id,
                candidate.expires_at,
                candidate.slice_result_id AS primary_slice_result_id,
                candidate_interval.starts_at,
                candidate_interval.ends_at
         FROM candidate_resource_estimates candidate
         JOIN candidate_capacity_intervals candidate_interval
           ON candidate_interval.candidate_resource_estimate_id = candidate.id
         WHERE candidate.id = ANY($1::uuid[])
         ORDER BY candidate.expires_at`,
      [
        [
          first.candidateResourceEstimateId,
          refreshed.candidateResourceEstimateId,
        ],
      ],
    );
    expect(snapshots.rows).toHaveLength(2);
    const [expired, fresh] = snapshots.rows;
    expect(expired).toMatchObject({
      dispatch_job_id: fixture.job.jobId,
      expires_at: firstExpiresAt,
      starts_at: firstCapacityWindows[0]!.startsAt,
      ends_at: firstCapacityWindows[0]!.endsAt,
    });
    expect(fresh).toMatchObject({
      dispatch_job_id: refreshedJob.jobId,
      starts_at: refreshedCapacityWindows[0]!.startsAt,
      ends_at: refreshedCapacityWindows[0]!.endsAt,
    });
    expect(expired?.primary_slice_result_id).toBe(
      fresh?.primary_slice_result_id,
    );
  });

  it("allows dispatch delivery without a receipt, then records the terminal result", async () => {
    const fixture = await createFixture("delivered-before-result");
    await pool.query(
      `UPDATE outbox_messages
       SET status = 'DELIVERED', delivered_at = clock_timestamp()
       WHERE id = $1`,
      [fixture.dispatchId],
    );
    expect((await terminalRows(fixture.dispatchId)).rows).toEqual([]);

    await expect(
      candidates.ingest(ingestInput(fixture.failure)),
    ).resolves.toEqual({
      status: "failed",
      jobId: fixture.job.jobId,
      failureClass: "retryable_infrastructure",
      code: "ENGINE_TIMEOUT",
    });
    expect((await terminalRows(fixture.dispatchId)).rows).toEqual([
      {
        outcome: "FAILED",
        candidate_resource_estimate_id: null,
        status: "DELIVERED",
      },
    ]);
  });
});
