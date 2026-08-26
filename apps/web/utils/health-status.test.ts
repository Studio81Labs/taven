import { describe, expect, it } from "vitest";
import { resolveWebHealthStatus } from "./health-status";

describe("resolveWebHealthStatus", () => {
  it("reports the successful API state", () => {
    expect(resolveWebHealthStatus({ status: "ok" }, false)).toBe("API ok");
  });

  it("does not present a failed request as ready", () => {
    expect(resolveWebHealthStatus(undefined, true)).toBe("API unavailable");
  });

  it("keeps the pending state explicit", () => {
    expect(resolveWebHealthStatus(undefined, false)).toBe(
      "Checking API health…",
    );
  });
});
