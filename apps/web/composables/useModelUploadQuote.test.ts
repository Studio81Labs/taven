import { describe, expect, it } from "vitest";
import {
  clearsStoredSessionOnSelection,
  createLatestResponseGuard,
  createQuoteCommandKeys,
  createUploadCommandKeys,
  createUploadTransferCheckpoint,
  isBackgroundQuotePhase,
  isTerminalQuoteHandoff,
  isTerminalAttachmentStatus,
  isTerminalUploadConfirmationStatus,
  requiresPreparationAdvance,
  resolveUploadSession,
} from "./useModelUploadQuote";

describe("model selection persistence", () => {
  it("preserves an existing quote while the landing validates its replacement", () => {
    expect(
      clearsStoredSessionOnSelection({
        preserveStoredSessionOnSelection: true,
        restoreSession: false,
      }),
    ).toBe(false);
  });

  it("clears the current quote for the primary configurator by default", () => {
    expect(clearsStoredSessionOnSelection({})).toBe(true);
  });
});

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

describe("automatic quote preparation advancement", () => {
  it.each(["REFERENCE_SLICES_PENDING", "ELIGIBILITY_PENDING"] as const)(
    "automatically advances %s",
    (phase) => {
      expect(requiresPreparationAdvance(phase)).toBe(true);
    },
  );

  it.each([
    "INSPECTION_PENDING",
    "CONFIGURATION_REQUIRED",
    "ACTION_REQUIRED",
    "DESTINATION_REQUIRED",
    "CHECKOUT_READY",
    "EXPIRED",
    "HANDOFF_REQUIRED",
  ] as const)("does not automatically advance %s", (phase) => {
    expect(requiresPreparationAdvance(phase)).toBe(false);
  });
});

describe("automatic quote handoff", () => {
  const express = {
    eligible: false,
    reasons: ["EXPRESS_INELIGIBLE"],
    requested: true,
  };

  it("keeps an Express-only handoff in the configurator for recovery", () => {
    expect(
      isTerminalQuoteHandoff({
        express,
        handoff: {
          kind: "INDIVIDUAL_QUOTE_REQUEST",
          reasons: ["EXPRESS_INELIGIBLE"],
          safeContext: {},
        },
        phase: "HANDOFF_REQUIRED",
      }),
    ).toBe(false);
  });

  it("keeps mixed and non-Express handoffs terminal", () => {
    expect(
      isTerminalQuoteHandoff({
        express,
        handoff: {
          kind: "INDIVIDUAL_QUOTE_REQUEST",
          reasons: ["EXPRESS_INELIGIBLE", "BUILD_LIMIT_EXCEEDED"],
          safeContext: {},
        },
        phase: "HANDOFF_REQUIRED",
      }),
    ).toBe(true);
    expect(
      isTerminalQuoteHandoff({
        express: { ...express, requested: false },
        handoff: {
          kind: "INDIVIDUAL_QUOTE_REQUEST",
          reasons: ["BUILD_LIMIT_EXCEEDED"],
          safeContext: {},
        },
        phase: "HANDOFF_REQUIRED",
      }),
    ).toBe(true);
  });
});

describe("upload command idempotency", () => {
  it("attaches another model to the active restored session", () => {
    expect(
      resolveUploadSession("active-session", "active-token", {
        sessionId: "created-session",
        sessionToken: "created-token",
      }),
    ).toEqual({
      sessionId: "active-session",
      sessionToken: "active-token",
    });
  });

  it("uses the newly created session for the first attachment", () => {
    expect(
      resolveUploadSession(undefined, undefined, {
        sessionId: "created-session",
        sessionToken: "created-token",
      }),
    ).toEqual({
      sessionId: "created-session",
      sessionToken: "created-token",
    });
  });

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

  it("does not repeat a completed PUT while confirmation is retried", () => {
    const checkpoint = createUploadTransferCheckpoint();

    expect(checkpoint.needsPut()).toBe(true);
    checkpoint.markPutCompleted();
    expect(checkpoint.needsPut()).toBe(false);

    checkpoint.reset();
    expect(checkpoint.needsPut()).toBe(true);
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

  it.each([401, 409, 410])(
    "restarts the workflow after terminal attachment status %s",
    (status) => {
      expect(isTerminalAttachmentStatus(status)).toBe(true);
    },
  );

  it.each([429, 500, 503])(
    "retains attachment checkpoints after retryable status %s",
    (status) => {
      expect(isTerminalAttachmentStatus(status)).toBe(false);
    },
  );
});

describe("configurator concurrency", () => {
  it("rejects a slicing response after a newer option change begins", () => {
    const guard = createLatestResponseGuard();
    const slicingResponse = guard.begin();
    const optionChange = guard.begin();

    expect(guard.isCurrent(slicingResponse)).toBe(false);
    expect(guard.isCurrent(optionChange)).toBe(true);
  });

  it("reuses an idempotency key only while the same command is retrying", () => {
    let sequence = 0;
    const keys = createQuoteCommandKeys(
      (scope) => `${scope}-${(sequence += 1)}`,
    );
    const input = { material: "PLA", quantity: 5 };

    expect(keys.get("configure", input)).toBe("configure-1");
    expect(keys.get("configure", input)).toBe("configure-1");
    expect(keys.get("configure", { ...input, quantity: 20 })).toBe(
      "configure-2",
    );
    keys.complete("configure", input);
    expect(keys.get("configure", input)).toBe("configure-3");
  });
});
