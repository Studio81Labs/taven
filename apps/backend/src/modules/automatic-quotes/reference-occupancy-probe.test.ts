import { describe, expect, it } from "vitest";
import {
  nextReferenceOccupancyProbe,
  recordReferenceOccupancyProbe,
  resolvedReferenceOccupancy,
} from "./reference-occupancy-probe";

function resolve(quantity: number, capacity: number) {
  let bounds = { lowerBound: 0, upperBound: quantity + 1 };
  const probes: number[] = [];
  while (resolvedReferenceOccupancy(quantity, bounds) === undefined) {
    const probe = nextReferenceOccupancyProbe(quantity, bounds);
    if (probe === null) throw new Error("probe unexpectedly resolved");
    probes.push(probe);
    bounds = recordReferenceOccupancyProbe(
      quantity,
      bounds,
      probe,
      probe <= capacity,
    );
  }
  return { probes, resolved: resolvedReferenceOccupancy(quantity, bounds) };
}

describe("reference occupancy probing", () => {
  it.each([
    { quantity: 1, capacity: 1 },
    { quantity: 6, capacity: 3 },
    { quantity: 6, capacity: 4 },
    { quantity: 7, capacity: 3 },
    { quantity: 1_000, capacity: 427 },
  ])("finds the exact maximum occupancy for $quantity / $capacity", (input) => {
    const result = resolve(input.quantity, input.capacity);
    expect(result.resolved).toBe(input.capacity);
    expect(result.probes.length).toBeLessThanOrEqual(11);
  });

  it("reports that even one part cannot be arranged", () => {
    expect(resolve(6, 0)).toMatchObject({ resolved: null });
  });

  it("starts with the requested quantity and rejects out-of-frontier results", () => {
    const bounds = { lowerBound: 0, upperBound: 7 };
    expect(nextReferenceOccupancyProbe(6, bounds)).toBe(6);
    expect(() => recordReferenceOccupancyProbe(6, bounds, 3, true)).toThrow(
      "outside the probe frontier",
    );
  });
});
