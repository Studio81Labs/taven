import { GoneException, HttpException, HttpStatus } from "@nestjs/common";
import {
  PhotoAssetKind,
  PhotoScopeKind,
  RetentionHold,
  UploadAssetKind,
  UploadIntentStatus,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ObjectStorageDeadlineError,
  type ObjectStorage,
  type SignedObjectUrl,
} from "./object-storage.port";
import type { ObjectStorageConfig } from "./storage.config";
import { UploadService } from "./upload.service";

const config: ObjectStorageConfig = {
  endpoint: "http://127.0.0.1:9010/",
  publicEndpoint: "http://127.0.0.1:9010/",
  region: "us-east-1",
  bucket: "taven",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  forcePathStyle: true,
  signedUrlTtlSeconds: 2,
  uploadClientHashKey: "test-only-upload-client-hash-key-32",
};

const modelUpload = {
  format: "STL" as const,
  originalFilename: "part.stl",
  contentType: "model/stl",
  sizeBytes: 84,
  sha256: "a".repeat(64),
};

describe("UploadService URL signing", () => {
  it("expires a persisted intent when its signing deadline is exhausted", async () => {
    const { service, create, updateMany } = serviceWithSigner(async () => {
      throw new ObjectStorageDeadlineError();
    });

    await expect(
      service.initiateModelUpload(modelUpload, "127.0.0.1"),
    ).rejects.toBeInstanceOf(GoneException);
    expect(create).toHaveBeenCalledOnce();
    const uploadId = create.mock.calls[0]?.[0]?.data?.id as string;
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: uploadId, status: UploadIntentStatus.PENDING },
      data: { status: UploadIntentStatus.EXPIRED },
    });
  });

  it("leaves a transient signing failure pending for TTL cleanup", async () => {
    const outage = new Error("signer unavailable");
    const { service, updateMany } = serviceWithSigner(async () => {
      throw outage;
    });

    await expect(
      service.initiateModelUpload(modelUpload, "127.0.0.1"),
    ).rejects.toBe(outage);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("reports the provider URL expiry instead of the longer intent deadline", async () => {
    const signedExpiry = new Date(Date.now() + 1_000);
    const { service } = serviceWithSigner(async () => ({
      url: "https://signed.example/upload",
      method: "PUT",
      requiredHeaders: {},
      expiresAt: signedExpiry,
    }));

    await expect(
      service.initiateModelUpload(modelUpload, "127.0.0.1"),
    ).resolves.toMatchObject({
      uploadUrl: "https://signed.example/upload",
      expiresAt: signedExpiry.toISOString(),
    });
  });

  it("rejects exhausted anonymous issuance before persistence or signing", async () => {
    const signer = vi.fn();
    const { service, create } = serviceWithSigner(signer, 100);

    const rejected = service.initiateModelUpload(modelUpload, "127.0.0.1");
    await expect(rejected).rejects.toBeInstanceOf(HttpException);
    await expect(rejected).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(create).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });
});

