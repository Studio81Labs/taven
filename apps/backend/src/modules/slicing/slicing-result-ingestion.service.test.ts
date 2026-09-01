import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type {
  CandidateEstimateResult,
  ModelInspectionResult,
  ProductionSliceResult,
  ReferenceSliceResult,
  SlicingJob,
} from "@taven/slicer-contracts" with { "resolution-mode": "import" };
import type { PrismaService } from "../../prisma/prisma.service";
import type { ObjectStorage } from "../storage/object-storage.port";
import {
  PermanentSlicingResultIngestionError,
  SlicingResultIngestionService,
} from "./slicing-result-ingestion.service";

const jobId = "00000000-0000-4000-8000-000000000002";
const dispatchId = "00000000-0000-4000-8000-000000000003";
const fingerprint = "a".repeat(64);
const artifactObjectKey = `gcode/${jobId}/toolpaths.gcode.3mf`;
const canonicalObjectKey = `geometries/${jobId}/canonical`;

function staleProductionHarness(input?: {
  receipt?: Record<string, unknown> | null;
  deleteObjects?: ReturnType<typeof vi.fn>;
}) {
  let receipt = input?.receipt ?? null;
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    job: { findUnique: vi.fn().mockResolvedValue(null) },
    outboxMessage: {
      findFirst: vi.fn(async () => receipt),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        receipt = data;
        return data;
      }),
    },
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    $transaction: async <T>(
      operation: (client: Prisma.TransactionClient) => Promise<T>,
    ) => operation(transaction),
  } as unknown as PrismaService;
  const deleteObjects =
    input?.deleteObjects ?? vi.fn().mockResolvedValue(undefined);
  const objects = { deleteObjects } as unknown as ObjectStorage;
  return {
    deleteObjects,
    service: new SlicingResultIngestionService(prisma, objects),
    transaction,
  };
}

function productionInput(outcome: "succeeded" | "failed") {
  const result = {
    contractVersion: 2,
    kind: "production_slice",
    jobId,
    outcome:
      outcome === "succeeded"
        ? {
            status: "succeeded",
            artifact: {
              format: "gcode_3mf",
              objectKey: artifactObjectKey,
              sha256: "b".repeat(64),
            },
          }
        : {
            status: "failed",
            failureClass: "deterministic_invalid",
            code: "INVALID_GEOMETRY",
          },
  } as unknown as ProductionSliceResult;
  return {
    dispatchId,
    job: { jobId } as SlicingJob,
    result,
    resultFingerprintSha256: fingerprint,
  };
}

function permanentFailureHarness(input?: {
  canonicalOwner?: boolean;
  sliceOwner?: boolean;
  deleteObjects?: ReturnType<typeof vi.fn>;
}) {
  const failure = new PermanentSlicingResultIngestionError(
    "immutable input was retired",
  );
  const modelGeometryFindUnique = vi
    .fn()
    .mockResolvedValue(input?.canonicalOwner ? { id: jobId } : null);
  const sliceResultFindUnique = vi
    .fn()
    .mockResolvedValue(input?.sliceOwner ? { id: jobId } : null);
  const prisma = {
    $transaction: vi.fn().mockRejectedValue(failure),
    modelGeometry: { findUnique: modelGeometryFindUnique },
    sliceResult: { findUnique: sliceResultFindUnique },
  } as unknown as PrismaService;
  const deleteObjects =
    input?.deleteObjects ?? vi.fn().mockResolvedValue(undefined);
  return {
    deleteObjects,
    failure,
    modelGeometryFindUnique,
    service: new SlicingResultIngestionService(prisma, {
      deleteObjects,
    } as unknown as ObjectStorage),
    sliceResultFindUnique,
  };
}

function permanentReferenceInput() {
  return {
    dispatchId,
    job: { jobId } as SlicingJob,
    result: {
      contractVersion: 2,
      kind: "reference_slice",
      jobId,
      outcome: {
        status: "succeeded",
        artifact: { objectKey: artifactObjectKey },
      },
    } as unknown as ReferenceSliceResult,
    resultFingerprintSha256: fingerprint,
  };
}

