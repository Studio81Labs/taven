import { describe, expect, it } from "vitest";
import { readObjectStorageConfig } from "./storage.config";

const environment = {
  TAVEN_S3_ENDPOINT: "http://127.0.0.1:9010",
  TAVEN_S3_REGION: "us-east-1",
  TAVEN_S3_BUCKET: "taven",
  TAVEN_S3_ACCESS_KEY_ID: "test-key",
  TAVEN_S3_SECRET_ACCESS_KEY: "test-secret",
  TAVEN_S3_FORCE_PATH_STYLE: "true",
  TAVEN_UPLOAD_CLIENT_HASH_KEY: "test-only-upload-client-hash-key-32",
};

describe("readObjectStorageConfig", () => {
  it("reads an explicit local MinIO configuration", () => {
    expect(readObjectStorageConfig(environment)).toEqual({
      endpoint: "http://127.0.0.1:9010/",
      publicEndpoint: "http://127.0.0.1:9010/",
      region: "us-east-1",
      bucket: "taven",
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      forcePathStyle: true,
      signedUrlTtlSeconds: 900,
      uploadClientHashKey: "test-only-upload-client-hash-key-32",
    });
  });

  it("allows browser-facing signed URLs to use a separate endpoint", () => {
    expect(
      readObjectStorageConfig({
        ...environment,
        TAVEN_S3_PUBLIC_ENDPOINT: "http://localhost:9010",
      }).publicEndpoint,
    ).toBe("http://localhost:9010/");

    expect(() =>
      readObjectStorageConfig({
        ...environment,
        TAVEN_S3_PUBLIC_ENDPOINT: "minio:9000",
      }),
    ).toThrow("TAVEN_S3_PUBLIC_ENDPOINT must be a bare HTTP(S) endpoint URL");
  });

  it("rejects malformed endpoints and TTLs", () => {
    expect(() =>
      readObjectStorageConfig({
        ...environment,
        TAVEN_S3_ENDPOINT: "localhost:9010",
      }),
    ).toThrow("bare HTTP(S) endpoint URL");
    expect(() =>
      readObjectStorageConfig({
        ...environment,
        TAVEN_S3_SIGNED_URL_TTL_SECONDS: "1",
      }),
    ).toThrow("TAVEN_S3_SIGNED_URL_TTL_SECONDS");
    expect(
      readObjectStorageConfig({
        ...environment,
        TAVEN_S3_SIGNED_URL_TTL_SECONDS: "2",
      }).signedUrlTtlSeconds,
    ).toBe(2);
    expect(() =>
      readObjectStorageConfig({
        ...environment,
        TAVEN_UPLOAD_CLIENT_HASH_KEY: "too-short",
      }),
    ).toThrow("TAVEN_UPLOAD_CLIENT_HASH_KEY");
  });
});
