import { describe, expect, it } from "vitest";
import {
  clearQuoteSession,
  getSessionStorage,
  loadQuoteSession,
  saveQuoteSession,
  type StoredQuoteSession,
} from "./quote-session-storage";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class UnavailableStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error("storage disabled");
  }
  override removeItem(): void {
    throw new Error("storage disabled");
  }
  override setItem(): void {
    throw new Error("storage disabled");
  }
}

const session: StoredQuoteSession = {
  expiresAt: "2030-01-01T00:00:00.000Z",
  filename: "part.stl",
  publicReference: "TAV-123",
  sessionId: "session-id",
  sessionToken: "secret-capability",
};

describe("quote session storage", () => {
  it("round-trips only resumable session metadata", () => {
    const storage = new MemoryStorage();
    saveQuoteSession(storage, session);
    expect(loadQuoteSession(storage, Date.parse("2029-01-01"))).toEqual(
      session,
    );
    expect([...storage.values.values()][0]).not.toContain("fileBytes");
  });

  it("removes expired, malformed, and explicitly cleared sessions", () => {
    const storage = new MemoryStorage();
    saveQuoteSession(storage, session);
    expect(loadQuoteSession(storage, Date.parse("2031-01-01"))).toBeUndefined();
    expect(storage.values.size).toBe(0);

    storage.setItem("taven:automatic-quote-session:v1", "not-json");
    expect(loadQuoteSession(storage)).toBeUndefined();
    saveQuoteSession(storage, session);
    clearQuoteSession(storage);
    expect(storage.values.size).toBe(0);
  });

  it("keeps the active flow usable when session storage is unavailable", () => {
    const storage = new UnavailableStorage();
    expect(loadQuoteSession(storage)).toBeUndefined();
    expect(saveQuoteSession(storage, session)).toBe(false);
    expect(clearQuoteSession(storage)).toBe(false);
  });

  it("keeps the active flow usable when the session storage getter throws", () => {
    const host = Object.defineProperty({}, "sessionStorage", {
      get() {
        throw new DOMException("storage disabled", "SecurityError");
      },
    }) as { readonly sessionStorage: MemoryStorage };

    expect(getSessionStorage(host)).toBeUndefined();
  });
});
