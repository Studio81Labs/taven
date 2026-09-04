import { describe, expect, it } from "vitest";
import {
  CLIENT_ROUGH_ESTIMATE_REVISION,
  clientRoughPriceEstimate,
} from "./rough-price-estimate";

describe("clientRoughPriceEstimate", () => {
  it("returns the versioned one-piece range around the automatic minimum", () => {
    expect(clientRoughPriceEstimate(10_000)).toEqual({
      currency: "CZK",
      lowerMinor: 24_000,
      revision: CLIENT_ROUGH_ESTIMATE_REVISION,
      upperMinor: 36_000,
    });
  });

  it("lets sufficiently large geometry exceed the automatic minimum", () => {
    const estimate = clientRoughPriceEstimate(1_000_000);

    expect(estimate?.lowerMinor).toBeGreaterThan(24_000);
    expect(estimate?.upperMinor).toBeGreaterThan(estimate?.lowerMinor ?? 0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unusable volume %s",
    (volume) => {
      expect(clientRoughPriceEstimate(volume)).toBeNull();
    },
  );
});
