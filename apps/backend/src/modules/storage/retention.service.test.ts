import { describe, expect, it } from "vitest";
import { RetentionAssetKind, RetentionDeletionJobStatus } from "@prisma/client";
import { RetentionService } from "./retention.service";
import type { ObjectStorage } from "./object-storage.port";

describe("RetentionService deletion claim recovery", () => {
  it("continues past a stale due row to a valid deletion in the same bounded batch", async () => {
    const deadline = new Date(Date.now() - 1_000);
    const staleJobId = "00000000-0000-0000-0000-000000000010";
    const uploadJobId = "00000000-0000-0000-0000-000000000011";
    const uploadId = "00000000-0000-0000-0000-000000000012";
    const jobs: Array<{
      id: string;
      asset_kind: RetentionAssetKind;
      asset_id: string;
      expected_delete_after: Date;
      status: RetentionDeletionJobStatus;
      attempts: number;
      leaseToken: string | null;
    }> = [
      {
        id: staleJobId,
        asset_kind: RetentionAssetKind.MODEL_GEOMETRY,
        asset_id: "00000000-0000-0000-0000-000000000013",
        expected_delete_after: deadline,
        status: RetentionDeletionJobStatus.PENDING,
        attempts: 0,
        leaseToken: null,
      },
      {
        id: uploadJobId,
        asset_kind: RetentionAssetKind.UPLOAD_INTENT,
        asset_id: uploadId,
        expected_delete_after: deadline,
        status: RetentionDeletionJobStatus.PENDING,
        attempts: 0,
        leaseToken: null,
      },
    ];
    const deleted: string[][] = [];
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
      headObject: async () => null,
      readObjectRange: async () => new Uint8Array(),
      copyObject: async () => undefined,
      deleteObjects: async (keys) => {
        deleted.push([...keys]);
      },
    };
    const transaction = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(" ");
        if (sql.includes("FROM retention_deletion_jobs")) {
          if (sql.includes("status = 'PROCESSING'")) return [];
          const next = jobs.find(
            ({ status }) =>
              status === RetentionDeletionJobStatus.PENDING ||
              status === RetentionDeletionJobStatus.FAILED,
          );
          return next ? [next] : [];
        }
        if (sql.includes("FROM upload_intents")) {
          return [
            {
              status: "PENDING",
              expires_at: deadline,
              quarantine_object_key: "quarantine/upload",
              final_object_key: "final/upload",
            },
          ];
        }
        return [];
      },
      retentionDeletionJob: {
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const job = jobs.find(({ id }) => id === where.id);
          if (!job) throw new Error("unknown job");
          if (data.status)
            job.status = data.status as RetentionDeletionJobStatus;
          if (data.leaseToken !== undefined)
            job.leaseToken = data.leaseToken as string | null;
          if ("attempts" in data) job.attempts += 1;
          return job;
        },
        findFirst: async ({ where }: { where: { id: string } }) => {
          const job = jobs.find(({ id }) => id === where.id);
          return job?.status === RetentionDeletionJobStatus.PROCESSING
            ? job
            : null;
        },
      },
      uploadIntent: { update: async () => ({}) },
      modelFile: { updateMany: async () => ({ count: 0 }) },
      photoAsset: { updateMany: async () => ({ count: 0 }) },
    };
    const prisma = {
      $transaction: async <T>(
        callback: (tx: typeof transaction) => Promise<T>,
      ) => callback(transaction),
    };

    const service = new RetentionService(prisma as never, storage);
    expect(await service.runOnce(2)).toBe(1);
    expect(jobs[0]?.status).toBe(RetentionDeletionJobStatus.STALE);
    expect(jobs[1]?.status).toBe(RetentionDeletionJobStatus.SUCCEEDED);
    expect(deleted).toEqual([["final/upload", "quarantine/upload"]]);
  });

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
