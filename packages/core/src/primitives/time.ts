import { DomainError } from "./errors.js";
import type { Duration } from "./units.js";

const MIN_DATE_EPOCH_MILLISECONDS = -8_640_000_000_000_000;
const MAX_DATE_EPOCH_MILLISECONDS = 8_640_000_000_000_000;

/** Immutable UTC instant with integral millisecond precision. */
export class Instant {
  readonly epochMilliseconds: number;

  private constructor(epochMilliseconds: number) {
    this.epochMilliseconds = epochMilliseconds;
    Object.freeze(this);
  }

  static fromEpochMilliseconds(epochMilliseconds: number): Instant {
    if (!Number.isSafeInteger(epochMilliseconds)) {
      throw new DomainError(
        "INVALID_INSTANT",
        "epoch milliseconds must be a safe integer",
      );
    }
    if (
      epochMilliseconds < MIN_DATE_EPOCH_MILLISECONDS ||
      epochMilliseconds > MAX_DATE_EPOCH_MILLISECONDS
    ) {
      throw new DomainError(
        "INVALID_INSTANT",
        "epoch milliseconds must be within the JavaScript Date range",
      );
    }
    return new Instant(epochMilliseconds);
  }

  static parse(isoTimestamp: string): Instant {
    const epochMilliseconds = Date.parse(isoTimestamp);
    if (
      !Number.isFinite(epochMilliseconds) ||
      new Date(epochMilliseconds).toISOString() !== isoTimestamp
    ) {
      throw new DomainError(
        "INVALID_INSTANT",
        "timestamp must be canonical UTC ISO-8601 with millisecond precision",
      );
    }
    return Instant.fromEpochMilliseconds(epochMilliseconds);
  }

  add(duration: Duration): Instant {
    const result = BigInt(this.epochMilliseconds) + duration.seconds * 1_000n;
    if (
      result < BigInt(Number.MIN_SAFE_INTEGER) ||
      result > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new DomainError(
        "INVALID_INSTANT",
        "instant plus duration exceeds safe millisecond precision",
      );
    }
    return Instant.fromEpochMilliseconds(Number(result));
  }

  compare(other: Instant): -1 | 0 | 1 {
    if (this.epochMilliseconds === other.epochMilliseconds) return 0;
    return this.epochMilliseconds < other.epochMilliseconds ? -1 : 1;
  }

  equals(other: Instant): boolean {
    return this.epochMilliseconds === other.epochMilliseconds;
  }

  toISOString(): string {
    return new Date(this.epochMilliseconds).toISOString();
  }
}

/** Inject this into domain policies; do not read the system clock in policies. */
export interface Clock {
  now(): Instant;
}

/** A deterministic clock for tests and replayable policy evaluation. */
export class FixedClock implements Clock {
  constructor(private readonly instant: Instant) {
    Object.freeze(this);
  }

  now(): Instant {
    return this.instant;
  }
}
