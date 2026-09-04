import { describe, expect, it } from "vitest";
import { canonicalTitle, canonicalUrl, normalizeSiteOrigin } from "./site-meta";

describe("canonicalTitle", () => {
  it("uses the product name as the canonical suffix", () => {
    expect(canonicalTitle("Quote", "Taven")).toBe("Quote · Taven");
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

  it("uses the local development origin when no value is configured", () => {
    expect(normalizeSiteOrigin(undefined)).toBe("http://localhost:3000");
  });

  it("rejects a configured malformed or unsupported origin", () => {
    expect(() => normalizeSiteOrigin("")).toThrow(
      "NUXT_PUBLIC_SITE_URL must be a valid HTTP(S) URL.",
    );
    expect(() => normalizeSiteOrigin("not a URL")).toThrow(
      "NUXT_PUBLIC_SITE_URL must be a valid HTTP(S) URL.",
    );
    expect(() => normalizeSiteOrigin("javascript:alert(1)")).toThrow(
      "NUXT_PUBLIC_SITE_URL must be a valid HTTP(S) URL.",
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
