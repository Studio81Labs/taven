import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type {
  CandidateEstimateJob,
  CandidateEstimateResult,
} from "@taven/slicer-contracts" with { "resolution-mode": "import" };
import { CandidateEstimateService } from "../src/modules/resources/candidate-estimate.service";
import { ResourceConflictError } from "../src/modules/resources/resource-errors";
import { PrismaService } from "../src/prisma/prisma.service";
import { PersistenceFactory, testTimes } from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const testScope = `candidate-estimate-${randomUUID()}`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

let pool: Pool;
let prisma: PrismaService;
let candidates: CandidateEstimateService;
let contracts: typeof import("@taven/slicer-contracts", {
  with: { "resolution-mode": "import" },
});

type CandidateFixture = {
  dispatchId: string;
  job: CandidateEstimateJob;
  success: CandidateEstimateResult;
  failure: CandidateEstimateResult;
};

function revisionDigest(id: string): string {
  return hash(`revision:${id}`);
}

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

async function createFixture(name: string): Promise<CandidateFixture> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fixtures = new PersistenceFactory(client, `${testScope}:${name}`);
    const foundation = await fixtures.createFoundation(name);
    const bodyIds = ["body-1"];
    const geometry = {
      sourceModelFileId: foundation.modelFileId,
      sourceContentSha256: "a".repeat(64),
      modelGeometryId: foundation.modelGeometryId,
      canonicalObjectKey: `geometries/${foundation.modelGeometryId}/canonical`,
      geometrySha256: hash(`${name}:geometry:0`),
      bodyIds,
      selectionSha256: contracts.geometrySelectionSha256(bodyIds),
    };
    const inputBase = {
      geometry,
      machineId: foundation.machineId,
      machineProfile: {
        revisionId: foundation.machineProfileId,
        contentSha256: revisionDigest(foundation.machineProfileId),
        slicerEngine: "orca",
        slicerVersion: "test",
        productionArtifactFormat: "gcode_3mf" as const,
      },
      machineCalibration: {
        revisionId: foundation.machineCalibrationId,
        contentSha256: revisionDigest(foundation.machineCalibrationId),
      },
      printConfig: {
        revisionId: foundation.printConfigRevisionId,
        contentSha256: revisionDigest(foundation.printConfigRevisionId),
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
    await client.query("COMMIT");
    return { dispatchId, job, success, failure };
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
    candidates = new CandidateEstimateService(prisma);
    contracts = await import("@taven/slicer-contracts");
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await pool.end();
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
        status: "DELIVERED",
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
      status: "DELIVERED",
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
});
