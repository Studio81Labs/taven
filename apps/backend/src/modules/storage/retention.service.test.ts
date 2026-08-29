import { describe, expect, it } from "vitest";
import { RetentionAssetKind, RetentionDeletionJobStatus } from "@prisma/client";
import { RetentionService } from "./retention.service";
import type { ObjectStorage } from "./object-storage.port";

describe("RetentionService deletion claim recovery", () => {
  it("releases a failed claim so a deadline or hold can be changed before retry", async () => {
    const assetId = "00000000-0000-0000-0000-000000000001";
    const jobId = "00000000-0000-0000-0000-000000000002";
    const deadline = new Date(Date.now() - 1_000);
    const state: {
      claim: string | null;
      deadline: Date;
      status: RetentionDeletionJobStatus;
      attempts: number;
      leaseToken: string | null;
    } = {
      claim: jobId as string | null,
      deadline,
      status: RetentionDeletionJobStatus.PENDING,
      attempts: 0,
      leaseToken: null,
    };
    let deleteAttempts = 0;
    let headFails = false;
    const storage: ObjectStorage = {
      createUploadUrl: async () => ({
        url: "",
        method: "PUT",
        requiredHeaders: {},
        expiresAt: new Date(),
      }),
      createDownloadUrl: async () => ({
        url: "",
        method: "GET",
        requiredHeaders: {},
        expiresAt: new Date(),
      }),
      headObject: async () => {
        if (headFails) throw new Error("head unavailable");
        return {
          contentType: "model/stl",
          contentLength: 84,
          contentHash: "a".repeat(64),
        };
      },
      readObjectRange: async () => new Uint8Array(),
      copyObject: async () => undefined,
      deleteObjects: async () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("temporary outage");
      },
    };
    const job = () => ({
      id: jobId,
      asset_kind: RetentionAssetKind.MODEL_FILE,
      asset_id: assetId,
      expected_delete_after: state.deadline,
      status: state.status,
      attempts: state.attempts,
    });
    const transaction = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(" ");
        if (sql.includes("FROM retention_deletion_jobs")) {
          if (sql.includes("status = 'PROCESSING'")) {
            return state.status === RetentionDeletionJobStatus.PROCESSING
              ? [job()]
              : [];
          }
          return state.status === RetentionDeletionJobStatus.PENDING ||
            state.status === RetentionDeletionJobStatus.FAILED
            ? [job()]
            : [];
        }
        if (sql.includes("FROM model_files")) {
          return [
            {
              storage_object_key: "model/source",
              source_delete_after: state.deadline,
              retention_hold: "NONE",
              deleted_at: null,
              retention_deletion_job_id: state.claim,
            },
          ];
        }
        return [];
      },
      retentionDeletionJob: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          if (data.status)
            state.status = data.status as RetentionDeletionJobStatus;
          if ("attempts" in data && typeof data.attempts === "object")
            state.attempts += 1;
          if ("leaseToken" in data)
            state.leaseToken = data.leaseToken as string | null;
          return job();
        },
        findFirst: async () =>
          state.status === RetentionDeletionJobStatus.PROCESSING
            ? { ...job(), leaseToken: state.leaseToken }
            : null,
      },
      modelFile: {
        update: async () => {
          state.claim = jobId;
          return {};
        },
        updateMany: async () => {
          state.claim = null;
          return { count: 1 };
        },
      },
      photoAsset: { updateMany: async () => ({ count: 0 }) },
    };
    const prisma = {
      $transaction: async <T>(
        callback: (tx: typeof transaction) => Promise<T>,
      ) => callback(transaction),
    };

    // The first pass claims and fails; the service must release the claim.
    const service = new RetentionService(prisma as never, storage);
    expect(await service.runOnce(1)).toBe(1);
    expect(state.status).toBe(RetentionDeletionJobStatus.FAILED);
    expect(state.claim).toBeNull();

    // A caller can now extend the deadline/hold without the old claim blocking it.
    state.deadline = new Date(Date.now() + 60_000);
    expect(state.claim).toBeNull();

    // Unknown object-store state is conservative: the retry remains claimed,
    // so a hold cannot race a deletion whose result could not be inspected.
    state.deadline = new Date(Date.now() - 1_000);
    state.status = RetentionDeletionJobStatus.PENDING;
    state.claim = jobId;
    state.attempts = 0;
    state.leaseToken = null;
    deleteAttempts = 0;
    headFails = true;
    expect(await service.runOnce(1)).toBe(1);
    expect(state.status).toBe(RetentionDeletionJobStatus.FAILED);
    expect(state.claim).toBe(jobId);
  });
});
