import { describe, expect, it } from "vitest";
import { resolveApiHealthStatus } from "./health-status";

describe("resolveApiHealthStatus", () => {
  it("reports a successful health response", async () => {
    await expect(
      resolveApiHealthStatus(async () => ({ data: { status: "ok" } })),
    ).resolves.toBe("API ok");
  });

  it("reports structured API errors as unavailable", async () => {
    await expect(
      resolveApiHealthStatus(async () => ({ error: { message: "failed" } })),
    ).resolves.toBe("API unavailable");
  });

  it("catches rejected transport requests", async () => {
    await expect(
      resolveApiHealthStatus(async () => {
        throw new TypeError("fetch failed");
      }),
    ).resolves.toBe("API unavailable");
  });
});
