import { describe, expect, it } from "vitest";
import { isAutomaticQuoteEnabled } from "./automatic-quote-launch";

describe("automatic quote launch gate", () => {
  it("requires an explicit runtime true and approved manifest inputs", () => {
    const approved = {
      hasApprovedCheckoutDocuments: true,
      hasApprovedCommercialContent: true,
    };

    expect(isAutomaticQuoteEnabled({ ...approved, runtimeEnabled: true })).toBe(
      true,
    );
    expect(
      isAutomaticQuoteEnabled({ ...approved, runtimeEnabled: "true" }),
    ).toBe(true);
    expect(
      isAutomaticQuoteEnabled({ ...approved, runtimeEnabled: " true" }),
    ).toBe(false);
    expect(
      isAutomaticQuoteEnabled({
        ...approved,
        runtimeEnabled: false,
      }),
    ).toBe(false);
    expect(
      isAutomaticQuoteEnabled({
        runtimeEnabled: true,
        hasApprovedCheckoutDocuments: false,
        hasApprovedCommercialContent: true,
      }),
    ).toBe(false);
  });
});
