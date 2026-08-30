import { describe, expect, it } from "vitest";
import { readObjectStorageConfig } from "./storage.config";

const environment = {
  TAVEN_S3_ENDPOINT: "http://127.0.0.1:9010",
  TAVEN_S3_REGION: "us-east-1",
  TAVEN_S3_BUCKET: "taven",
  TAVEN_S3_ACCESS_KEY_ID: "test-key",
  TAVEN_S3_SECRET_ACCESS_KEY: "test-secret",
  TAVEN_S3_FORCE_PATH_STYLE: "true",
};

describe("readObjectStorageConfig", () => {
  it("reads an explicit local MinIO configuration", () => {
    expect(readObjectStorageConfig(environment)).toEqual({
      endpoint: "http://127.0.0.1:9010/",
      region: "us-east-1",
      bucket: "taven",
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      forcePathStyle: true,
      signedUrlTtlSeconds: 900,
    });
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
  });
});
