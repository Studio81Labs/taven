import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  Prisma,
  RetentionAssetKind,
  RetentionDeletionJobStatus,
} from "@prisma/client";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { OBJECT_STORAGE, type ObjectStorage } from "./object-storage.port";
import {
  photoExifObjectKey,
  photoThumbnailObjectKey,
  photoTransformObjectKey,
} from "./storage-keys";

const LEASE_MILLISECONDS = 5 * 60 * 1_000;
const MAX_ERROR_LENGTH = 4_000;

type JobRow = {
  id: string;
  asset_kind: RetentionAssetKind;
  asset_id: string;
  expected_delete_after: Date;
  status: RetentionDeletionJobStatus;
  attempts: number;
};

type DeletionClaim = {
  jobId: string;
  leaseToken: string;
  assetKind: RetentionAssetKind;
  assetId: string;
  objectKeys: string[];
  protectedObjectKey: string | null;
};

type DeletionTargets = Pick<DeletionClaim, "objectKeys" | "protectedObjectKey">;

type DeletionClaimResult =
  | { outcome: "EMPTY" }
  | { outcome: "SKIPPED" }
  | { outcome: "CLAIMED"; claim: DeletionClaim };

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
  ) {}

  /** Process at most `limit` due jobs; safe to call concurrently. */
  async runOnce(limit = 25): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("retention worker limit must be 1 through 1000");
    }
    await this.recoverExpiredLeases();
    let handled = 0;
    let processed = 0;
    while (handled < limit) {
      const result = await this.claimNextDueJob();
      if (result.outcome === "EMPTY") break;
      handled += 1;
      if (result.outcome === "SKIPPED") continue;
      const { claim } = result;
      processed += 1;
      try {
        await this.objects.deleteObjects(claim.objectKeys);
        await this.completeClaim(claim);
      } catch (error) {
        const canReleaseClaim = claim.protectedObjectKey
          ? await this.objects
              .headObject(claim.protectedObjectKey)
              .then((object) => object !== null)
              .catch(() => false)
          : true;
        await this.failClaim(claim, error, canReleaseClaim);
      }
    }
    return processed;
  }

  private async recoverExpiredLeases(): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const jobs = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM retention_deletion_jobs
        WHERE status = 'PROCESSING'
          AND lease_until < clock_timestamp()
        ORDER BY lease_until, id
        FOR UPDATE SKIP LOCKED
      `;
      const now = new Date();
      for (const job of jobs) {
        await transaction.retentionDeletionJob.update({
          where: { id: job.id },
          data: {
            status: RetentionDeletionJobStatus.FAILED,
            leaseUntil: null,
            leaseToken: null,
            availableAt: now,
            lastError: "processing lease expired before completion",
          },
        });
        // Keep the claim: the previous worker may still complete an in-flight
        // object deletion after its lease expires. Releasing here would let a
        // newer hold commit while that stale worker can still delete bytes.
      }
    });
  }

  private async claimNextDueJob(): Promise<DeletionClaimResult> {
    return this.prisma.$transaction(async (transaction) => {
      const jobs = await transaction.$queryRaw<JobRow[]>`
        SELECT id, asset_kind, asset_id, expected_delete_after, status, attempts
        FROM retention_deletion_jobs
        WHERE status IN ('PENDING', 'FAILED')
          AND available_at <= clock_timestamp()
          AND expected_delete_after <= clock_timestamp()
        ORDER BY available_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const job = jobs[0];
      if (!job) return { outcome: "EMPTY" };

      // A failed attempt released its asset claim. Re-arm the exact job before
      // reclaiming the asset; the database claim fence intentionally accepts
      // only PENDING jobs, preventing a stale FAILED row from claiming it.
      if (job.status === RetentionDeletionJobStatus.FAILED) {
        await transaction.retentionDeletionJob.update({
          where: { id: job.id },
          data: { status: RetentionDeletionJobStatus.PENDING },
        });
        job.status = RetentionDeletionJobStatus.PENDING;
      }

      const leaseToken = randomBytes(32).toString("hex");
      const leaseUntil = new Date(Date.now() + LEASE_MILLISECONDS);
      let targets: DeletionTargets | null;

      if (job.asset_kind === RetentionAssetKind.MODEL_FILE) {
        targets = await this.claimModelFile(transaction, job);
      } else if (job.asset_kind === RetentionAssetKind.PHOTO_ASSET) {
        targets = await this.claimPhotoAsset(transaction, job);
      } else if (job.asset_kind === RetentionAssetKind.UPLOAD_INTENT) {
        targets = await this.claimUploadIntent(transaction, job);
      } else {
        await this.markStale(
          transaction,
          job.id,
          "geometry cleanup is owned by its source ModelFile job",
        );
        return { outcome: "SKIPPED" };
      }

      if (!targets) return { outcome: "SKIPPED" };
      await transaction.retentionDeletionJob.update({
        where: { id: job.id },
        data: {
          status: RetentionDeletionJobStatus.PROCESSING,
          attempts: { increment: 1 },
          leaseToken,
          leaseUntil,
          lastError: null,
        },
      });
      return {
        outcome: "CLAIMED",
        claim: {
          jobId: job.id,
          leaseToken,
          assetKind: job.asset_kind,
          assetId: job.asset_id,
          objectKeys: [...new Set(targets.objectKeys)].sort(),
          protectedObjectKey: targets.protectedObjectKey,
        },
      };
    });
  }

  private async claimModelFile(
    transaction: Prisma.TransactionClient,
    job: JobRow,
  ): Promise<DeletionTargets | null> {
    const rows = await transaction.$queryRaw<
      Array<{
        storage_object_key: string;
        source_delete_after: Date;
        retention_hold: string;
        deleted_at: Date | null;
        retention_deletion_job_id: string | null;
      }>
    >`
      SELECT storage_object_key, source_delete_after, retention_hold::text,
             deleted_at, retention_deletion_job_id
      FROM model_files WHERE id = ${job.asset_id}::uuid FOR UPDATE
    `;
    const source = rows[0];
    if (!source) {
      await this.markStale(
        transaction,
        job.id,
        "model source metadata is missing",
      );
      return null;
    }
    if (source.deleted_at) {
      await this.markSucceeded(
        transaction,
        job.id,
        "model source was already deleted",
      );
      return null;
    }
    if (
      source.source_delete_after.getTime() !==
        job.expected_delete_after.getTime() ||
      source.retention_hold !== "NONE"
    ) {
      await this.markStale(
        transaction,
        job.id,
        "model source deadline or hold changed",
      );
      return null;
    }
    if (
      source.retention_deletion_job_id &&
      source.retention_deletion_job_id !== job.id
    ) {
      await this.markStale(
        transaction,
        job.id,
        "model source has another deletion claim",
      );
      return null;
    }
    if (!source.retention_deletion_job_id) {
      await transaction.modelFile.update({
        where: { id: job.asset_id },
        data: { retentionDeletionJobId: job.id },
      });
    }

    const keys = await transaction.$queryRaw<Array<{ object_key: string }>>`
      SELECT storage_object_key AS object_key FROM model_files WHERE id = ${job.asset_id}::uuid
      UNION
      SELECT geometry.canonical_object_key AS object_key
      FROM model_geometries geometry WHERE geometry.source_model_file_id = ${job.asset_id}::uuid
      UNION
      SELECT slice_result.artifact_object_key AS object_key
      FROM model_geometries geometry
      JOIN slice_results slice_result ON slice_result.model_geometry_id = geometry.id
      WHERE geometry.source_model_file_id = ${job.asset_id}::uuid
    `;
    return {
      objectKeys: keys.map(({ object_key }) => object_key),
      protectedObjectKey: source.storage_object_key,
    };
  }

  private async claimPhotoAsset(
    transaction: Prisma.TransactionClient,
    job: JobRow,
  ): Promise<DeletionTargets | null> {
    const rows = await transaction.$queryRaw<
      Array<{
        storage_object_key: string;
        photo_delete_after: Date;
        retention_hold: string;
        deleted_at: Date | null;
        retention_deletion_job_id: string | null;
      }>
    >`
      SELECT storage_object_key, photo_delete_after, retention_hold::text,
             deleted_at, retention_deletion_job_id
      FROM photo_assets WHERE id = ${job.asset_id}::uuid FOR UPDATE
    `;
    const photo = rows[0];
    if (!photo) {
      await this.markStale(transaction, job.id, "photo metadata is missing");
      return null;
    }
    if (photo.deleted_at) {
      await this.markSucceeded(
        transaction,
        job.id,
        "photo was already deleted",
      );
      return null;
    }
    if (
      photo.photo_delete_after.getTime() !==
        job.expected_delete_after.getTime() ||
      photo.retention_hold !== "NONE"
    ) {
      await this.markStale(
        transaction,
        job.id,
        "photo deadline or hold changed",
      );
      return null;
    }
    if (
      photo.retention_deletion_job_id &&
      photo.retention_deletion_job_id !== job.id
    ) {
      await this.markStale(
        transaction,
        job.id,
        "photo has another deletion claim",
      );
      return null;
    }
    if (!photo.retention_deletion_job_id) {
      await transaction.photoAsset.update({
        where: { id: job.asset_id },
        data: { retentionDeletionJobId: job.id },
      });
    }
    return {
      objectKeys: [
        photo.storage_object_key,
        photoThumbnailObjectKey(job.asset_id),
        photoTransformObjectKey(job.asset_id),
        photoExifObjectKey(job.asset_id),
      ],
      protectedObjectKey: photo.storage_object_key,
    };
  }

  private async claimUploadIntent(
    transaction: Prisma.TransactionClient,
    job: JobRow,
  ): Promise<DeletionTargets | null> {
    const rows = await transaction.$queryRaw<
      Array<{
        status: string;
        expires_at: Date;
        quarantine_object_key: string;
        final_object_key: string;
      }>
    >`
      SELECT status::text, expires_at, quarantine_object_key, final_object_key
      FROM upload_intents WHERE id = ${job.asset_id}::uuid FOR UPDATE
    `;
    const upload = rows[0];
    if (!upload) {
      await this.markStale(transaction, job.id, "upload intent is missing");
      return null;
    }
    if (upload.expires_at.getTime() !== job.expected_delete_after.getTime()) {
      await this.markStale(
        transaction,
        job.id,
        "upload intent deadline changed",
      );
      return null;
    }
    if (upload.status === "PENDING") {
      await transaction.uploadIntent.update({
        where: { id: job.asset_id },
        data: { status: "EXPIRED" },
      });
    }
    return {
      objectKeys:
        upload.status === "CONFIRMED"
          ? [upload.quarantine_object_key]
          : [upload.quarantine_object_key, upload.final_object_key],
      protectedObjectKey: null,
    };
  }

  private async completeClaim(claim: DeletionClaim): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const job = await transaction.retentionDeletionJob.findFirst({
        where: {
          id: claim.jobId,
          status: RetentionDeletionJobStatus.PROCESSING,
          leaseToken: claim.leaseToken,
        },
      });
      if (!job) return;

      if (claim.assetKind === RetentionAssetKind.MODEL_FILE) {
        await transaction.modelFile.update({
          where: {
            id: claim.assetId,
            retentionDeletionJobId: claim.jobId,
          },
          data: { deletedAt: new Date() },
        });
      } else if (claim.assetKind === RetentionAssetKind.PHOTO_ASSET) {
        await transaction.photoAsset.update({
          where: {
            id: claim.assetId,
            retentionDeletionJobId: claim.jobId,
          },
          data: { deletedAt: new Date() },
        });
      }
      await transaction.retentionDeletionJob.update({
        where: { id: claim.jobId },
        data: {
          status: RetentionDeletionJobStatus.SUCCEEDED,
          leaseToken: null,
          leaseUntil: null,
          completedAt: new Date(),
          lastError: null,
        },
      });
    });
  }

  private async failClaim(
    claim: DeletionClaim,
    error: unknown,
    releaseClaim: boolean,
  ): Promise<void> {
    const message = errorMessage(error).slice(0, MAX_ERROR_LENGTH);
    await this.prisma.$transaction(async (transaction) => {
      const job = await transaction.retentionDeletionJob.findFirst({
        where: {
          id: claim.jobId,
          status: RetentionDeletionJobStatus.PROCESSING,
          leaseToken: claim.leaseToken,
        },
      });
      if (!job) return;
      const retryMilliseconds = Math.min(
        60 * 60 * 1_000,
        2 ** job.attempts * 1_000,
      );
      await transaction.retentionDeletionJob.update({
        where: { id: job.id },
        data: {
          status: RetentionDeletionJobStatus.FAILED,
          leaseToken: null,
          leaseUntil: null,
          availableAt: new Date(Date.now() + retryMilliseconds),
          lastError: message,
        },
      });
      if (releaseClaim) await this.releaseAssetClaim(transaction, job.id);
    });
    this.logger.error(`retention deletion ${claim.jobId} failed: ${message}`);
  }

  private async releaseAssetClaim(
    transaction: Prisma.TransactionClient,
    jobId: string,
  ): Promise<void> {
    await transaction.modelFile.updateMany({
      where: { retentionDeletionJobId: jobId },
      data: { retentionDeletionJobId: null },
    });
    await transaction.photoAsset.updateMany({
      where: { retentionDeletionJobId: jobId },
      data: { retentionDeletionJobId: null },
    });
  }

  private async markStale(
    transaction: Prisma.TransactionClient,
    jobId: string,
    reason: string,
  ): Promise<void> {
    await transaction.retentionDeletionJob.update({
      where: { id: jobId },
      data: {
        status: RetentionDeletionJobStatus.STALE,
        completedAt: new Date(),
        leaseToken: null,
        leaseUntil: null,
        lastError: reason,
      },
    });
  }

  private async markSucceeded(
    transaction: Prisma.TransactionClient,
    jobId: string,
    note: string,
  ): Promise<void> {
    await transaction.retentionDeletionJob.update({
      where: { id: jobId },
      data: {
        status: RetentionDeletionJobStatus.SUCCEEDED,
        completedAt: new Date(),
        leaseToken: null,
        leaseUntil: null,
        lastError: note,
      },
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "unknown storage deletion error";
}
