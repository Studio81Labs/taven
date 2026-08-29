import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinioObjectStorageAdapter } from "./minio-object-storage.adapter";
import type { ObjectStorageConfig } from "./storage.config";

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));

const config: ObjectStorageConfig = {
  endpoint: "http://127.0.0.1:9010/",
  region: "us-east-1",
  bucket: "taven",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  forcePathStyle: true,
  signedUrlTtlSeconds: 900,
};
const objectKey = "quarantine/123e4567-e89b-42d3-a456-426614174000";
const hash = "a".repeat(64);

describe("MinioObjectStorageAdapter", () => {
  const client = new S3Client({ region: "us-east-1" });
  let send: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    send = vi.spyOn(client, "send");
    vi.mocked(getSignedUrl).mockResolvedValue("https://signed.example/object");
  });

  it("binds type and SHA-256 checksum into a signed upload", async () => {
    const storage = new MinioObjectStorageAdapter(config, client);
    const expiresAt = new Date(Date.now() + 60_000);
    const result = await storage.createUploadUrl({
      objectKey,
      contentType: "model/stl",
      contentHash: hash,
      expiresAt,
    });

    expect(result).toMatchObject({
      url: "https://signed.example/object",
      method: "PUT",
      requiredHeaders: {
        "content-type": "model/stl",
        "x-amz-checksum-sha256": Buffer.from(hash, "hex").toString("base64"),
      },
    });
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expiresAt.getTime());
    expect(vi.mocked(getSignedUrl)).toHaveBeenCalledWith(
      client,
      expect.any(PutObjectCommand),
      expect.objectContaining({ expiresIn: expect.any(Number) }),
    );
    expect(
      vi.mocked(getSignedUrl).mock.calls[0]?.[2]?.expiresIn,
    ).toBeGreaterThan(0);
    expect(
      vi.mocked(getSignedUrl).mock.calls[0]?.[2]?.expiresIn,
    ).toBeLessThanOrEqual(60);
    const signing = vi.mocked(getSignedUrl).mock.calls[0]?.[2];
    expect(
      new Date(signing!.signingDate!).getTime() + signing!.expiresIn! * 1_000,
    ).toBeLessThanOrEqual(expiresAt.getTime());
  });

  it("bounds signed downloads by an absolute deadline", async () => {
    const storage = new MinioObjectStorageAdapter(config, client);
    const expiresAt = new Date(Date.now() + 60_000);
    const result = await storage.createDownloadUrl({ objectKey, expiresAt });

    expect(result).toMatchObject({
      url: "https://signed.example/object",
      method: "GET",
      requiredHeaders: {},
    });
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expiresAt.getTime());
    expect(vi.mocked(getSignedUrl)).toHaveBeenLastCalledWith(
      client,
      expect.any(GetObjectCommand),
      expect.objectContaining({
        expiresIn: expect.any(Number),
        signingDate: expect.any(Date),
      }),
    );
  });

  it("returns verified object metadata and treats a missing key as absent", async () => {
    send.mockResolvedValueOnce({
      ContentType: "model/stl",
      ContentLength: 12,
      ChecksumSHA256: Buffer.from(hash, "hex").toString("base64"),
    });
    const storage = new MinioObjectStorageAdapter(config, client);

    await expect(storage.headObject(objectKey)).resolves.toEqual({
      contentType: "model/stl",
      contentLength: 12,
      contentHash: hash,
    });
    expect(send).toHaveBeenLastCalledWith(expect.any(HeadObjectCommand));

    send.mockRejectedValueOnce({ name: "NotFound" });
    await expect(storage.headObject(objectKey)).resolves.toBeNull();
  });

  it("uses isolated keys for copying and fails a partial delete", async () => {
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({ Errors: [{ Key: objectKey }] });
    const storage = new MinioObjectStorageAdapter(config, client);
    const destination = "models/123e4567-e89b-42d3-a456-426614174000/source";

    await storage.copyObject(objectKey, destination);
    expect(send).toHaveBeenLastCalledWith(expect.any(CopyObjectCommand));
    await expect(storage.deleteObjects([objectKey])).rejects.toThrow(
      "failed to delete",
    );
    expect(send).toHaveBeenLastCalledWith(expect.any(DeleteObjectsCommand));
  });

  it("streams only the exact bounded byte range requested by the caller", async () => {
    send.mockResolvedValueOnce({
      ContentLength: 3,
      Body: (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })(),
    });
    const storage = new MinioObjectStorageAdapter(config, client);

    await expect(storage.readObjectRange(objectKey, 2, 3)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(send).toHaveBeenLastCalledWith(expect.any(GetObjectCommand));
    expect(send.mock.calls.at(-1)?.[0].input).toMatchObject({
      Range: "bytes=2-4",
    });

    send.mockResolvedValueOnce({
      ContentLength: 4,
      Body: (async function* () {})(),
    });
    await expect(storage.readObjectRange(objectKey, 0, 3)).rejects.toThrow(
      "more than the requested byte range",
    );

    send.mockResolvedValueOnce({
      ContentLength: 2,
      Body: (async function* () {
        yield new Uint8Array([1, 2]);
      })(),
    });
    await expect(storage.readObjectRange(objectKey, 0, 3)).rejects.toThrow(
      "incomplete byte range",
    );
  });
});
