import { describe, expect, it } from "vitest";
import { DomainError } from "../primitives/errors.js";
import {
  allocateHandlingSession,
  calculateHandlingCostMinor,
} from "./handling.js";

describe("handling allocation", () => {
  it("rounds one session before allocating its exact cost and duration", () => {
    expect(
      calculateHandlingCostMinor(1_001n, {
        numerator: 15n,
        denominator: 1_000n,
      }),
    ).toBe(1n);

    expect(
      allocateHandlingSession(5n, 7n, [
        { id: "b", servedUnits: 1n },
        { id: "a", servedUnits: 1n },
        { id: "c", servedUnits: 2n },
      ]),
    ).toEqual([
      {
        targetId: "b",
        allocatedDurationMilliseconds: 1n,
        allocatedCostMinor: 2n,
      },
      {
        targetId: "a",
        allocatedDurationMilliseconds: 1n,
        allocatedCostMinor: 2n,
      },
      {
        targetId: "c",
        allocatedDurationMilliseconds: 3n,
        allocatedCostMinor: 3n,
      },
    ]);
  });

  it("rejects incomplete or invalid allocation evidence", () => {
    expect(() => allocateHandlingSession(1n, 1n, [])).toThrow(DomainError);
    expect(() =>
      allocateHandlingSession(1n, 1n, [{ id: "slot", servedUnits: 0n }]),
    ).toThrow(DomainError);
    expect(() =>
      calculateHandlingCostMinor(0n, { numerator: 1n, denominator: 1n }),
    ).toThrow(DomainError);
  });
});
