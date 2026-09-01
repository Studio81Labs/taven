import { describe, expect, it } from "vitest";
import {
  assistedQuoteRequestMessage,
  createQuoteRequestCommandKey,
  isEditableAttachmentFailure,
  isEditableCreateFailure,
  shouldRestoreAttachmentCorrectionAfterPreparationFailure,
  shouldUnlockAfterAttachmentPreparationFailure,
  shouldRestartPhotoIntent,
} from "./useAssistedQuoteRequest";

describe("assisted request command idempotency", () => {
  it("reuses a key for the same input and replaces it only for changed input", () => {
    let sequence = 0;
    const commandKey = createQuoteRequestCommandKey(
      () => `quote-request-${(sequence += 1)}`,
    );
    const input = { description: "A sufficiently long description" };

    expect(commandKey.get(input)).toBe("quote-request-1");
    expect(commandKey.get({ ...input })).toBe("quote-request-1");
    expect(
      commandKey.get({ description: "A different long description" }),
    ).toBe("quote-request-2");
  });
});

describe("assisted request recovery messages", () => {
  it("distinguishes request throttling from retained attachment throttling", () => {
    expect(assistedQuoteRequestMessage(429, "create")).toContain(
      "nových poptávek",
    );
    expect(assistedQuoteRequestMessage(429, "intent")).toContain(
      "Poptávka je uložená",
    );
  });

  it("unlocks only a definite pre-create validation failure", () => {
    expect(isEditableCreateFailure("create", 400)).toBe(true);
    expect(isEditableCreateFailure("create", 409)).toBe(false);
    expect(isEditableCreateFailure("intent", 400)).toBe(false);
  });

  it("allows replacing only definitely rejected attachments", () => {
    expect(isEditableAttachmentFailure("intent", 400)).toBe(true);
    expect(isEditableAttachmentFailure("confirm", 400)).toBe(true);
    expect(isEditableAttachmentFailure("confirm", 409)).toBe(true);
    expect(isEditableAttachmentFailure("confirm", 410)).toBe(false);
    expect(isEditableAttachmentFailure("create", 400)).toBe(false);
  });

  it("unlocks after a local attachment preparation failure", () => {
    expect(
      shouldUnlockAfterAttachmentPreparationFailure({
        aborted: false,
        hasCreatedRequest: false,
        hasPreparedPhotos: false,
      }),
    ).toBe(true);
    expect(
      shouldUnlockAfterAttachmentPreparationFailure({
        aborted: true,
        hasCreatedRequest: false,
        hasPreparedPhotos: false,
      }),
    ).toBe(false);
    expect(
      shouldUnlockAfterAttachmentPreparationFailure({
        aborted: false,
        hasCreatedRequest: false,
        hasPreparedPhotos: true,
      }),
    ).toBe(false);
    expect(
      shouldUnlockAfterAttachmentPreparationFailure({
        aborted: false,
        hasCreatedRequest: true,
        hasPreparedPhotos: false,
      }),
    ).toBe(false);
  });

  it("restores attachment correction after a local replacement failure", () => {
    expect(
      shouldRestoreAttachmentCorrectionAfterPreparationFailure({
        aborted: false,
        hasCreatedRequest: true,
        hasPreparedPhotos: false,
      }),
    ).toBe(true);
    expect(
      shouldRestoreAttachmentCorrectionAfterPreparationFailure({
        aborted: true,
        hasCreatedRequest: true,
        hasPreparedPhotos: false,
      }),
    ).toBe(false);
    expect(
      shouldRestoreAttachmentCorrectionAfterPreparationFailure({
        aborted: false,
        hasCreatedRequest: true,
        hasPreparedPhotos: true,
      }),
    ).toBe(false);
    expect(
      shouldRestoreAttachmentCorrectionAfterPreparationFailure({
        aborted: false,
        hasCreatedRequest: false,
        hasPreparedPhotos: false,
      }),
    ).toBe(false);
  });

  it.each([401, 403, 409, 410])(
    "restarts a terminal photo intent after status %s",
    (status) => {
      expect(shouldRestartPhotoIntent(status)).toBe(true);
    },
  );

  it.each([undefined, 400, 429, 500, 503])(
    "keeps a retryable photo intent after status %s",
    (status) => {
      expect(shouldRestartPhotoIntent(status)).toBe(false);
    },
  );
});
