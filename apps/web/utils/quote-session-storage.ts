const STORAGE_KEY = "taven:automatic-quote-session:v1";

export interface StoredQuoteSession {
  expiresAt: string;
  filename: string;
  publicReference: string;
  sessionId: string;
  sessionToken: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export function getSessionStorage(host: {
  readonly sessionStorage: StorageLike;
}): StorageLike | undefined {
  try {
    return host.sessionStorage;
  } catch {
    return undefined;
  }
}

function isStoredQuoteSession(value: unknown): value is StoredQuoteSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return [
    "expiresAt",
    "filename",
    "publicReference",
    "sessionId",
    "sessionToken",
  ].every((key) => typeof record[key] === "string" && record[key].length > 0);
}

export function loadQuoteSession(
  storage: StorageLike,
  now = Date.now(),
): StoredQuoteSession | undefined {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredQuoteSession(parsed)) throw new Error("invalid session");
    const expiresAt = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      clearQuoteSession(storage);
      return undefined;
    }
    return parsed;
  } catch {
    clearQuoteSession(storage);
    return undefined;
  }
}

export function saveQuoteSession(
  storage: StorageLike,
  session: StoredQuoteSession,
): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearQuoteSession(storage: StorageLike): boolean {
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
