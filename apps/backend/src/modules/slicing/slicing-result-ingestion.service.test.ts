import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type {
  ProductionSliceResult,
  SlicingJob,
} from "@taven/slicer-contracts" with { "resolution-mode": "import" };
import type { PrismaService } from "../../prisma/prisma.service";
import type { ObjectStorage } from "../storage/object-storage.port";
import { SlicingResultIngestionService } from "./slicing-result-ingestion.service";

const jobId = "00000000-0000-4000-8000-000000000002";
const dispatchId = "00000000-0000-4000-8000-000000000003";
const fingerprint = "a".repeat(64);
const artifactObjectKey = `gcode/${jobId}/toolpaths.gcode.3mf`;

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
});
