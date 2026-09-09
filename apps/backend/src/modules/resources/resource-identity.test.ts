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

  it("uses the normative initial UTF-16 bytes and revision digest", () => {
    const payload = { a: 1, B: 2 };

    expect(canonicalJson(payload)).toBe('{"B":2,"a":1}');
    expect(resourceRevisionDigest("REFERENCE_PROFILE", payload)).toBe(
      "89b2023077b58e9a4d84549da43a8e1948ce3fc837b8889a0ae3fd5b0ae1c043",
    );
  });

  it("recursively uses UTF-16 order for representative resource settings", () => {
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
    const reordered = {
      "\uE000": "bmp-private",
      "😀": "astral",
      é: "composed",
      "e\u0301": "decomposed",
      nested: { z: [3, { a: "first", B: "second" }], a: true },
      negative: -0,
      escaped: 'line\nbreak\tquote\\slash"',
      decimal: 1.25,
      a: "lowercase",
      B: "uppercase",
      2: "two",
      10: "ten",
    };
    const expected = String.raw`{"10":"ten","2":"two","B":"uppercase","a":"lowercase","decimal":1.25,"escaped":"line\nbreak\tquote\\slash\"","é":"decomposed","negative":0,"nested":{"a":true,"z":[3,{"B":"second","a":"first"}]},"é":"composed","😀":"astral","":"bmp-private"}`;

    expect(canonicalJson(payload)).toBe(expected);
    expect(canonicalJson(reordered)).toBe(expected);
    expect(resourceRevisionDigest("REFERENCE_PROFILE", payload)).toBe(
      "9197c5a99ecb71dbd75f4148bf00895efbc88a4f76b66f222e576f1152430765",
    );
  });

  it("keeps command inputs stable across recursively reordered members", () => {
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

    expect(canonicalJson(first)).toBe(canonicalJson(reordered));
    expect(canonicalJson(first)).toBe(
      '{"é":"decomposed","nested":{"B":"uppercase","a":"lowercase"},"é":"composed"}',
    );
  });
});
