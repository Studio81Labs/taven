/** Deterministic, conservative, axis-aligned parcel planning. */

export type Axis = "X" | "Y" | "Z";

export interface ShipmentBox {
  readonly xMicrometers: bigint;
  readonly yMicrometers: bigint;
  readonly zMicrometers: bigint;
}

export interface ShipmentPackingUnit {
  readonly packingUnitKey: string;
  /** Protective (already packaged) bounding box. */
  readonly box: ShipmentBox;
  readonly weightMilligrams: bigint;
}

export interface ShipmentCategory {
  readonly id: string;
  readonly maxXMicrometers: bigint;
  readonly maxYMicrometers: bigint;
  readonly maxZMicrometers: bigint;
  readonly maxWeightMilligrams: bigint;
  readonly maxParcelVolumeCubicMicrometers: bigint;
}

export interface ShipmentPlannerInput {
  readonly units: readonly ShipmentPackingUnit[];
  /** Already ordered by the versioned PriceList priority. */
  readonly categories: readonly ShipmentCategory[];
  /** Categories allowed by the selected endpoint capability snapshot. */
  readonly supportedCategoryIds: ReadonlySet<string>;
  readonly fillCoefficientNumerator: bigint;
  readonly fillCoefficientDenominator: bigint;
  readonly packagingWeightMilligrams: bigint;
}

export interface ShipmentPlacement {
  readonly packingUnitKey: string;
  readonly orientedBox: ShipmentBox;
  readonly axis: Axis;
  readonly originMicrometers: {
    readonly x: bigint;
    readonly y: bigint;
    readonly z: bigint;
  };
  readonly packingBoxAfterPlacement: ShipmentBox;
}

export interface ShipmentParcel {
  readonly ordinal: number;
  readonly categoryId: string;
  readonly packingBox: ShipmentBox;
  readonly volumeProxyCubicMicrometers: bigint;
  readonly weightMilligrams: bigint;
  readonly placements: readonly ShipmentPlacement[];
}

export interface ShipmentPlanSuccess {
  readonly status: "planned";
  readonly parcels: readonly ShipmentParcel[];
}

export interface ShipmentPlanNoFit {
  readonly status: "no_fit";
  readonly packingUnitKey: string;
  readonly supportedCategoryIds: readonly string[];
}

export type ShipmentPlanResult = ShipmentPlanSuccess | ShipmentPlanNoFit;

const AXES: readonly Axis[] = ["X", "Y", "Z"];

function positive(value: bigint, name: string): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}

function validateBox(box: ShipmentBox, name: string): void {
  positive(box.xMicrometers, `${name}.xMicrometers`);
  positive(box.yMicrometers, `${name}.yMicrometers`);
  positive(box.zMicrometers, `${name}.zMicrometers`);
}