describe("UploadService download deadlines", () => {
  it("treats a subsecond unheld retention window as expired", async () => {
    const createDownloadUrl = vi.fn();
    const { service, modelFileId, authorization } = downloadService(
      createDownloadUrl,
      new Date(Date.now() + 500),
    );

    await expect(
      service.createModelDownload(modelFileId, authorization),
    ).rejects.toBeInstanceOf(GoneException);
    expect(createDownloadUrl).not.toHaveBeenCalled();
  });

  it("maps only a signer deadline race to an expired response", async () => {
    const createDownloadUrl = vi
      .fn()
      .mockRejectedValueOnce(new ObjectStorageDeadlineError());
    const { service, modelFileId, authorization } = downloadService(
      createDownloadUrl,
      new Date(Date.now() + 5_000),
    );

    await expect(
      service.createModelDownload(modelFileId, authorization),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it("preserves generic download signer failures", async () => {
    const outage = new Error("signer unavailable");
    const createDownloadUrl = vi.fn().mockRejectedValueOnce(outage);
    const { service, modelFileId, authorization } = downloadService(
      createDownloadUrl,
      new Date(Date.now() + 5_000),
    );

    await expect(
      service.createModelDownload(modelFileId, authorization),
    ).rejects.toBe(outage);
  });
});

describe("UploadService confirmation response", () => {
  it("returns a persisted trigger-adjusted deadline on initial confirmation", async () => {
    const token = "c".repeat(43);
    const uploadId = "123e4567-e89b-42d3-a456-426614174004";
    const photoId = "123e4567-e89b-42d3-a456-426614174005";
    const scopeId = "123e4567-e89b-42d3-a456-426614174006";
    const uploadedAt = new Date("2026-01-01T00:00:01.000Z");
    const persistedDeadline = new Date("2026-05-01T00:00:00.000Z");
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const contentHash = "d".repeat(64);
    const pendingIntent = {
      id: uploadId,
      status: UploadIntentStatus.PENDING,
      assetKind: UploadAssetKind.PHOTO_ASSET,
      capabilityTokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 5_000),
      quarantineObjectKey: `quarantine/${uploadId}`,
      finalObjectKey: `photos/${photoId}/original`,
      expectedSizeBytes: BigInt(bytes.byteLength),
      expectedContentType: "image/png",
      expectedContentHash: contentHash,
      originalFilename: "reference.png",
      modelFormat: null,
      photoKind: PhotoAssetKind.QUOTE_REFERENCE,
      photoScopeKind: PhotoScopeKind.QUOTE_REQUEST,
      photoScopeId: scopeId,
      intendedAssetId: photoId,
      confirmedAt: null,
      confirmedModelFileId: null,
      confirmedPhotoAssetId: null,
    };
    const confirmedIntent = {
      ...pendingIntent,
      status: UploadIntentStatus.CONFIRMED,
      confirmedAt: uploadedAt,
      confirmedPhotoAssetId: photoId,
    };
    let transactionActive = false;
    const transaction = {
      $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) =>
        strings.join(" ").includes("FROM upload_intents")
          ? [{ id: uploadId }]
          : [
              {
                session_status: "OPEN",
                request_status: "NEW",
                offer_expires_at: null,
                session_expires_at: new Date(Date.now() + 5_000),
                observed_at: new Date(),
              },
            ],
      ),
      uploadIntent: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(pendingIntent),
        update: vi.fn().mockResolvedValue(confirmedIntent),
      },
      photoAsset: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      uploadIntent: { findUnique: vi.fn().mockResolvedValue(pendingIntent) },
      photoAsset: {
        findUnique: vi.fn().mockResolvedValue({
          uploadedAt,
          photoDeleteAfter: persistedDeadline,
        }),
      },
      $transaction: vi.fn(
        async (
          callback: (value: typeof transaction) => Promise<unknown>,
        ): Promise<unknown> => {
          transactionActive = true;
          try {
            return await callback(transaction);
          } finally {
            transactionActive = false;
          }
        },
      ),
    };
    const copyObject = vi.fn().mockImplementation(async () => {
      expect(transactionActive).toBe(true);
    });
    const storage = storageWith({
      headObject: async () => ({
        contentType: "image/png",
        contentLength: bytes.byteLength,
        contentHash,
      }),
      readObjectRange: async () => bytes,
      copyObject,
    });
    const service = new UploadService(prisma as never, storage, config);

    await expect(
      service.confirmUpload(uploadId, `Bearer ${token}`),
    ).resolves.toMatchObject({
      uploadId,
      assetId: photoId,
      assetKind: UploadAssetKind.PHOTO_ASSET,
      uploadedAt: uploadedAt.toISOString(),
      deleteAfter: persistedDeadline.toISOString(),
    });
    expect(transaction.photoAsset.create).toHaveBeenCalledOnce();
    expect(copyObject).toHaveBeenCalledOnce();
    expect(prisma.photoAsset.findUnique).toHaveBeenCalledWith({
      where: { id: photoId },
      select: { uploadedAt: true, photoDeleteAfter: true },
    });
  });

  it("returns the persisted trigger-adjusted photo retention deadline", async () => {
    const token = "a".repeat(43);
    const uploadId = "123e4567-e89b-42d3-a456-426614174001";
    const photoId = "123e4567-e89b-42d3-a456-426614174002";
    const confirmedAt = new Date("2026-01-01T00:00:00.000Z");
    const uploadedAt = new Date("2026-01-01T00:00:01.000Z");
    const persistedDeadline = new Date("2026-05-01T00:00:00.000Z");
    const prisma = {
      uploadIntent: {
        findUnique: vi.fn().mockResolvedValue({
          id: uploadId,
          status: UploadIntentStatus.CONFIRMED,
          assetKind: UploadAssetKind.PHOTO_ASSET,
          capabilityTokenHash: tokenHash(token),
          confirmedAt,
          confirmedModelFileId: null,
          confirmedPhotoAssetId: photoId,
        }),
      },
      photoAsset: {
        findUnique: vi.fn().mockResolvedValue({
          uploadedAt,
          photoDeleteAfter: persistedDeadline,
        }),
      },
    };
    const service = new UploadService(prisma as never, storageWith({}), config);

    await expect(
      service.confirmUpload(uploadId, `Bearer ${token}`),
    ).resolves.toMatchObject({
      uploadId,
      assetId: photoId,
      assetKind: UploadAssetKind.PHOTO_ASSET,
      uploadedAt: uploadedAt.toISOString(),
      deleteAfter: persistedDeadline.toISOString(),
    });
  });
});

