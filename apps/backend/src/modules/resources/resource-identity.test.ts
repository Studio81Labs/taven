import { describe, expect, it } from "vitest";
import { ResourceValidationError } from "./resource-errors";
import {
  canonicalCatalogCommandJson,
  canonicalJson,
  resourceRevisionDigest,
} from "./resource-identity";

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

  it("preserves historical revision serialization bytes and digests", () => {
    const payload = {
      B: "uppercase",
      a: "lowercase",
      10: "ten",
      2: "two",
      nested: { z: [3, { B: "second", a: "first" }], a: true },
      "e\u0301": "decomposed",
      é: "composed",
      "😀": "astral",
      "\uE000": "bmp-private",
      escaped: 'line\nbreak\tquote\\slash"',
      negative: -0,
      decimal: 1.25,
    };

    expect(canonicalJson(payload)).toBe(
      String.raw`{"😀":"astral","10":"ten","2":"two","a":"lowercase","B":"uppercase","decimal":1.25,"é":"decomposed","é":"composed","escaped":"line\nbreak\tquote\\slash\"","negative":0,"nested":{"a":true,"z":[3,{"a":"first","B":"second"}]},"":"bmp-private"}`,
    );
    expect(resourceRevisionDigest("REFERENCE_PROFILE", payload)).toBe(
      "f36fc1b10cdfeadeb74cf006140ff1d73983a740755d205f0d4d0e2cb4f0d304",
    );
  });

  it("uses a code-unit total order for catalog command fingerprints", () => {
    const first = {
      é: "composed",
      "e\u0301": "decomposed",
      nested: { B: "uppercase", a: "lowercase" },
    };
    const reordered = {
      nested: { a: "lowercase", B: "uppercase" },
      "e\u0301": "decomposed",
      é: "composed",
    };

    expect(canonicalCatalogCommandJson(first)).toBe(
      canonicalCatalogCommandJson(reordered),
    );
    expect(canonicalCatalogCommandJson(first)).not.toBe(canonicalJson(first));
  });
});
