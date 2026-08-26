import { describe, expect, it } from "vitest";
import { tavenTheme } from "./tokens";

describe("tavenTheme", () => {
  it("exposes the shared visual foundation", () => {
    expect(tavenTheme.color.accent).toBe("#d85d35");
    expect(tavenTheme.radius.panel).toBe("16px");
  });
});
