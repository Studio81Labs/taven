import { JobStatus, RetentionHold, SliceKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../prisma/prisma.service";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import type { AuditService } from "../audit/audit.service";
import { slicerSettingsSnapshot } from "../slicing/slicer-profile-snapshot.service";
import type {
  ObjectStorage,
  StoredObjectMetadata,
} from "../storage/object-storage.port";
import type { ObjectStorageConfig } from "../storage/storage.config";
import { OperatorJobArtifactsService } from "./operator-job-artifacts.service";

const jobId = "11111111-1111-4111-8111-111111111111";
const nodeId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const phaseId = "44444444-4444-4444-8444-444444444444";
const shipmentPlanId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const geometryId = "55555555-5555-4555-8555-555555555555";
const configId = "66666666-6666-4666-8666-666666666666";
const profileId = "77777777-7777-4777-8777-777777777777";
const calibrationId = "88888888-8888-4888-8888-888888888888";
const arrangementId = "15151515-1515-4515-8515-151515151515";
const sourceId = "99999999-9999-4999-8999-999999999999";
const resultId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceHash = "a".repeat(64);
const productionHash = "b".repeat(64);

const operator: OperatorContext = {
  operatorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "VIEWER",
  permissions: [OPERATOR_PERMISSIONS.OPERATIONS_READ],
  nodeIds: [nodeId],
  authenticationMethod: "DEVELOPMENT_PASSWORD",
  sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

function harness() {
  const sourceDeleteAfter = new Date(Date.now() + 30_000);
  const job = {
    id: jobId,
    nodeId,
    orderId,
    orderPhaseId: phaseId,
    shipmentPlanId,
    shipmentPlan: { ordinal: 0 },
    shipmentAssignment: null,
    order: {
      publicReference: "TAVEN-TEST",
      individualOrigin: null,
      automaticQuoteDraft: null as null | {
        items: Array<Record<string, unknown>>;
      },
    },
    replacesJobId: null,
    replacementJob: null,
    replacementRequestSource: null,
    replacementRequestResult: null,
    status: JobStatus.CREATED as JobStatus,
    gcodeReadyAt: null as Date | null,
    productionArtifactHash: null as string | null,
    productionSliceResult: null as null | Record<string, unknown>,
    productionReservations: [] as Array<{
      productionSliceResultId: string | null;
    }>,
    phaseResourcePlanJob: {
      candidateResourceEstimate: {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        quantity: 1,
        shipmentPlanId,
        modelGeometryId: geometryId,
        printConfigRevisionId: configId,
        machineProfileId: profileId,
        machineCalibrationId: calibrationId,
        arrangementRevisionId: arrangementId,
        partsPerPlate: 1,
        machineId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        requiredMachineSeconds: 3600n,
        requiredMaterialMilligrams: 25000n,
        calculatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      slots: [
        {
          fulfilmentSlot: {
            id: "12121212-1212-4212-8212-121212121212",
            orderId,
            orderPhaseId: phaseId,
            quantityOrdinal: 1,
            shipmentPlanAllocations: [{ shipmentPlanId }],
            orderItem: {
              id: "13131313-1313-4313-8313-131313131313",
              ordinal: 0,
              sourceModelFileId: sourceId,
              modelGeometryId: geometryId,
              printConfigRevisionId: configId,
              referencePartsPerPlate: 1,
              quantity: 1,
              primaryReferenceSliceResult: {
                kind: SliceKind.REFERENCE,
                modelGeometryId: geometryId,
                printConfigRevisionId: configId,
                referenceProfileId: profileId,
                partsPerPlate: 1,
              },
              tailReferenceSliceResult: null,
              material: "PLA",
              color: "BLACK",
              sourceModelFile: {
                id: sourceId,
                storageObjectKey: "models/exact-source.stl",
                contentHash: sourceHash,
                deletedAt: null as Date | null,
                retentionHold: RetentionHold.NONE as RetentionHold,
                sourceDeleteAfter,
              },
              modelGeometry: {
                deletedAt: null as Date | null,
                boundsXMicrometers: 1000n,
                boundsYMicrometers: 2000n,
                boundsZMicrometers: 3000n,
                volumeCubicMicrometers: 4000n,
                geometryHash: "c".repeat(64),
                canonicalObjectKey: "geometries/exact-source.3mf",
              },
            },
          },
        },
      ],
    },
  };
  const findFirst = vi.fn(async ({ where }: { where: { nodeId: string } }) =>
    where.nodeId === nodeId ? job : null,
  );
  const recordOperator = vi.fn(async () => undefined);
  const headObject = vi.fn(
    async (key: string): Promise<StoredObjectMetadata | null> => ({
      contentType: key.startsWith("models/") ? "model/stl" : "text/x-gcode",
      contentLength: 42,
      contentHash: key.startsWith("models/") ? sourceHash : productionHash,
    }),
  );
  const createDownloadUrl = vi.fn(
    async ({ expiresAt }: { objectKey: string; expiresAt: Date }) => ({
      url: "https://storage.example.test/opaque-signed-url",
      method: "GET" as const,
      requiredHeaders: {},
      expiresAt,
    }),
  );
  const prisma = {
    job: { findFirst },
    $transaction: async (callback: (tx: object) => Promise<unknown>) =>
      callback({}),
  } as unknown as PrismaService;
  const service = new OperatorJobArtifactsService(
    prisma,
    { recordOperator } as unknown as AuditService,
    { headObject, createDownloadUrl } as unknown as ObjectStorage,
    { signedUrlTtlSeconds: 900 } as ObjectStorageConfig,
  );
  return {
    job,
    service,
    findFirst,
    recordOperator,
    headObject,
    createDownloadUrl,
    sourceDeleteAfter,
  };
}

describe("operator job artifact downloads", () => {
  it("reports plate count from the frozen estimate for a multi-plate job", async () => {
    const test = harness();
    const planned = test.job.phaseResourcePlanJob;
    planned.candidateResourceEstimate.quantity = 2;
    planned.slots.push({
      fulfilmentSlot: {
        ...planned.slots[0]!.fulfilmentSlot,
        id: "16161616-1616-4616-8616-161616161616",
        quantityOrdinal: 2,
      },
    });
    await expect(test.service.detail(operator, jobId)).resolves.toMatchObject({
      estimate: { quantity: 2, partsPerPlate: 1, plateCount: 2 },
    });
  });

  it("returns exact job, parcel, geometry and accepted risk evidence", async () => {
    const test = harness();
    test.job.order.automaticQuoteDraft = {
      items: [
        {
          ordinal: 0,
          sourceModelFileId: sourceId,
          bodyIds: ["body-1"],
          selectionSha256: "d".repeat(64),
          targetModelGeometryId: geometryId,
          printConfigRevisionId: configId,
          referenceProfileId: profileId,
          referencePartsPerPlate: 1,
          quantity: 1,
          configurationFingerprint: "current",
          referenceProfile: {
            settings: {},
            slicerEngine: "orcaslicer",
            slicerVersion: "2.4.2",
          },
          printConfigRevision: { settings: {} },
          riskDecisions: [
            {
              configurationFingerprint: "current",
              preflightFindingId: "14141414-1414-4414-8414-141414141414",
              acknowledgementKey: "ack-test",
              preflightFinding: {
                modelFileId: sourceId,
                modelGeometryId: geometryId,
                inspectionRevision: "inspection-v1",
                code: "THIN_WALL",
                severity: "WARNING",
                message: "Thin wall detected",
              },
            },
          ],
        },
      ],
    };
    await expect(test.service.detail(operator, jobId)).resolves.toMatchObject({
      shipmentPlanId,
      shipmentId: null,
      slots: [
        {
          volumeCubicMicrometers: "4000",
          geometrySha256: "c".repeat(64),
          acceptedRisks: [
            {
              code: "THIN_WALL",
              acknowledgementKey: "ack-test",
            },
          ],
        },
      ],
    });
    const decisions = test.job.order.automaticQuoteDraft!.items[0]!
      .riskDecisions as Array<{
      preflightFinding: { modelFileId: string; inspectionRevision: string };
    }>;
    decisions[0]!.preflightFinding.modelFileId = phaseId;
    expect(
      (await test.service.detail(operator, jobId)).slots[0]!.acceptedRisks,
    ).toEqual([]);
    decisions[0]!.preflightFinding.modelFileId = sourceId;
    decisions[0]!.preflightFinding.inspectionRevision = "foreign-revision";
    expect(
      (await test.service.detail(operator, jobId)).slots[0]!.acceptedRisks,
    ).toEqual([]);
    const { slicingInputFingerprint } = await import("@taven/slicer-contracts");
    decisions[0]!.preflightFinding.inspectionRevision = slicingInputFingerprint(
      "reference_slice",
      {
        geometry: {
          sourceModelFileId: sourceId,
          sourceContentSha256: sourceHash,
          modelGeometryId: geometryId,
          canonicalObjectKey: "geometries/exact-source.3mf",
          geometrySha256: "c".repeat(64),
          bodyIds: ["body-1"],
          selectionSha256: "d".repeat(64),
        },
        referenceProfile: {
          revisionId: profileId,
          contentSha256: slicerSettingsSnapshot({}).contentSha256,
          slicerEngine: "orcaslicer",
          slicerVersion: "2.4.2",
        },
        printConfig: {
          revisionId: configId,
          contentSha256: slicerSettingsSnapshot({}).contentSha256,
        },
        partsPerPlate: 1,
      },
    );
    expect(
      (await test.service.detail(operator, jobId)).slots[0]!.acceptedRisks,
    ).toHaveLength(1);
  });

  it("scopes the exact source, caps URL expiry by retention and audits without URL/key", async () => {
    const test = harness();
    const result = await test.service.download(operator, jobId, "SOURCE_MODEL");
    expect(result).toMatchObject({
      contentType: "model/stl",
      contentLength: "42",
      sha256: sourceHash,
    });
    expect(new Date(result.expiresAt).getTime()).toBeLessThanOrEqual(
      test.sourceDeleteAfter.getTime(),
    );
    expect(test.headObject).toHaveBeenCalledWith("models/exact-source.stl");
    expect(test.recordOperator).toHaveBeenCalledOnce();
    const auditPayload = JSON.stringify(test.recordOperator.mock.calls[0]);
    expect(auditPayload).not.toContain("opaque-signed-url");
    expect(auditPayload).not.toContain("models/exact-source.stl");
  });

  it("rejects deleted, expired, missing and wrong-hash source bytes", async () => {
    const deleted = harness();
    deleted.job.phaseResourcePlanJob.slots[0]!.fulfilmentSlot.orderItem.sourceModelFile.deletedAt =
      new Date();
    await expect(
      deleted.service.download(operator, jobId, "SOURCE_MODEL"),
    ).rejects.toMatchObject({ status: 410 });
    expect(deleted.headObject).not.toHaveBeenCalled();

    const expired = harness();
    expired.job.phaseResourcePlanJob.slots[0]!.fulfilmentSlot.orderItem.sourceModelFile.sourceDeleteAfter =
      new Date(Date.now() - 1_000);
    await expect(
      expired.service.download(operator, jobId, "SOURCE_MODEL"),
    ).rejects.toMatchObject({ status: 410 });

    const missing = harness();
    missing.headObject.mockResolvedValueOnce(null);
    await expect(
      missing.service.download(operator, jobId, "SOURCE_MODEL"),
    ).rejects.toMatchObject({ status: 410 });

    const mismatch = harness();
    mismatch.headObject.mockResolvedValueOnce({
      contentType: "model/stl",
      contentLength: 42,
      contentHash: "c".repeat(64),
    });
    await expect(
      mismatch.service.download(operator, jobId, "SOURCE_MODEL"),
    ).rejects.toMatchObject({ status: 409 });
    expect(mismatch.createDownloadUrl).not.toHaveBeenCalled();
    expect(mismatch.recordOperator).not.toHaveBeenCalled();
  });

  it("honors an active claim retention hold on the exact source", async () => {
    const test = harness();
    const source =
      test.job.phaseResourcePlanJob.slots[0]!.fulfilmentSlot.orderItem
        .sourceModelFile;
    source.retentionHold = RetentionHold.ACTIVE_CLAIM;
    source.sourceDeleteAfter = new Date(Date.now() - 1_000);
    await expect(
      test.service.download(operator, jobId, "SOURCE_MODEL"),
    ).resolves.toMatchObject({ sha256: sourceHash });
    expect(test.headObject).toHaveBeenCalledWith(source.storageObjectKey);
  });

  it("returns storage outages as 503 without issuing a URL or audit", async () => {
    const test = harness();
    test.headObject.mockRejectedValueOnce(new Error("storage offline"));
    await expect(
      test.service.download(operator, jobId, "SOURCE_MODEL"),
    ).rejects.toMatchObject({ status: 503 });
    expect(test.createDownloadUrl).not.toHaveBeenCalled();
    expect(test.recordOperator).not.toHaveBeenCalled();
  });

  it("requires an eligible job and matching sealed production lineage", async () => {
    const test = harness();
    await expect(
      test.service.download(operator, jobId, "PRODUCTION"),
    ).rejects.toMatchObject({ status: 409 });
    test.job.status = JobStatus.GCODE_READY;
    test.job.gcodeReadyAt = new Date();
    test.job.productionArtifactHash = productionHash;
    test.job.productionSliceResult = {
      id: resultId,
      kind: SliceKind.PRODUCTION,
      modelGeometryId: geometryId,
      printConfigRevisionId: configId,
      machineProfileId: profileId,
      machineCalibrationId: calibrationId,
      arrangementRevisionId: arrangementId,
      packageQuantity: 1,
      partsPerPlate: 1,
      artifactObjectKey: "production/exact-job.gcode",
      artifactHash: productionHash,
    };
    await expect(
      test.service.download(operator, jobId, "PRODUCTION"),
    ).rejects.toMatchObject({ status: 409 });
    test.job.productionReservations = [{ productionSliceResultId: resultId }];
    const result = await test.service.download(operator, jobId, "PRODUCTION");
    expect(result.sha256).toBe(productionHash);
    expect(test.headObject).toHaveBeenCalledWith("production/exact-job.gcode");
    test.job.productionSliceResult!.arrangementRevisionId = phaseId;
    await expect(
      test.service.download(operator, jobId, "PRODUCTION"),
    ).rejects.toMatchObject({ status: 409 });
    test.job.productionSliceResult!.arrangementRevisionId = arrangementId;
    test.job.status = JobStatus.SETTLED;
    await expect(
      test.service.download(operator, jobId, "PRODUCTION"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("enforces input, permission and node scope before storage access", async () => {
    const test = harness();
    await expect(
      test.service.download(operator, jobId, "UNLISTED"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      test.service.download(operator, "invalid", "SOURCE_MODEL"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      test.service.download(
        { ...operator, permissions: [] },
        jobId,
        "SOURCE_MODEL",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      test.service.download(
        { ...operator, nodeIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"] },
        jobId,
        "SOURCE_MODEL",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(test.headObject).not.toHaveBeenCalled();
  });

  it("rejects a slot outside the job shipment plan before storage access", async () => {
    const test = harness();
    test.job.phaseResourcePlanJob.slots[0]!.fulfilmentSlot.shipmentPlanAllocations =
      [];
    await expect(
      test.service.download(operator, jobId, "SOURCE_MODEL"),
    ).rejects.toMatchObject({ status: 409 });
    expect(test.headObject).not.toHaveBeenCalled();
  });
});
