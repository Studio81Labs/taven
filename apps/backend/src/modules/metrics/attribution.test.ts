import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { normalizeAttribution } from "./attribution";

describe("normalizeAttribution", () => {
  it("keeps only normalized allowlisted campaign labels", () => {
    expect(
      normalizeAttribution({
        channel: "paid",
        source: " Google-Ads ",
        medium: "CPC",
        campaign: "Summer-2026",
      }),
    ).toEqual({
      channel: "paid",
      source: "google-ads",
      medium: "cpc",
      campaign: "summer-2026",
    });
  });

  it("accepts the documented pre-normalization label bounds", () => {
    const padded = `${" ".repeat(123)}Google-Ads${" ".repeat(123)}`;
    expect(padded).toHaveLength(256);
    expect(normalizeAttribution({ channel: "paid", source: padded })).toEqual({
      channel: "paid",
      source: "google-ads",
    });
    expect(() =>
      normalizeAttribution({ channel: "paid", source: `${padded} ` }),
    ).toThrow(BadRequestException);
  });

  it("rejects arbitrary attribution data", () => {
    expect(() =>
      normalizeAttribution({
        channel: "direct",
        referrer: "https://example.test/?email=person@example.test",
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      normalizeAttribution({ channel: "direct", source: "not a slug" }),
    ).toThrow(BadRequestException);
  });
});
