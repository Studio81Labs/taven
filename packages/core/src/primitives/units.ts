import { DomainError } from "./errors.js";

type UnitInput = bigint | number;

function integerBaseUnits(value: UnitInput, name: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new DomainError("INVALID_ARGUMENT", `${name} must be a safe integer`);
  }
  const integer = BigInt(value);
  if (integer < 0n) {
    throw new DomainError("NEGATIVE_RESULT", `${name} must not be negative`);
  }
  return integer;
}

abstract class NonNegativeUnit {
  protected constructor(readonly value: bigint) {
    Object.freeze(this);
  }

  equals(other: this): boolean {
    return this.value === other.value;
  }
}

/** Count expressed in indivisible base units. */
export class Quantity extends NonNegativeUnit {
  static of(value: UnitInput): Quantity {
    return new Quantity(integerBaseUnits(value, "quantity"));
  }

  get count(): bigint {
    return this.value;
  }
}

/** Weight expressed in integral milligrams to preserve slicer precision. */
export class Weight extends NonNegativeUnit {
  static milligrams(value: UnitInput): Weight {
    return new Weight(integerBaseUnits(value, "weight milligrams"));
  }

  static grams(value: UnitInput): Weight {
    return Weight.milligrams(integerBaseUnits(value, "weight grams") * 1_000n);
  }

  get milligrams(): bigint {
    return this.value;
  }
}

/** Duration expressed in integral seconds. */
export class Duration extends NonNegativeUnit {
  static seconds(value: UnitInput): Duration {
    return new Duration(integerBaseUnits(value, "duration seconds"));
  }

  get seconds(): bigint {
    return this.value;
  }
}