function serviceWithSigner(
  createUploadUrl: ObjectStorage["createUploadUrl"],
  issuedCount = 0,
): {
  service: UploadService;
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const now = new Date();
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) =>
      strings.join(" ").includes("clock_timestamp() AS now")
        ? [{ now }]
        : [
            {
              subject_hash: "subject",
              window_started_at: now,
              window_expires_at: new Date(now.getTime() + 60_000),
              issued_count: issuedCount,
              reserved_bytes: 0n,
            },
          ],
    ),
    anonymousUploadLimit: { update: vi.fn().mockResolvedValue({}) },
    uploadIntent: { create },
  };
  const prisma = {
    uploadIntent: { updateMany },
    $transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  const storage = storageWith({ createUploadUrl });
  return {
    service: new UploadService(prisma as never, storage, config),
    create,
    updateMany,
  };
}

function downloadService(
  createDownloadUrl: ObjectStorage["createDownloadUrl"],
  sourceDeleteAfter: Date,
): { service: UploadService; modelFileId: string; authorization: string } {
  const token = "b".repeat(43);
  const modelFileId = "123e4567-e89b-42d3-a456-426614174003";
  const prisma = {
    uploadIntent: {
      findUnique: vi.fn().mockResolvedValue({
        capabilityTokenHash: tokenHash(token),
      }),
    },
    modelFile: {
      findUnique: vi.fn().mockResolvedValue({
        deletedAt: null,
        retentionHold: RetentionHold.NONE,
        sourceDeleteAfter,
        storageObjectKey: `models/${modelFileId}/source`,
      }),
    },
  };
  return {
    service: new UploadService(
      prisma as never,
      storageWith({ createDownloadUrl }),
      config,
    ),
    modelFileId,
    authorization: `Bearer ${token}`,
  };
}

function storageWith(overrides: Partial<ObjectStorage>): ObjectStorage {
  return {
    createUploadUrl: async () => ({
      url: "",
      method: "PUT",
      requiredHeaders: {},
      expiresAt: new Date(),
    }),
    createDownloadUrl: async (): Promise<SignedObjectUrl> => ({
      url: "",
      method: "GET",
      requiredHeaders: {},
      expiresAt: new Date(),
    }),
    headObject: async () => null,
    readObjectRange: async () => new Uint8Array(),
    copyObject: async () => undefined,
    deleteObjects: async () => undefined,
    listObjects: async () => ({ objects: [], isTruncated: false }),
    ...overrides,
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
