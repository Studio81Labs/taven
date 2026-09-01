import { describe, expect, it } from "vitest";

import { candidatePlateCapacities } from "./candidate-plate-capacities";

describe("candidatePlateCapacities", () => {
  it.each([37, 72, 73, 1_000])(
    "keeps every capacity for quantity %i within the 36-plate contract",
    (quantity) => {
      const capacities = candidatePlateCapacities(quantity, "gcode_3mf");

      expect(
        capacities.every(
          (partsPerPlate) => Math.ceil(quantity / partsPerPlate) <= 36,
        ),
      ).toBe(true);
      expect(capacities.at(-1)).toBe(Math.ceil(quantity / 36));
    },
  );

  it("retains the single-part fallback when the quantity fits within 36 plates", () => {
    expect(candidatePlateCapacities(3, "gcode_3mf")).toEqual([3, 2, 1]);
  });

  it("only emits runtime-executable capacities for single-file formats", () => {
    expect(candidatePlateCapacities(3, "gcode")).toEqual([3]);
    expect(candidatePlateCapacities(3, "bgcode")).toEqual([]);
  });
});
