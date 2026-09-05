import type { components } from "@taven/openapi-client";
import type { StorageLike } from "./quote-session-storage";

const STORAGE_KEY = "taven:checkout-session:v1";

export type CheckoutBilling = components["schemas"]["CheckoutBillingDto"];
export type CheckoutPaymentMethod =
  components["schemas"]["CreateCheckoutPaymentDto"]["method"];

export interface CheckoutCustomerDraft {
  acceptClaimPolicy: boolean;
  acceptTerms: boolean;
  acknowledgeWithdrawalException: boolean;
  billing: CheckoutBilling;
  email: string;
  fullName: string;
  method: CheckoutPaymentMethod;
  photoPublicationConsent: boolean;
}

export interface CheckoutCommandHandoff {
  checkoutUrl?: string;
  idempotencyKey: string;
  paymentId?: string;
  requestFingerprint: string;
}

export interface StoredCheckoutSession {
  command?: CheckoutCommandHandoff;
  draft?: CheckoutCustomerDraft;
  sessionId: string;
}

export function checkoutRequestFingerprint(value: unknown): string {
  return canonicalJson(value);
}

export function recoverableCheckoutDraft(
  value: CheckoutCustomerDraft,
): CheckoutCustomerDraft {
  return {
    ...value,
    billing: { ...value.billing },
    acceptClaimPolicy: false,
    acceptTerms: false,
    acknowledgeWithdrawalException: false,
    photoPublicationConsent: false,
  };
}

export function loadCheckoutSession(
  storage: StorageLike,
  sessionId: string,
): StoredCheckoutSession | undefined {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredCheckoutSession(parsed) || parsed.sessionId !== sessionId) {
      storage.removeItem(STORAGE_KEY);
      return undefined;
    }
    return parsed;
  } catch {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Storage is optional; the active in-memory checkout remains usable.
    }
    return undefined;
  }
}

export function saveCheckoutSession(
  storage: StorageLike,
  value: StoredCheckoutSession,
): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearCheckoutSession(storage: StorageLike): boolean {
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function redactCheckoutCustomerInput(
  storage: StorageLike,
  sessionId: string,
): boolean {
  const current = loadCheckoutSession(storage, sessionId);
  if (!current) return false;
  return saveCheckoutSession(storage, {
    sessionId,
    ...(current.command ? { command: current.command } : {}),
  });
}

function isStoredCheckoutSession(
  value: unknown,
): value is StoredCheckoutSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || !record.sessionId) return false;
  if (record.command !== undefined && !isCommand(record.command)) return false;
  return record.draft === undefined || isDraft(record.draft);
}

function isCommand(value: unknown): value is CheckoutCommandHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.idempotencyKey === "string" &&
    record.idempotencyKey.length >= 8 &&
    typeof record.requestFingerprint === "string" &&
    record.requestFingerprint.length > 0 &&
    optionalString(record.paymentId) &&
    optionalString(record.checkoutUrl)
  );
}

function isDraft(value: unknown): value is CheckoutCustomerDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const billing = record.billing;
  if (!billing || typeof billing !== "object" || Array.isArray(billing)) {
    return false;
  }
  const address = billing as Record<string, unknown>;
  return (
    [record.email, record.fullName].every((item) => typeof item === "string") &&
    [
      record.acceptClaimPolicy,
      record.acceptTerms,
      record.acknowledgeWithdrawalException,
      record.photoPublicationConsent,
    ].every((item) => typeof item === "boolean") &&
    (record.method === "CARD" || record.method === "BANK_TRANSFER") &&
    [
      address.name,
      address.addressLine1,
      address.city,
      address.postalCode,
      address.countryCode,
    ].every((item) => typeof item === "string") &&
    [
      address.addressLine2,
      address.companyName,
      address.companyId,
      address.vatId,
    ].every(optionalString)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