function permanentCanonicalInput() {
  return {
    dispatchId,
    job: { jobId } as SlicingJob,
    result: {
      contractVersion: 2,
      kind: "model_inspection",
      jobId,
      outcome: {
        status: "succeeded",
        canonicalGeometry: { canonicalObjectKey },
      },
    } as unknown as ModelInspectionResult,
    resultFingerprintSha256: fingerprint,
  };
}

describe("slicing result ingestion", () => {
  it("requires manual reconciliation while refund work is pending or suspended", async () => {
    const queryRaw = vi.fn(
      (strings: TemplateStringsArray): Promise<Array<{ safe: boolean }>> => {
        expect(strings.join("?")).toContain(
          "refund.status IN ('PENDING', 'SUSPENDED')",
        );
        return Promise.resolve([{ safe: false }]);
      },
    );
    const transaction = {
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;
    const service = new SlicingResultIngestionService(
      {} as unknown as PrismaService,
      {} as unknown as ObjectStorage,
    ) as unknown as {
      canCancelPreProductionOrder(
        transaction: Prisma.TransactionClient,
        orderId: string,
        failedJobId: string,
      ): Promise<boolean>;
    };

    await expect(
      service.canCancelPreProductionOrder(
        transaction,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).resolves.toBe(false);
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it("deletes a successful production artifact when its Job is stale", async () => {
    const harness = staleProductionHarness();

    await expect(
      harness.service.ingest(productionInput("succeeded")),
    ).resolves.toBeUndefined();

    expect(harness.deleteObjects).toHaveBeenCalledWith([artifactObjectKey]);
    expect(harness.transaction.outboxMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            materialization: {
              status: "stale",
              reason: "job-no-longer-exists",
              cleanupArtifactObjectKey: artifactObjectKey,
            },
          }),
        }),
      }),
    );
  });

  it("retries durable stale-artifact cleanup after object storage fails", async () => {
    const deleteObjects = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);
    const harness = staleProductionHarness({ deleteObjects });
    const input = productionInput("succeeded");

    await expect(harness.service.ingest(input)).rejects.toThrow(
      "storage unavailable",
    );
    await expect(harness.service.ingest(input)).resolves.toBeUndefined();

    expect(deleteObjects).toHaveBeenCalledTimes(2);
    expect(harness.transaction.outboxMessage.create).toHaveBeenCalledOnce();
  });

  it("does not delete artifacts for failed or materialized results", async () => {
    const failedHarness = staleProductionHarness();
    await failedHarness.service.ingest(productionInput("failed"));
    expect(failedHarness.deleteObjects).not.toHaveBeenCalled();

    const materializedHarness = staleProductionHarness({
      receipt: {
        payload: {
          resultFingerprintSha256: fingerprint,
          materialization: { status: "materialized", sliceResultId: jobId },
        },
      },
    });
    await materializedHarness.service.ingest(productionInput("succeeded"));
    expect(materializedHarness.deleteObjects).not.toHaveBeenCalled();
  });

  it("deletes unowned reference and canonical artifacts after permanent rejection", async () => {
    const reference = permanentFailureHarness();
    await expect(
      reference.service.ingest(permanentReferenceInput()),
    ).rejects.toBe(reference.failure);
    expect(reference.sliceResultFindUnique).toHaveBeenCalledWith({
      where: { artifactObjectKey },
      select: { id: true },
    });
    expect(reference.deleteObjects).toHaveBeenCalledWith([artifactObjectKey]);

    const canonical = permanentFailureHarness();
    await expect(
      canonical.service.ingest(permanentCanonicalInput()),
    ).rejects.toBe(canonical.failure);
    expect(canonical.modelGeometryFindUnique).toHaveBeenCalledWith({
      where: { canonicalObjectKey },
      select: { id: true },
    });
    expect(canonical.deleteObjects).toHaveBeenCalledWith([canonicalObjectKey]);
  });

  it("retries permanent-result cleanup when object storage is unavailable", async () => {
    const deleteObjects = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);
    const harness = permanentFailureHarness({ deleteObjects });
    const input = permanentReferenceInput();

    await expect(harness.service.ingest(input)).rejects.toThrow(
      "storage unavailable",
    );
    await expect(harness.service.ingest(input)).rejects.toBe(harness.failure);

    expect(deleteObjects).toHaveBeenCalledTimes(2);
  });

  it("preserves permanently rejected artifacts that already have an owner", async () => {
    const reference = permanentFailureHarness({ sliceOwner: true });
    await expect(
      reference.service.ingest(permanentReferenceInput()),
    ).rejects.toBe(reference.failure);
    expect(reference.deleteObjects).not.toHaveBeenCalled();

    const canonical = permanentFailureHarness({ canonicalOwner: true });
    await expect(
      canonical.service.ingest(permanentCanonicalInput()),
    ).rejects.toBe(canonical.failure);
    expect(canonical.deleteObjects).not.toHaveBeenCalled();
  });

  it("deletes only unowned candidate metric artifacts", async () => {
    const ownedObjectKey = `slice-metrics/${"c".repeat(64)}/result.json`;
    const unownedObjectKey = `slice-metrics/${"d".repeat(64)}/result.json`;
    const findUnique = vi
      .fn()
      .mockImplementation(
        ({ where }: { where: { artifactObjectKey: string } }) =>
          Promise.resolve(
            where.artifactObjectKey === ownedObjectKey ? { id: jobId } : null,
          ),
      );
    const deleteObjects = vi.fn().mockResolvedValue(undefined);
    const service = new SlicingResultIngestionService(
      {
        sliceResult: { findUnique },
      } as unknown as PrismaService,
      { deleteObjects } as unknown as ObjectStorage,
    );
    const result = {
      kind: "candidate_estimate",
      outcome: {
        status: "succeeded",
        occupancySlices: [
          { artifact: { objectKey: ownedObjectKey } },
          { artifact: { objectKey: unownedObjectKey } },
        ],
      },
    } as unknown as CandidateEstimateResult;

    await service.deleteUnownedUploadedArtifacts(result);

    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(deleteObjects).toHaveBeenCalledWith([unownedObjectKey]);
  });

  it("rejects aggregate canonical volume that cannot fit PostgreSQL bigint", async () => {
    const findMany = vi.fn();
    const create = vi.fn();
    const transaction = {
      modelFile: { findFirst: vi.fn().mockResolvedValue({ id: jobId }) },
      modelGeometry: { findMany, create },
    } as unknown as Prisma.TransactionClient;
    const service = new SlicingResultIngestionService(
      {} as PrismaService,
      {} as ObjectStorage,
    ) as unknown as {
      ingestInspection(
        transaction: Prisma.TransactionClient,
        result: ModelInspectionResult,
        resultFingerprintSha256: string,
      ): Promise<Prisma.InputJsonObject>;
    };
    const result = {
      kind: "model_inspection",
      input: {
        source: {
          modelFileId: jobId,
          objectKey: "models/source",
          contentSha256: "b".repeat(64),
        },
        operation: {
          mode: "canonicalize_selection",
          bodyIds: ["body-0001", "body-0002"],
        },
        canonicalizerRevision: "canonicalizer-v1",
      },
      outcome: {
        status: "succeeded",
        canonicalGeometry: {
          modelGeometryId: jobId,
          canonicalObjectKey,
          geometrySha256: "c".repeat(64),
          bodyIds: ["body-0001", "body-0002"],
          selectionSha256: "d".repeat(64),
          appliedUnitConversion: {
            sourceUnit: "millimeter",
            targetUnit: "millimeter",
            scaleFactorPpm: 1_000_000,
          },
        },
        bodies: [
          {
            volumeCubicMicrometers: "9223372036854775807",
            triangleCount: 1,
          },
          { volumeCubicMicrometers: "1", triangleCount: 1 },
        ],
        metrics: {
          boundingBox: {
            xMicrometers: "1",
            yMicrometers: "1",
            zMicrometers: "1",
          },
        },
      },
    } as unknown as ModelInspectionResult;

    await expect(
      service.ingestInspection(transaction, result, fingerprint),
    ).rejects.toThrow(
      "canonical geometry aggregate volume exceeds PostgreSQL bigint",
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
