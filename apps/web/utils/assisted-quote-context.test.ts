import { describe, expect, it } from "vitest";
import {
  assistedQuotePrefill,
  loadAssistedQuoteHandoff,
  normalizeAssistedQuoteSource,
  sanitizeAssistedQuoteHandoff,
  saveAssistedQuoteHandoff,
} from "./assisted-quote-context";
import type { StorageLike } from "./quote-session-storage";

const sessionId = "0198a6c8-7c2b-7f35-8ea8-5f181f490441";
const modelFileId = "0198a6c8-7c2b-7f35-8ea8-5f181f490442";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("storage write failed");
    this.values.set(key, value);
  }
}

describe("assisted quote entry", () => {
  it("accepts only the public entry-source allowlist", () => {
    expect(normalizeAssistedQuoteSource("blocked-3mf")).toBe("blocked-3mf");
    expect(normalizeAssistedQuoteSource(["automatic-quote", "no-file"])).toBe(
      "automatic-quote",
    );
    expect(normalizeAssistedQuoteSource("admin-override")).toBe("no-file");
  });

  it("uses context-specific copy without implying an automatic price", () => {
    expect(
      assistedQuotePrefill("automatic-quote", {
        automaticQuoteSessionId: sessionId,
        expiresAt: "2030-01-01T00:00:00.000Z",
        itemSelections: [],
        modelFileIds: [],
        reasons: ["RISK_DECLINED"],
      }),
    ).toMatchObject({
      description: expect.stringContaining("riziko"),
      note: expect.stringContaining("Cena ani obsah souboru se nepřenášejí"),
    });
    expect(assistedQuotePrefill("no-file").note).toContain("ze tří stran");
  });
});

describe("automatic quote safe-context handoff", () => {
  it("allowlists bounded technical fields and drops arbitrary data", () => {
    const context = sanitizeAssistedQuoteHandoff(
      {
        reasons: ["FIT_SENSITIVE"],
        safeContext: {
          automaticQuoteSessionId: sessionId,
          customerEmail: "must-not-copy@example.test",
          itemSelections: [
            {
              bodyIds: ["body-1"],
              fitSensitive: true,
              material: "PETG",
              modelFileId,
              ordinal: 0,
              quantity: 5,
              secret: "drop-me",
            },
          ],
          modelFileIds: [modelFileId],
        },
      },
      "2030-01-01T00:00:00.000Z",
      Date.parse("2029-01-01T00:00:00.000Z"),
    );

    expect(context).toEqual({
      automaticQuoteSessionId: sessionId,
      expiresAt: "2030-01-01T00:00:00.000Z",
      itemSelections: [
        {
          bodyIds: ["body-1"],
          fitSensitive: true,
          material: "PETG",
          modelFileId,
          ordinal: 0,
          quantity: 5,
        },
      ],
      modelFileIds: [modelFileId],
      reasons: ["FIT_SENSITIVE"],
    });
    expect(JSON.stringify(context)).not.toContain("customerEmail");
    expect(JSON.stringify(context)).not.toContain("secret");
  });

  it("does not copy expired automatic-quote context", () => {
    expect(
      sanitizeAssistedQuoteHandoff(
        {
          reasons: ["BUILD_LIMIT_EXCEEDED"],
          safeContext: { automaticQuoteSessionId: sessionId },
        },
        "2029-01-01T00:00:00.000Z",
        Date.parse("2030-01-01T00:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("persists valid context for navigation and clears it after expiry", () => {
    const storage = new MemoryStorage();
    const context = {
      automaticQuoteSessionId: sessionId,
      expiresAt: "2030-01-01T00:00:00.000Z",
      itemSelections: [],
      modelFileIds: [modelFileId],
      reasons: ["NO_CONFIGURATION_AVAILABLE"],
    };
    expect(saveAssistedQuoteHandoff(storage, context)).toBe(true);
    expect(
      loadAssistedQuoteHandoff(storage, Date.parse("2029-01-01T00:00:00.000Z")),
    ).toEqual(context);
    expect(
      loadAssistedQuoteHandoff(storage, Date.parse("2031-01-01T00:00:00.000Z")),
    ).toBeUndefined();
    expect(storage.values.size).toBe(0);
  });

  it("clears stale context before a failed replacement", () => {
    const storage = new MemoryStorage();
    const context = {
      automaticQuoteSessionId: sessionId,
      expiresAt: "2030-01-01T00:00:00.000Z",
      itemSelections: [],
      modelFileIds: [modelFileId],
      reasons: ["NO_CONFIGURATION_AVAILABLE"],
    };
    expect(saveAssistedQuoteHandoff(storage, context)).toBe(true);

    storage.failWrites = true;

    expect(
      saveAssistedQuoteHandoff(storage, {
        ...context,
        reasons: ["FIT_SENSITIVE"],
      }),
    ).toBe(false);
    expect(storage.values.size).toBe(0);
  });
});
