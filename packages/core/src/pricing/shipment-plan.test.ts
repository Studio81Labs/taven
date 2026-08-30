import { describe, expect, it } from "vitest";
import {
  expandShipmentBox,
  planShipment,
  type ShipmentCategory,
  type ShipmentPackingUnit,
} from "./shipment-plan.js";

const category = (id: string, max = 100n): ShipmentCategory => ({
  id,
  maxXMicrometers: max,
  maxYMicrometers: max,
  maxZMicrometers: max,
  maxDimensionSumMicrometers: max * 3n,
  maxWeightMilligrams: 100_000n,
  maxParcelVolumeCubicMicrometers: 1_000_000n,
});
const unit = (
  key: string,
  x: bigint,
  y = 10n,
  z = 10n,
  weight = 1_000n,
): ShipmentPackingUnit => ({
  packingUnitKey: key,
  box: { xMicrometers: x, yMicrometers: y, zMicrometers: z },
  weightMilligrams: weight,
});
const input = (
  units: readonly ShipmentPackingUnit[],
  categories = [category("box")],
) => ({
  units,
  categories,
  supportedCategoryIds: new Set(categories.map(({ id }) => id)),
  fillCoefficientNumerator: 55n,
  fillCoefficientDenominator: 100n,
  packagingWeightMilligrams: 100n,
});

describe("planShipment", () => {
  it("sorts units by dimensions then stable key and is deterministic", () => {
    const a = planShipment(
      input([unit("b", 20n), unit("a", 20n), unit("c", 10n)]),
    );
    const b = planShipment(
      input([unit("c", 10n), unit("a", 20n), unit("b", 20n)]),
    );
    expect(a).toEqual(b);
    expect(a.status).toBe("planned");
    if (a.status === "planned")
      expect(
        a.parcels[0]?.placements.map(({ packingUnitKey }) => packingUnitKey),
      ).toEqual(["a", "b", "c"]);
  });

  it("uses the first existing parcel and the documented candidate tie-break", () => {
    const elongated = {
      ...category("line", 100n),
      maxYMicrometers: 10n,
      maxZMicrometers: 10n,
    };
    const result = planShipment(
      input([unit("a", 60n), unit("b", 40n), unit("c", 40n)], [elongated]),
    );
    expect(result.status).toBe("planned");
    if (result.status === "planned") {
      expect(result.parcels).toHaveLength(2);
      expect(
        result.parcels[0]?.placements.map(
          ({ packingUnitKey }) => packingUnitKey,
        ),
      ).toEqual(["a", "b"]);
      expect(
        result.parcels[1]?.placements.map(
          ({ packingUnitKey }) => packingUnitKey,
        ),
      ).toEqual(["c"]);
    }
  });

  it("filters endpoint categories and honors category priority for new parcels", () => {
    const small = category("small", 15n);
    const large = category("large", 100n);
    const result = planShipment(input([unit("a", 20n)], [small, large]));
    expect(result).toMatchObject({
      status: "planned",
      parcels: [{ categoryId: "large" }],
    });
    const unsupported = planShipment({
      ...input([unit("a", 20n)], [small, large]),
      supportedCategoryIds: new Set(["small"]),
    });
    expect(unsupported).toEqual({
      status: "no_fit",
      packingUnitKey: "a",
      supportedCategoryIds: ["small"],
    });
  });

  it("checks weight and conservative volume proxy", () => {
    expect(
      planShipment(
        input([unit("a", 10n, 10n, 10n, 100_000n)], [category("box")]),
      ),
    ).toMatchObject({ status: "no_fit" });
    const limited = {
      ...category("box"),
      maxParcelVolumeCubicMicrometers: 1_800n,
    };
    expect(
      planShipment(input([unit("a", 10n, 10n, 10n)], [limited])),
    ).toMatchObject({ status: "no_fit" });
  });

  it("enforces the aggregate dimension-sum ceiling", () => {
    const pickup = {
      ...category("pickup", 60n),
      maxDimensionSumMicrometers: 120n,
      maxParcelVolumeCubicMicrometers: 64_000n,
    };
    const result = planShipment(input([unit("a", 60n, 50n, 11n)], [pickup]));

    expect(result).toEqual({
      status: "no_fit",
      packingUnitKey: "a",
      supportedCategoryIds: ["pickup"],
    });
  });

  it("enumerates unique rotations and records the selected placement", () => {
    const result = planShipment(
      input([unit("a", 90n, 20n, 10n)], [category("box", 100n)]),
    );
    expect(result.status).toBe("planned");
    if (result.status === "planned") {
      expect(result.parcels[0]?.placements[0]?.orientedBox).toEqual({
        xMicrometers: 10n,
        yMicrometers: 20n,
        zMicrometers: 90n,
      });
      expect(result.parcels[0]?.packingBox).toEqual({
        xMicrometers: 10n,
        yMicrometers: 20n,
        zMicrometers: 90n,
      });
      expect(result.parcels[0]?.placements[0]).toMatchObject({
        originMicrometers: { x: 0n, y: 0n, z: 0n },
        packingBoxAfterPlacement: {
          xMicrometers: 10n,
          yMicrometers: 20n,
          zMicrometers: 90n,
        },
      });
    }
  });

  it("accepts exact dimension, weight, and volume ceilings", () => {
    const exact = {
      ...category("exact", 10n),
      maxWeightMilligrams: 1_100n,
      maxParcelVolumeCubicMicrometers: 2_000n,
    };
    const result = planShipment(input([unit("a", 10n)], [exact]));
    expect(result).toMatchObject({
      status: "planned",
      parcels: [
        {
          weightMilligrams: 1_100n,
          volumeProxyCubicMicrometers: 1_819n,
        },
      ],
    });
  });

  it("expands every bbox side by the versioned packaging reserve", () => {
    expect(
      expandShipmentBox(
        { xMicrometers: 10n, yMicrometers: 20n, zMicrometers: 30n },
        4n,
      ),
    ).toEqual({
      xMicrometers: 18n,
      yMicrometers: 28n,
      zMicrometers: 38n,
    });
  });

  it("rejects invalid numeric input", () => {
    expect(() => planShipment(input([unit("a", 0n)]))).toThrow();
    expect(() =>
      planShipment({ ...input([]), fillCoefficientNumerator: 0n }),
    ).toThrow();
    expect(() =>
      planShipment({
        ...input([]),
        fillCoefficientNumerator: 101n,
        fillCoefficientDenominator: 100n,
      }),
    ).toThrow();
    expect(() => planShipment(input([unit("a", 1n), unit("a", 1n)]))).toThrow(
      /unique/,
    );
  });
});
