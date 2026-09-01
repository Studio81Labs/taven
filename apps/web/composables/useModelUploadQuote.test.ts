import { describe, expect, it } from "vitest";
import {
  createUploadCommandKeys,
  isBackgroundQuotePhase,
  isTerminalUploadConfirmationStatus,
} from "./useModelUploadQuote";

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

describe("upload command idempotency", () => {
  it("reuses command keys across retries until a new file is selected", () => {
    let sequence = 0;
    const keys = createUploadCommandKeys(
      (scope) => `${scope}-${(sequence += 1)}`,
    );

    expect(keys.createSession()).toBe("create-session-1");
    expect(keys.createSession()).toBe("create-session-1");
    expect(keys.attachModel()).toBe("attach-model-2");
    expect(keys.attachModel()).toBe("attach-model-2");

    keys.resetAttachModel();

    expect(keys.createSession()).toBe("create-session-1");
    expect(keys.attachModel()).toBe("attach-model-3");

    keys.reset();

    expect(keys.createSession()).toBe("create-session-4");
    expect(keys.attachModel()).toBe("attach-model-5");
  });

  it.each([401, 409, 410])(
    "discards an upload checkpoint after terminal confirmation status %s",
    (status) => {
      expect(isTerminalUploadConfirmationStatus(status)).toBe(true);
    },
  );

  it.each([429, 500, 503])(
    "retains an upload checkpoint after retryable confirmation status %s",
    (status) => {
      expect(isTerminalUploadConfirmationStatus(status)).toBe(false);
    },
  );
});
