import { describe, expect, it } from "vitest";
import { readWorkerConfig } from "./config.js";
import { redisConnection } from "./fixture-runtime.js";

describe("worker configuration", () => {
  const requiredEnvironment = {
    TAVEN_S3_ENDPOINT: "https://storage.internal/",
    TAVEN_S3_REGION: "auto",
    TAVEN_S3_BUCKET: "taven",
    TAVEN_S3_ACCESS_KEY_ID: "worker",
    TAVEN_S3_SECRET_ACCESS_KEY: "secret-value",
    TAVEN_ORCA_RUNNER_ROOT: "/var/run/taven-orca",
  };

  it("uses provider-neutral Redis and S3 inputs", () => {
    const redisUrl = new URL("rediss://redis.internal:6380/");
    redisUrl.username = "worker";
    redisUrl.password = "test-value";
    const config = readWorkerConfig({
      TAVEN_REDIS_URL: redisUrl.toString(),
      TAVEN_S3_ENDPOINT: "https://storage.internal/",
      TAVEN_S3_REGION: "auto",
      TAVEN_S3_BUCKET: "taven",
      TAVEN_S3_ACCESS_KEY_ID: "worker",
      TAVEN_S3_SECRET_ACCESS_KEY: "secret-value",
      TAVEN_S3_FORCE_PATH_STYLE: "false",
      TAVEN_ORCA_RUNNER_ROOT: "/var/run/taven-orca",
    });
    expect(config.redisUrl).toContain("rediss:");
    expect(config.storage.endpoint).toBe("https://storage.internal/");
    expect(config.engine.version).toBe("2.4.2");
    expect(redisConnection(config.redisUrl)).toMatchObject({
      host: "redis.internal",
      port: 6380,
      username: "worker",
      password: "test-value",
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it("rejects storage endpoints that carry paths or credentials", () => {
    const endpoint = new URL("https://storage.internal/");
    endpoint.username = "user";
    endpoint.password = "test-value";
    expect(() =>
      readWorkerConfig({
        TAVEN_S3_ENDPOINT: endpoint.toString(),
        TAVEN_S3_REGION: "auto",
        TAVEN_S3_BUCKET: "taven",
        TAVEN_S3_ACCESS_KEY_ID: "worker",
        TAVEN_S3_SECRET_ACCESS_KEY: "secret-value",
      }),
    ).toThrow("bare HTTP or HTTPS URL");
  });

  it("rejects runtime values that the sidecar cannot honor", () => {
    expect(() =>
      readWorkerConfig({
        ...requiredEnvironment,
        TAVEN_ORCA_VERSION: "2.4.3",
      }),
    ).toThrow("must match the pinned runtime 2.4.2");
    expect(() =>
      readWorkerConfig({
        ...requiredEnvironment,
        TAVEN_ORCA_TIMEOUT_MILLISECONDS: "1800001",
      }),
    ).toThrow("must not exceed 1800000");
    expect(() =>
      readWorkerConfig({
        ...requiredEnvironment,
        TAVEN_ORCA_IMAGE_SHA256: "not-a-digest",
      }),
    ).toThrow("must be a lowercase SHA-256 digest");
    expect(() =>
      readWorkerConfig({
        ...requiredEnvironment,
        TAVEN_ORCA_IMAGE_SHA256: "A".repeat(64),
      }),
    ).toThrow("must be a lowercase SHA-256 digest");
  });
});
