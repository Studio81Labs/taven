import { describe, expect, it } from "vitest";
import { validateRevisionBundle } from "./preset-bundle.js";

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
});
