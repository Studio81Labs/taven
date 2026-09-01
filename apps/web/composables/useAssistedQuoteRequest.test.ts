import { describe, expect, it } from "vitest";
import {
  assistedQuoteRequestMessage,
  createQuoteRequestCommandKey,
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
