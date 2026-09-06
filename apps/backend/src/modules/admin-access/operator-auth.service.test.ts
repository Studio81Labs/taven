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

  it("keeps cleanup capacity for every auth table when attempts fill their batch", async () => {
    vi.stubEnv("TAVEN_ENVIRONMENT", "development");
    vi.stubEnv("TAVEN_ADMIN_CSRF_KEY", KEY);
    vi.stubEnv("TAVEN_ADMIN_CLIENT_HASH_KEY", KEY);

    const now = new Date("2026-09-06T12:00:00.000Z");
    const events = vi.fn(async () => [{ id: "event" }]);
    const sessions = vi.fn(async () => [{ id: "session" }]);
    const buckets = vi.fn(async () => [{ id: "bucket" }]);
    const deleted = async () => ({ count: 1 });
    const prisma = {
      $queryRaw: async () => [{ now }],
      $transaction: async (operations: readonly Promise<unknown>[]) =>
        Promise.all(operations),
      operatorLoginAttempt: {
        findMany: async () => [{ id: "attempt-1" }, { id: "attempt-2" }],
        deleteMany: deleted,
      },
      securityEvent: { findMany: events, deleteMany: deleted },
      operatorSession: { findMany: sessions, deleteMany: deleted },
      operatorLoginRateBucket: { findMany: buckets, deleteMany: deleted },
    };
    const service = new OperatorAuthService(prisma as never, {
      exchangeCode: async () => {
        throw new Error("GitHub must not be used during expiry cleanup");
      },
    });

    await expect(service.purgeExpired(2)).resolves.toBe(4);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    expect(sessions).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    expect(buckets).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  it("rejects a development login with a non-string email instead of throwing", async () => {
    vi.stubEnv("TAVEN_ENVIRONMENT", "development");
    vi.stubEnv("TAVEN_ADMIN_CSRF_KEY", KEY);
    vi.stubEnv("TAVEN_ADMIN_CLIENT_HASH_KEY", KEY);
    const service = new OperatorAuthService({} as never, {
      exchangeCode: async () => {
        throw new Error("GitHub must not be used for a development login");
      },
    });

    await expect(
      service.loginWithDevelopmentPassword(
        { email: undefined as never, password: "valid-password" },
        { headers: { origin: "http://localhost:3002" } },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("limits GitHub login starts per client before the global budget is exhausted", async () => {
    vi.stubEnv("TAVEN_ENVIRONMENT", "staging");
    vi.stubEnv("TAVEN_ADMIN_ORIGINS", "https://admin.example.test");
    vi.stubEnv("TAVEN_ADMIN_CSRF_KEY", KEY);
    vi.stubEnv("TAVEN_ADMIN_CLIENT_HASH_KEY", KEY);
    vi.stubEnv("TAVEN_GITHUB_APP_CLIENT_ID", "github-client");
    vi.stubEnv("TAVEN_GITHUB_APP_CLIENT_SECRET", "github-secret");
    vi.stubEnv(
      "TAVEN_GITHUB_APP_CALLBACK_URL",
      "https://api.example.test/admin/auth/github/callback",
    );
    vi.stubEnv("TAVEN_ADMIN_COMPLETION_URL", "https://admin.example.test/");
    vi.stubEnv("TAVEN_GITHUB_LOGIN_ATTEMPT_ENCRYPTION_KEY", KEY);

    let calls = 0;
    const transaction = {
      operatorLoginRateBucket: {
        upsert: async () => ({ attempts: ++calls === 1 ? 1 : 11, failures: 0 }),
      },
    };
    const service = new OperatorAuthService(
      {
        $transaction: async <T>(callback: (tx: typeof transaction) => T) =>
          callback(transaction),
      } as never,
      {
        exchangeCode: async () => {
          throw new Error(
            "GitHub exchange must not be used while claiming budget",
          );
        },
      },
    );

    await expect(
      (
        service as unknown as {
          claimLoginBudget: (
            subjectHash: undefined,
            clientHash: string,
          ) => Promise<void>;
        }
      ).claimLoginBudget(undefined, "client"),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(2);
  });

  it("limits password attempts before an additional password verification runs", async () => {
    vi.stubEnv("TAVEN_ENVIRONMENT", "development");
    vi.stubEnv("TAVEN_ADMIN_CSRF_KEY", KEY);
    vi.stubEnv("TAVEN_ADMIN_CLIENT_HASH_KEY", KEY);

    let calls = 0;
    const transaction = {
      operatorLoginRateBucket: {
        upsert: async () => ({ attempts: ++calls === 1 ? 1 : 6, failures: 0 }),
      },
    };
    const service = new OperatorAuthService(
      {
        $transaction: async <T>(callback: (tx: typeof transaction) => T) =>
          callback(transaction),
      } as never,
      {
        exchangeCode: async () => {
          throw new Error("GitHub must not be used while claiming budget");
        },
      },
    );

    await expect(
      (
        service as unknown as {
          claimLoginBudget: (
            subjectHash: string,
            clientHash: string,
          ) => Promise<void>;
        }
      ).claimLoginBudget("subject", "client"),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(2);
  });
});
