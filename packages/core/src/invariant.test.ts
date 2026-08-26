import { describe, expect, it } from "vitest";
import { assertInvariant, DomainInvariantError } from "./invariant.js";

describe("assertInvariant", () => {
  it("throws a domain-specific error for a failed invariant", () => {
    expect(() => assertInvariant(false, "invalid state")).toThrow(
      new DomainInvariantError("invalid state"),
    );
  });

  it("does not throw for a satisfied invariant", () => {
    expect(() => assertInvariant(true, "unreachable")).not.toThrow();
  });
});
