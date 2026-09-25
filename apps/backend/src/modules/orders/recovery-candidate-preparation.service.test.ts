import { describe, expect, it } from "vitest";
import { preparationAvailability } from "./recovery-candidate-preparation.service";

describe("recovery preparation availability", () => {
  it("keeps complete candidate coverage selectable after the liveness deadline", () => {
    expect(
      preparationAvailability({
        latest: true,
        contextValid: true,
        expired: true,
        pendingCount: 1,
        coverageAvailable: true,
      }),
    ).toEqual({ status: "CANDIDATES_AVAILABLE", blockingCodes: [] });
    expect(
      preparationAvailability({
        latest: true,
        contextValid: true,
        expired: true,
        pendingCount: 1,
        coverageAvailable: false,
      }),
    ).toEqual({ status: "EXPIRED", blockingCodes: ["PREPARATION_EXPIRED"] });
  });
});
