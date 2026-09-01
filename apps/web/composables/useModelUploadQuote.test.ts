import { describe, expect, it } from "vitest";
import { isBackgroundQuotePhase } from "./useModelUploadQuote";

describe("automatic quote polling", () => {
  it.each([
    "INSPECTION_PENDING",
    "REFERENCE_SLICES_PENDING",
    "ELIGIBILITY_PENDING",
  ] as const)("continues polling %s", (phase) => {
    expect(isBackgroundQuotePhase(phase)).toBe(true);
  });

  it.each([
    "CONFIGURATION_REQUIRED",
    "ACTION_REQUIRED",
    "DESTINATION_REQUIRED",
    "CHECKOUT_READY",
    "EXPIRED",
    "HANDOFF_REQUIRED",
  ] as const)("waits for user action in %s", (phase) => {
    expect(isBackgroundQuotePhase(phase)).toBe(false);
  });
});
