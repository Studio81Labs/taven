import { GoneException } from "@nestjs/common";
import { UploadIntentStatus } from "@prisma/client";
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
  region: "us-east-1",
  bucket: "taven",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  forcePathStyle: true,
  signedUrlTtlSeconds: 2,
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
      service.initiateModelUpload(modelUpload),
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

    await expect(service.initiateModelUpload(modelUpload)).rejects.toBe(outage);
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
      service.initiateModelUpload(modelUpload),
    ).resolves.toMatchObject({
      uploadUrl: "https://signed.example/upload",
      expiresAt: signedExpiry.toISOString(),
    });
  });
});

function serviceWithSigner(createUploadUrl: ObjectStorage["createUploadUrl"]): {
  service: UploadService;
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = { uploadIntent: { create, updateMany } };
  const storage: ObjectStorage = {
    createUploadUrl,
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
  };
  return {
    service: new UploadService(prisma as never, storage, config),
    create,
    updateMany,
  };
}
