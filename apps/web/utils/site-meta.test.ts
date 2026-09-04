import { describe, expect, it } from "vitest";
import { canonicalTitle, canonicalUrl, normalizeSiteOrigin } from "./site-meta";

describe("canonicalTitle", () => {
  it("uses the product name as the canonical suffix", () => {
    expect(canonicalTitle("Quote")).toBe("Quote · Taven");
  });

  it("supports a replaceable working name", () => {
    expect(canonicalTitle("Ceník", "Nový název")).toBe("Ceník · Nový název");
  });
});

describe("normalizeSiteOrigin", () => {
  it("keeps only the origin from an HTTP URL", () => {
    expect(normalizeSiteOrigin("https://example.test/path")).toBe(
      "https://example.test",
    );
  });

  it("falls back safely for missing or unsupported URLs", () => {
    expect(normalizeSiteOrigin(undefined)).toBe("http://localhost:3000");
    expect(normalizeSiteOrigin("javascript:alert(1)")).toBe(
      "http://localhost:3000",
    );
  });
});

describe("canonicalUrl", () => {
  it("builds a canonical URL from configured origin and route", () => {
    expect(canonicalUrl("https://taven.example/ignored", "cenik")).toBe(
      "https://taven.example/cenik",
    );
  });
});
