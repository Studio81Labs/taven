import { describe, expect, it } from "vitest";
import { assertRevisionPresetBundle } from "./preset-bundle";

describe("assertRevisionPresetBundle", () => {
  it("rejects a process preset with filament settings markers", () => {
    expect(() =>
      assertRevisionPresetBundle(
        {
          bundleVersion: 1,
          presets: [
            { type: "machine" },
            { type: "process", filament_settings_id: ["PLA"] },
            { type: "filament" },
          ],
        },
        "reference",
      ),
    ).toThrow("conflicting type and filament settings markers");
  });
});
