import { describe, expect, it } from "vitest";
import { ResourceValidationError } from "./resource-errors";
import { canonicalJson, resourceRevisionDigest } from "./resource-identity";

describe("resourceRevisionDigest", () => {
  it("is stable across object key order and changes with immutable content", () => {
    const first = resourceRevisionDigest("MACHINE_PROFILE", {
      material: "PLA",
      settings: { speed: 100, cooling: true },
    });
    const reordered = resourceRevisionDigest("MACHINE_PROFILE", {
      settings: { cooling: true, speed: 100 },
      material: "PLA",
    });
    const changed = resourceRevisionDigest("MACHINE_PROFILE", {
      material: "PLA",
      settings: { speed: 101, cooling: true },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("rejects blank kinds and non-finite settings", () => {
    expect(() => resourceRevisionDigest(" ", {})).toThrow(
      ResourceValidationError,
    );
    expect(() =>
      resourceRevisionDigest("REFERENCE_PROFILE", {
        invalid: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(ResourceValidationError);
  });

  it("uses a locale-independent total order for Unicode object keys", () => {
    const first = {
      é: "composed",
      "e\u0301": "decomposed",
    };
    const reordered = {
      "e\u0301": "decomposed",
      é: "composed",
    };

    expect(canonicalJson(first)).toBe(canonicalJson(reordered));
    expect(resourceRevisionDigest("REFERENCE_PROFILE", first)).toBe(
      resourceRevisionDigest("REFERENCE_PROFILE", reordered),
    );
  });
});
