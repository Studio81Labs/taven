import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorAuthService } from "./operator-auth.service";

const KEY = Buffer.alloc(32, 7).toString("base64url");

describe("OperatorAuthService expiry cleanup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("removes expired auth records, retained sessions, and stale rate buckets within the batch limit", async () => {
    vi.stubEnv("TAVEN_ENVIRONMENT", "development");
    vi.stubEnv("TAVEN_ADMIN_CSRF_KEY", KEY);
    vi.stubEnv("TAVEN_ADMIN_CLIENT_HASH_KEY", KEY);

    const now = new Date("2026-09-06T12:00:00.000Z");
    const deleteAttempts = vi.fn(async () => ({ count: 1 }));
    const deleteEvents = vi.fn(async () => ({ count: 1 }));
    const deleteSessions = vi.fn(async () => ({ count: 1 }));
    const deleteBuckets = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      $queryRaw: async () => [{ now }],
      $transaction: async (operations: readonly Promise<unknown>[]) =>
        Promise.all(operations),
      operatorLoginAttempt: {
        findMany: async () => [{ id: "attempt" }],
        deleteMany: deleteAttempts,
      },
      securityEvent: {
        findMany: async () => [{ id: "event" }],
        deleteMany: deleteEvents,
      },
      operatorSession: {
        findMany: async () => [{ id: "session" }],
        deleteMany: deleteSessions,
      },
      operatorLoginRateBucket: {
        findMany: async () => [{ id: "bucket" }],
        deleteMany: deleteBuckets,
      },
    };
    const github = {
      exchangeCode: async () => {
        throw new Error("GitHub must not be used during expiry cleanup");
      },
    };
    const service = new OperatorAuthService(prisma as never, github);

    await expect(service.purgeExpired(4)).resolves.toBe(4);
    expect(deleteAttempts).toHaveBeenCalledWith({
      where: { id: { in: ["attempt"] } },
    });
    expect(deleteEvents).toHaveBeenCalledWith({
      where: { id: { in: ["event"] } },
    });
    expect(deleteSessions).toHaveBeenCalledWith({
      where: { id: { in: ["session"] } },
    });
    expect(deleteBuckets).toHaveBeenCalledWith({
      where: { id: { in: ["bucket"] } },
    });
  });
});
