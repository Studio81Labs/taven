import { describe, expect, it } from "vitest";
import { canonicalTitle } from "./site-meta";

describe("canonicalTitle", () => {
  it("uses the product name as the canonical suffix", () => {
    expect(canonicalTitle("Quote")).toBe("Quote · Taven");
  });
});
