import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adminApiBaseUrl, adminTitle } from "./app-config";

describe("adminTitle", () => {
  it("includes an explicitly named environment", () => {
    expect(adminTitle("local")).toBe("Taven Admin · local");
  });
});

describe("adminApiBaseUrl", () => {
  it("requires an exact HTTPS API origin outside local development", () => {
    expect(adminApiBaseUrl("local", undefined)).toBe("http://localhost:3001");
    expect(adminApiBaseUrl("staging", "https://api.example.test")).toBe(
      "https://api.example.test",
    );
    expect(() => adminApiBaseUrl("production", undefined)).toThrow();
    expect(() =>
      adminApiBaseUrl("staging", "http://api.example.test"),
    ).toThrow();
    expect(() =>
      adminApiBaseUrl("staging", "https://api.example.test/path"),
    ).toThrow();
    expect(() => adminApiBaseUrl("prod", "http://api.example.test")).toThrow();
    expect(() => adminApiBaseUrl(undefined, undefined)).toThrow();
    expect(() => adminApiBaseUrl("local", "ftp://api.example.test")).toThrow();
  });
});

describe("admin image build environment", () => {
  const script = fileURLToPath(
    new URL("../scripts/validate-build-env.mjs", import.meta.url),
  );

  it.each([
    ["local", "http://localhost:3001", 0],
    ["staging", "https://api.example.test", 0],
    ["production", "https://api.example.test/", 0],
    ["prod", "http://api.example.test", 1],
    ["staging", "http://api.example.test", 1],
    ["production", "not-a-url", 1],
    ["staging", "https://api.example.test/path", 1],
    ["local", "ftp://api.example.test", 1],
    ["local", "", 1],
  ])("validates %s and %s", (environment, apiOrigin, expectedStatus) => {
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        VITE_APP_ENV: environment,
        VITE_API_BASE_URL: apiOrigin,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(expectedStatus);
  });
});
