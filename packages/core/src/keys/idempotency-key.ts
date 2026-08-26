import {
  buildCanonicalKey,
  InvalidKeyComponentError,
  type KeyComponent,
} from "./canonical-key.js";

export type IdempotencyKey = string & {
  readonly __brand: "IdempotencyKey";
};
export type OutboxDedupeKey = string & {
  readonly __brand: "OutboxDedupeKey";
};

export function buildIdempotencyKey(
  operation: string,
  scope: readonly KeyComponent[],
): IdempotencyKey {
  if (operation.length === 0) {
    throw new InvalidKeyComponentError(
      "idempotency operation must not be empty",
    );
  }
  return buildCanonicalKey(`command-${operation}`, 1, scope) as IdempotencyKey;
}

export function buildOutboxDedupeKey(
  operation: string,
  scope: readonly KeyComponent[],
): OutboxDedupeKey {
  if (operation.length === 0) {
    throw new InvalidKeyComponentError("outbox operation must not be empty");
  }
  return buildCanonicalKey(`outbox-${operation}`, 1, scope) as OutboxDedupeKey;
}
