const STORAGE_KEY = "taven:automatic-quote-session:v1";

export interface StoredQuoteSession {
  capturedPaymentId?: string;
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
  return (
    [
      "expiresAt",
      "filename",
      "publicReference",
      "sessionId",
      "sessionToken",
    ].every(
      (key) => typeof record[key] === "string" && record[key].length > 0,
    ) &&
    (record.capturedPaymentId === undefined ||
      (typeof record.capturedPaymentId === "string" &&
        record.capturedPaymentId.length > 0))
  );
}

export function loadQuoteSession(
  storage: StorageLike,
  now = Date.now(),
): StoredQuoteSession | undefined {
  const parsed = readStoredQuoteSession(storage);
  if (!parsed) return undefined;
  if (parsed.capturedPaymentId) return undefined;
  const expiresAt = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    clearQuoteSession(storage);
    return undefined;
  }
  return parsed;
}

/**
 * Loads credentials only for resources, such as a checkout Payment, whose
 * server-side lifetime is independent from the quote-session expiry.
 */
export function loadPaymentReturnSession(
  storage: StorageLike,
): StoredQuoteSession | undefined {
  return readStoredQuoteSession(storage);
}

function readStoredQuoteSession(
  storage: StorageLike,
): StoredQuoteSession | undefined {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredQuoteSession(parsed)) throw new Error("invalid session");
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

export function markQuoteSessionCaptured(
  storage: StorageLike,
  sessionId: string,
  paymentId: string,
): boolean {
  if (!paymentId) return false;
  const current = readStoredQuoteSession(storage);
  if (!current || current.sessionId !== sessionId) return false;
  return saveQuoteSession(storage, {
    ...current,
    capturedPaymentId: paymentId,
  });
}

export function clearQuoteSession(storage: StorageLike): boolean {
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
