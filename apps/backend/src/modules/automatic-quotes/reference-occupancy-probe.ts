export type ReferenceOccupancyProbeBounds = {
  lowerBound: number;
  upperBound: number;
};

export function nextReferenceOccupancyProbe(
  quantity: number,
  bounds: ReferenceOccupancyProbeBounds,
): number | null {
  assertBounds(quantity, bounds);
  if (bounds.upperBound === bounds.lowerBound + 1) return null;
  if (bounds.upperBound === quantity + 1) return quantity;
  return Math.floor((bounds.lowerBound + bounds.upperBound) / 2);
}

export function recordReferenceOccupancyProbe(
  quantity: number,
  bounds: ReferenceOccupancyProbeBounds,
  partsPerPlate: number,
  fits: boolean,
): ReferenceOccupancyProbeBounds {
  const expected = nextReferenceOccupancyProbe(quantity, bounds);
  if (expected !== partsPerPlate) {
    throw new Error("Reference occupancy result is outside the probe frontier");
  }
  return fits
    ? { lowerBound: partsPerPlate, upperBound: bounds.upperBound }
    : { lowerBound: bounds.lowerBound, upperBound: partsPerPlate };
}

export function resolvedReferenceOccupancy(
  quantity: number,
  bounds: ReferenceOccupancyProbeBounds,
): number | null | undefined {
  assertBounds(quantity, bounds);
  if (bounds.upperBound !== bounds.lowerBound + 1) return undefined;
  return bounds.lowerBound === 0 ? null : bounds.lowerBound;
}

function assertBounds(
  quantity: number,
  bounds: ReferenceOccupancyProbeBounds,
): void {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !Number.isSafeInteger(bounds.lowerBound) ||
    !Number.isSafeInteger(bounds.upperBound) ||
    bounds.lowerBound < 0 ||
    bounds.upperBound > quantity + 1 ||
    bounds.lowerBound >= bounds.upperBound
  ) {
    throw new Error("Reference occupancy probe bounds are invalid");
  }
}
