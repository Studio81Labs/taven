import { describe, expect, it } from "vitest";
import {
  materializePresetBundles,
  validateRevisionBundle,
} from "./preset-bundle.js";

describe("validateRevisionBundle", () => {
  it("rejects a process preset with filament settings markers", () => {
    expect(() =>
      validateRevisionBundle(
        {
          bundleVersion: 1,
          presets: [
            { type: "machine" },
            { type: "process", filament_settings_id: ["PLA"] },
            { type: "filament" },
          ],
        },
        "machine",
      ),
    ).toThrow("conflicting type and filament settings markers");
  });

  it("merges print and calibration overrides into one process preset", () => {
    const process = {
      type: "process",
      layer_height: "0.28",
      sparse_infill_density: "15%",
    };
    const materialized = materializePresetBundles([
      {
        kind: "machine",
        presets: [
          { type: "machine", name: "machine" },
          process,
          { type: "filament", name: "filament" },
        ],
      },
      {
        kind: "print",
        presets: [{ layer_height: "0.2", sparse_infill_density: "10%" }],
      },
      { kind: "calibration", presets: [{ layer_height: "0.18" }] },
    ]);

    expect(materialized.settings).toEqual([
      { type: "machine", name: "machine" },
      {
        type: "process",
        layer_height: "0.18",
        sparse_infill_density: "10%",
      },
    ]);
    expect(materialized.filaments).toEqual([
      { type: "filament", name: "filament" },
    ]);
    expect(process.layer_height).toBe("0.28");
  });

  it("rejects unknown, inherited, and denied override keys before materialization", () => {
    expect(() =>
      materializePresetBundles([
        {
          kind: "reference",
          presets: [
            { type: "machine" },
            { type: "process", layer_height: "0.2" },
            { type: "filament" },
          ],
        },
        { kind: "print", presets: [{ unknown_override: "1" }] },
      ]),
    ).toThrow("unknown_override is absent from the process preset");
    expect(() =>
      materializePresetBundles([
        {
          kind: "reference",
          presets: [
            { type: "machine" },
            { type: "process", layer_height: "0.2" },
            { type: "filament" },
          ],
        },
        { kind: "print", presets: [{ constructor: "unsafe" }] },
      ]),
    ).toThrow("constructor is absent from the process preset");
    expect(() =>
      validateRevisionBundle(
        { bundleVersion: 1, presets: [{ post_process: "rm -rf /" }] },
        "print",
      ),
    ).toThrow("post_process is not permitted");
  });
});
