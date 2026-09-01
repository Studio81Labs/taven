import { describe, expect, it } from "vitest";
import { MAX_QUOTE_PHOTO_BYTES, validateQuotePhoto } from "./quote-photo";

describe("quote reference photo validation", () => {
  it.each([
    ["front.jpg", "image/jpeg"],
    ["side.png", "image/png"],
    ["detail.webp", "image/webp"],
    ["unknown.jpeg", ""],
  ] as const)("accepts %s as %s", (name, type) => {
    expect(validateQuotePhoto({ name, size: 1_024, type })).toMatchObject({
      originalFilename: name,
      sizeBytes: 1_024,
    });
  });

  it("rejects misleading, unsafe, empty, and oversized files", () => {
    expect(() =>
      validateQuotePhoto({ name: "photo.jpg", size: 10, type: "image/png" }),
    ).toThrow("neodpovídá");
    expect(() =>
      validateQuotePhoto({
        name: "../photo.jpg",
        size: 10,
        type: "image/jpeg",
      }),
    ).toThrow("nepovolené");
    expect(() =>
      validateQuotePhoto({ name: "photo.jpg", size: 0, type: "image/jpeg" }),
    ).toThrow("prázdná");
    expect(() =>
      validateQuotePhoto({
        name: "photo.jpg",
        size: MAX_QUOTE_PHOTO_BYTES + 1,
        type: "image/jpeg",
      }),
    ).toThrow("20 MiB");
  });
});
