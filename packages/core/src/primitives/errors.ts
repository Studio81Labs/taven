import { DomainInvariantError } from "../invariant.js";

/** Stable error codes intended for command handlers and API adapters. */
export type DomainErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CURRENCY"
  | "CURRENCY_MISMATCH"
  | "DUPLICATE_COMPONENT_CREDIT"
  | "DUPLICATE_PAYMENT"
  | "NEGATIVE_RESULT"
  | "OVER_REFUND"
  | "DIVISION_BY_ZERO"
  | "INVALID_KEY_COMPONENT"
  | "INVALID_REVISION_REFERENCE"
  | "INVALID_INSTANT"
  | "INVALID_TRANSITION"
  | "TRANSITION_GUARD_FAILED";

/** A domain invariant failure with a machine-readable, stable cause. */
export class DomainError extends DomainInvariantError {
  override readonly name: string = "DomainError";

  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}
