import { describe, expect, it } from "vitest";
import { readAdminAccessConfig } from "./admin-access.config";

const KEY = Buffer.alloc(32, 7).toString("base64url");

describe("operator authentication configuration", () => {
  it("enables only development password login for explicit development", () => {
    const config = readAdminAccessConfig({
      TAVEN_ENVIRONMENT: "development",
      TAVEN_ADMIN_CSRF_KEY: KEY,
      TAVEN_ADMIN_CLIENT_HASH_KEY: KEY,
    });

    expect(config.environment).toBe("development");
    expect(config.github).toBeNull();
    expect(config.adminOrigins).toEqual(["http://localhost:3002"]);
  });

  it("requires a complete GitHub configuration outside development", () => {
    expect(() =>
      readAdminAccessConfig({
        TAVEN_ENVIRONMENT: "staging",
        TAVEN_ADMIN_ORIGINS: "https://admin.example.test",
        TAVEN_ADMIN_CSRF_KEY: KEY,
        TAVEN_ADMIN_CLIENT_HASH_KEY: KEY,
      }),
    ).toThrow("TAVEN_GITHUB_APP_CLIENT_ID is required outside development");
  });

  it("keeps offline OpenAPI export independent of live credentials", () => {
    const config = readAdminAccessConfig({ TAVEN_OPENAPI_EXPORT: "true" });

    expect(config.environment).toBe("development");
    expect(config.github).toBeNull();
  });

  it("rejects non-origin admin configuration values", () => {
    expect(() =>
      readAdminAccessConfig({
        TAVEN_ENVIRONMENT: "development",
        TAVEN_ADMIN_ORIGINS: "https://admin.example.test/path",
        TAVEN_ADMIN_CSRF_KEY: KEY,
        TAVEN_ADMIN_CLIENT_HASH_KEY: KEY,
      }),
    ).toThrow("TAVEN_ADMIN_ORIGINS must contain exact origins only");
  });
});
