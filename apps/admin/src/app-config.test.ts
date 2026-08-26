import { describe, expect, it } from "vitest";
import { adminTitle } from "./app-config";

describe("adminTitle", () => {
  it("includes an explicitly named environment", () => {
    expect(adminTitle("local")).toBe("Taven Admin · local");
  });
});
