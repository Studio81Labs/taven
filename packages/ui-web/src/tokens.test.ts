import { describe, expect, it } from "vitest";
import { tavenTheme } from "./tokens";

describe("tavenTheme", () => {
  it("exposes the shared visual foundation", () => {
    expect(tavenTheme.color.accent).toBe("#1b44e8");
    expect(tavenTheme.color.ink).toBe("#1a1a16");
    expect(tavenTheme.color.paper).toBe("#efefea");
    expect(tavenTheme.radius.panel).toBe("16px");
  });
});
