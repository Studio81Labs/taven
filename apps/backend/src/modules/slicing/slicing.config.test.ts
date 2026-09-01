import { describe, expect, it } from "vitest";
import { readSlicingQueueConfig } from "./slicing.config";

describe("slicing queue configuration", () => {
  it("parses provider-neutral Redis URLs and bounded polling controls", () => {
    const redisUrl = new URL("rediss://redis.internal:6380/");
    redisUrl.username = "worker";
    redisUrl.password = "test-value";
    expect(
      readSlicingQueueConfig({
        TAVEN_REDIS_URL: redisUrl.toString(),
        TAVEN_SLICING_DISPATCH_POLL_MILLISECONDS: "2500",
        TAVEN_SLICING_DISPATCH_CLAIM_LIMIT: "10",
      }),
    ).toEqual({
      connection: {
        host: "redis.internal",
        port: 6380,
        username: "worker",
        password: "test-value",
        tls: {},
        maxRetriesPerRequest: null,
      },
      pollMilliseconds: 2_500,
      claimLimit: 10,
    });
  });

  it("rejects Redis database paths and query parameters", () => {
    expect(() =>
      readSlicingQueueConfig({ TAVEN_REDIS_URL: "redis://localhost:6379/1" }),
    ).toThrow("root Redis URL");
    expect(() =>
      readSlicingQueueConfig({
        TAVEN_REDIS_URL: "redis://localhost:6379/?credential=value",
      }),
    ).toThrow("root Redis URL");
  });

  it("rejects dispatch claim limits outside the publisher bound", () => {
    expect(() =>
      readSlicingQueueConfig({
        TAVEN_REDIS_URL: "redis://localhost:6379",
        TAVEN_SLICING_DISPATCH_CLAIM_LIMIT: "101",
      }),
    ).toThrow(
      "TAVEN_SLICING_DISPATCH_CLAIM_LIMIT must be an integer from 1 through 100",
    );
  });
});
