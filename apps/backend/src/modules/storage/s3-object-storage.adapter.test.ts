import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { S3ObjectStorageAdapter } from "./s3-object-storage.adapter";
import { ObjectStorageDeadlineError } from "./object-storage.port";
import type { ObjectStorageConfig } from "./storage.config";

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));

const config: ObjectStorageConfig = {
  endpoint: "http://127.0.0.1:9010/",
  publicEndpoint: "http://127.0.0.1:9010/",
  region: "us-east-1",
  bucket: "taven",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  forcePathStyle: true,
  signedUrlTtlSeconds: 900,
  uploadClientHashKey: "test-only-upload-client-hash-key-32",
};
const objectKey = "quarantine/123e4567-e89b-42d3-a456-426614174000";
const hash = "a".repeat(64);

describe("S3ObjectStorageAdapter", () => {
  const client = new S3Client({ region: "us-east-1" });
  let send: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    send = vi.spyOn(client, "send");
    vi.mocked(getSignedUrl).mockClear();
    vi.mocked(getSignedUrl).mockResolvedValue("https://signed.example/object");
  });

  it("binds size and SHA-256 checksum into a signed upload", async () => {
    const storage = new S3ObjectStorageAdapter(config, client);
    const expiresAt = new Date(Date.now() + 60_000);
    const result = await storage.createUploadUrl({
      objectKey,
      contentType: "model/stl",
      contentHash: hash,
      contentLength: 12,
      expiresAt,
    });

    expect(result).toMatchObject({
      url: "https://signed.example/object",
      method: "PUT",
      requiredHeaders: {
        "content-type": "model/stl",
        "content-length": "12",
        "x-amz-checksum-sha256": Buffer.from(hash, "hex").toString("base64"),
      },
    });
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expiresAt.getTime());
    expect(vi.mocked(getSignedUrl)).toHaveBeenCalledWith(
      client,
      expect.any(PutObjectCommand),
      expect.objectContaining({
        expiresIn: expect.any(Number),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      }),
    );
    expect(
      (vi.mocked(getSignedUrl).mock.calls[0]?.[1] as PutObjectCommand).input,
    ).toMatchObject({ ContentLength: 12 });
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

  it("signs browser URLs against the public endpoint client", async () => {
    const signingClient = new S3Client({ region: "us-east-1" });
    const storage = new S3ObjectStorageAdapter(
      { ...config, publicEndpoint: "http://localhost:9010/" },
      client,
      signingClient,
    );

    await storage.createDownloadUrl({
      objectKey,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(vi.mocked(getSignedUrl)).toHaveBeenLastCalledWith(
      signingClient,
      expect.any(GetObjectCommand),
      expect.any(Object),
    );
    signingClient.destroy();
  });

  it("bounds signed downloads by an absolute deadline", async () => {
    const storage = new S3ObjectStorageAdapter(config, client);
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

  it("rejects a deadline with no complete signing second remaining", async () => {
    const storage = new S3ObjectStorageAdapter(config, client);
    await expect(
      storage.createDownloadUrl({
        objectKey,
        expiresAt: new Date(Date.now() + 999),
      }),
    ).rejects.toBeInstanceOf(ObjectStorageDeadlineError);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("returns verified object metadata and treats a missing key as absent", async () => {
    send.mockResolvedValueOnce({
      ContentType: "model/stl",
      ContentLength: 12,
      ChecksumSHA256: Buffer.from(hash, "hex").toString("base64"),
    });
    const storage = new S3ObjectStorageAdapter(config, client);

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
    const storage = new S3ObjectStorageAdapter(config, client);
    const destination = "models/123e4567-e89b-42d3-a456-426614174000/source";

    await storage.copyObject(objectKey, destination);
    expect(send).toHaveBeenLastCalledWith(expect.any(CopyObjectCommand));
    await expect(storage.deleteObjects([objectKey])).rejects.toThrow(
      "failed to delete",
    );
    expect(send).toHaveBeenLastCalledWith(expect.any(DeleteObjectsCommand));
  });

  it("treats per-key NoSuchKey delete results as idempotent success", async () => {
    send.mockResolvedValueOnce({
      Errors: [{ Key: objectKey, Code: "NoSuchKey" }],
    });
    const storage = new S3ObjectStorageAdapter(config, client);

    await expect(storage.deleteObjects([objectKey])).resolves.toBeUndefined();
  });

  it("lists a bounded generated namespace with modification timestamps", async () => {
    const lastModified = new Date("2026-08-01T00:00:00.000Z");
    send.mockResolvedValueOnce({
      Contents: [{ Key: objectKey, LastModified: lastModified }],
      IsTruncated: true,
    });
    const storage = new S3ObjectStorageAdapter(config, client);

    await expect(
      storage.listObjects({ prefix: "quarantine/", limit: 25 }),
    ).resolves.toEqual({
      objects: [{ objectKey, lastModified }],
      isTruncated: true,
    });
    expect(send).toHaveBeenLastCalledWith(expect.any(ListObjectsV2Command));
    expect(send.mock.calls.at(-1)?.[0].input).toMatchObject({
      Prefix: "quarantine/",
      MaxKeys: 25,
    });
  });

  it("streams only the exact bounded byte range requested by the caller", async () => {
    send.mockResolvedValueOnce({
      ContentLength: 3,
      Body: (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })(),
    });
    const storage = new S3ObjectStorageAdapter(config, client);

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