function volume(box: ShipmentBox): bigint {
  return box.xMicrometers * box.yMicrometers * box.zMicrometers;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rotations(box: ShipmentBox): ShipmentBox[] {
  const values = [box.xMicrometers, box.yMicrometers, box.zMicrometers];
  const result: ShipmentBox[] = [];
  const seen = new Set<string>();
  for (const first of [0, 1, 2])
    for (const second of [0, 1, 2]) {
      if (second === first) continue;
      const third = 3 - first - second;
      const orientation = {
        xMicrometers: values[first]!,
        yMicrometers: values[second]!,
        zMicrometers: values[third]!,
      };
      const key = `${orientation.xMicrometers},${orientation.yMicrometers},${orientation.zMicrometers}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(orientation);
      }
    }
  result.sort(
    (a, b) =>
      compareBigInt(a.xMicrometers, b.xMicrometers) ||
      compareBigInt(a.yMicrometers, b.yMicrometers) ||
      compareBigInt(a.zMicrometers, b.zMicrometers),
  );
  return result;
}

function placedBox(
  current: ShipmentBox | null,
  candidate: ShipmentBox,
  axis: Axis,
): ShipmentBox {
  if (current === null) return candidate;
  return axis === "X"
    ? {
        xMicrometers: current.xMicrometers + candidate.xMicrometers,
        yMicrometers:
          current.yMicrometers > candidate.yMicrometers
            ? current.yMicrometers
            : candidate.yMicrometers,
        zMicrometers:
          current.zMicrometers > candidate.zMicrometers
            ? current.zMicrometers
            : candidate.zMicrometers,
      }
    : axis === "Y"
      ? {
          xMicrometers:
            current.xMicrometers > candidate.xMicrometers
              ? current.xMicrometers
              : candidate.xMicrometers,
          yMicrometers: current.yMicrometers + candidate.yMicrometers,
          zMicrometers:
            current.zMicrometers > candidate.zMicrometers
              ? current.zMicrometers
              : candidate.zMicrometers,
        }
      : {
          xMicrometers:
            current.xMicrometers > candidate.xMicrometers
              ? current.xMicrometers
              : candidate.xMicrometers,
          yMicrometers:
            current.yMicrometers > candidate.yMicrometers
              ? current.yMicrometers
              : candidate.yMicrometers,
          zMicrometers: current.zMicrometers + candidate.zMicrometers,
        };
}

function fits(
  category: ShipmentCategory,
  box: ShipmentBox,
  weight: bigint,
  volumeProxy: bigint,
): boolean {
  return (
    box.xMicrometers <= category.maxXMicrometers &&
    box.yMicrometers <= category.maxYMicrometers &&
    box.zMicrometers <= category.maxZMicrometers &&
    weight <= category.maxWeightMilligrams &&
    volumeProxy <= category.maxParcelVolumeCubicMicrometers
  );
}

interface Candidate {
  readonly box: ShipmentBox;
  readonly orientedBox: ShipmentBox;
  readonly axis: Axis;
  readonly volumeProxy: bigint;
  readonly weight: bigint;
  readonly originMicrometers: ShipmentPlacement["originMicrometers"];
}

function candidateFor(
  category: ShipmentCategory,
  current: ShipmentParcel | null,
  unit: ShipmentPackingUnit,
  orientation: ShipmentBox,
  axis: Axis,
  fillNumerator: bigint,
  fillDenominator: bigint,
  packagingWeight: bigint,
): Candidate | undefined {
  const box = placedBox(current?.packingBox ?? null, orientation, axis);
  const originMicrometers =
    current === null
      ? { x: 0n, y: 0n, z: 0n }
      : axis === "X"
        ? { x: current.packingBox.xMicrometers, y: 0n, z: 0n }
        : axis === "Y"
          ? { x: 0n, y: current.packingBox.yMicrometers, z: 0n }
          : { x: 0n, y: 0n, z: current.packingBox.zMicrometers };
  const weight =
    (current?.weightMilligrams ?? packagingWeight) + unit.weightMilligrams;
  const currentRawVolume =
    current?.placements.reduce(
      (sum, placement) => sum + volume(placement.orientedBox),
      0n,
    ) ?? 0n;
  const rawVolume =
    currentRawVolume * fillDenominator + volume(orientation) * fillDenominator;
  const volumeProxy = ceilDivide(rawVolume, fillNumerator);
  return fits(category, box, weight, volumeProxy)
    ? {
        box,
        orientedBox: orientation,
        axis,
        volumeProxy,
        weight,
        originMicrometers,
      }
    : undefined;
}

function candidateCompare(a: Candidate, b: Candidate): number {
  const aLongest = [
    a.box.xMicrometers,
    a.box.yMicrometers,
    a.box.zMicrometers,
  ].reduce((x, y) => (x > y ? x : y));
  const bLongest = [
    b.box.xMicrometers,
    b.box.yMicrometers,
    b.box.zMicrometers,
  ].reduce((x, y) => (x > y ? x : y));
  return (
    compareBigInt(volume(a.box), volume(b.box)) ||
    compareBigInt(aLongest, bLongest) ||
    compareBigInt(a.box.xMicrometers, b.box.xMicrometers) ||
    compareBigInt(a.box.yMicrometers, b.box.yMicrometers) ||
    compareBigInt(a.box.zMicrometers, b.box.zMicrometers) ||
    compareBigInt(a.orientedBox.xMicrometers, b.orientedBox.xMicrometers) ||
    compareBigInt(a.orientedBox.yMicrometers, b.orientedBox.yMicrometers) ||
    compareBigInt(a.orientedBox.zMicrometers, b.orientedBox.zMicrometers) ||
    AXES.indexOf(a.axis) - AXES.indexOf(b.axis)
  );
}

function sortedUnits(
  units: readonly ShipmentPackingUnit[],
): ShipmentPackingUnit[] {
  return [...units].sort((a, b) => {
    const aLongest = [
      a.box.xMicrometers,
      a.box.yMicrometers,
      a.box.zMicrometers,
    ].reduce((x, y) => (x > y ? x : y));
    const bLongest = [
      b.box.xMicrometers,
      b.box.yMicrometers,
      b.box.zMicrometers,
    ].reduce((x, y) => (x > y ? x : y));
    return (
      compareBigInt(bLongest, aLongest) ||
      compareBigInt(volume(b.box), volume(a.box)) ||
      compareStrings(a.packingUnitKey, b.packingUnitKey)
    );
  });
}

export function planShipment(input: ShipmentPlannerInput): ShipmentPlanResult {
  if (
    input.fillCoefficientNumerator <= 0n ||
    input.fillCoefficientDenominator <= 0n ||
    input.fillCoefficientNumerator > input.fillCoefficientDenominator
  )
    throw new RangeError("fill coefficient must be in the interval (0, 1]");
  if (input.packagingWeightMilligrams < 0n)
    throw new RangeError("packaging weight must not be negative");
  const categoryIds = new Set<string>();
  for (const category of input.categories) {
    if (!category.id) throw new RangeError("category ID must not be empty");
    if (categoryIds.has(category.id)) {
      throw new RangeError("category IDs must be unique");
    }
    categoryIds.add(category.id);
  }
  const categories = input.categories.filter((category) =>
    input.supportedCategoryIds.has(category.id),
  );
  const packingUnitKeys = new Set<string>();
  for (const unit of input.units) {
    if (!unit.packingUnitKey)
      throw new RangeError("packingUnitKey must not be empty");
    if (packingUnitKeys.has(unit.packingUnitKey)) {
      throw new RangeError("packingUnitKey values must be unique");
    }
    packingUnitKeys.add(unit.packingUnitKey);
    validateBox(unit.box, `unit ${unit.packingUnitKey}`);
    if (unit.weightMilligrams < 0n)
      throw new RangeError("unit weight must not be negative");
  }
  for (const category of categories) {
    validateBox(
      {
        xMicrometers: category.maxXMicrometers,
        yMicrometers: category.maxYMicrometers,
        zMicrometers: category.maxZMicrometers,
      },
      `category ${category.id}`,
    );
    positive(
      category.maxWeightMilligrams,
      `category ${category.id}.maxWeightMilligrams`,
    );
    positive(
      category.maxParcelVolumeCubicMicrometers,
      `category ${category.id}.maxParcelVolumeCubicMicrometers`,
    );
  }
  const parcels: ShipmentParcel[] = [];
  for (const unit of sortedUnits(input.units)) {
    let placed = false;
    for (let index = 0; index < parcels.length && !placed; index += 1) {
      const parcel = parcels[index]!;
      const category = categories.find(
        (candidate) => candidate.id === parcel.categoryId,
      )!;
      const candidates = rotations(unit.box).flatMap((orientation) =>
        AXES.map((axis) =>
          candidateFor(
            category,
            parcel,
            unit,
            orientation,
            axis,
            input.fillCoefficientNumerator,
            input.fillCoefficientDenominator,
            input.packagingWeightMilligrams,
          ),
        ).filter(
          (candidate): candidate is Candidate => candidate !== undefined,
        ),
      );
      if (candidates.length === 0) continue;
      candidates.sort(candidateCompare);
      const selected = candidates[0]!;
      parcels[index] = {
        ...parcel,
        packingBox: selected.box,
        volumeProxyCubicMicrometers: selected.volumeProxy,
        weightMilligrams: selected.weight,
        placements: [
          ...parcel.placements,
          {
            packingUnitKey: unit.packingUnitKey,
            orientedBox: selected.orientedBox,
            axis: selected.axis,
            originMicrometers: selected.originMicrometers,
            packingBoxAfterPlacement: selected.box,
          },
        ],
      };
      placed = true;
    }
    if (placed) continue;
    let newParcel: ShipmentParcel | undefined;
    for (const category of categories) {
      const candidates = rotations(unit.box)
        .map((orientation) =>
          candidateFor(
            category,
            null,
            unit,
            orientation,
            "X",
            input.fillCoefficientNumerator,
            input.fillCoefficientDenominator,
            input.packagingWeightMilligrams,
          ),
        )
        .filter((candidate): candidate is Candidate => candidate !== undefined);
      if (candidates.length === 0) continue;
      candidates.sort(candidateCompare);
      const selected = candidates[0]!;
      newParcel = {
        ordinal: parcels.length + 1,
        categoryId: category.id,
        packingBox: selected.box,
        volumeProxyCubicMicrometers: selected.volumeProxy,
        weightMilligrams: selected.weight,
        placements: [
          {
            packingUnitKey: unit.packingUnitKey,
            orientedBox: selected.orientedBox,
            axis: selected.axis,
            originMicrometers: selected.originMicrometers,
            packingBoxAfterPlacement: selected.box,
          },
        ],
      };
      break;
    }
    if (!newParcel)
      return {
        status: "no_fit",
        packingUnitKey: unit.packingUnitKey,
        supportedCategoryIds: categories.map(({ id }) => id),
      };
    parcels.push(newParcel);
  }
  return { status: "planned", parcels };
}

/** Adds the versioned reserve to both sides of each source-bbox dimension. */
export function expandShipmentBox(
  source: ShipmentBox,
  reservePerSideMicrometers: bigint,
): ShipmentBox {
  validateBox(source, "source box");
  if (reservePerSideMicrometers < 0n) {
    throw new RangeError("packaging reserve must not be negative");
  }
  const totalReserve = reservePerSideMicrometers * 2n;
  return {
    xMicrometers: source.xMicrometers + totalReserve,
    yMicrometers: source.yMicrometers + totalReserve,
    zMicrometers: source.zMicrometers + totalReserve,
  };
}
