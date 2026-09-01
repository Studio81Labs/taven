import { describe, expect, it } from "vitest";
import { prepareAutomaticQuote } from "./automatic-quote-pricing";

const parameters = {
  automaticQuote: {
    machineRateMinorPerSecond: { numerator: "1", denominator: "2" },
    laborRateMinorPerSecond: { numerator: "1", denominator: "1" },
    amortizationRateMinorPerSecond: { numerator: "1", denominator: "10" },
    reprintRate: { numerator: "5", denominator: "100" },
    marginRate: { numerator: "30", denominator: "100" },
    materialRateMinorPerMilligram: {
      PLA: { numerator: "1", denominator: "20" },
      PETG: { numerator: "3", denominator: "50" },
    },
    roughMaterialDensityMilligramsPerCubicMillimeter: {
      PLA: { numerator: "124", denominator: "100" },
      PETG: { numerator: "127", denominator: "100" },
    },
    roughMaterialVolumeRatioByInfillPreset: {
      DECORATIVE: { numerator: "30", denominator: "100" },
      STANDARD: { numerator: "40", denominator: "100" },
      STRONG: { numerator: "60", denominator: "100" },
    },
    roughExtrusionMilligramsPerSecond: { numerator: "5", denominator: "1" },
    handlingOrderFixedSeconds: "180",
    handlingPlateSeconds: "120",
    handlingPieceSeconds: "30",
    handlingPackSeconds: "180",
    shippingTripSeconds: "600",
    shippingTripPricingDivisor: "4",
    minimumPrintPriceMinor: "25000",
    smallOrderWeightThresholdMilligrams: "100000",
    smallOrderSurchargeMinor: "5000",
    freeShippingPrintThresholdMinor: "100000",
    expressMultiplier: { numerator: "2", denominator: "1" },
    expressMaximumPlateCount: "2",
    expressAvailableProductionWindowSeconds: "86400",
    expressPackagingBufferSeconds: "7200",
    maximumAutomaticQuantity: "1000",
    maximumAutomaticAmountMinor: "1000000",
    packingPaddingMicrometers: "5000",
    fillCoefficient: { numerator: "55", denominator: "100" },
    packagingWeightMilligrams: "150000",
    paymentFeeRateBasisPoints: 150,
    paymentFeeFixedMinor: "300",
    paymentProviderConfig: { provider: "configured" },
    shipmentCategories: [
      {
        id: "box",
        maxXMicrometers: "600000",
        maxYMicrometers: "450000",
        maxZMicrometers: "350000",
        maxDimensionSumMicrometers: "1400000",
        maxWeightMilligrams: "15000000",
        maxParcelVolumeCubicMicrometers: "94500000000000000",
        carrierCostMinor: "8500",
        customerShippingRateMinor: "8500",
        packagingCostMinor: "1500",
      },
    ],
  },
};

function item(id: string, quantity = 1) {
  return {
    id,
    referenceProfileId: "reference-profile-v1",
    material: "PLA" as const,
    quantity,
    referencePartsPerPlate: 1,
    primary: {
      estimatedPrintSeconds: 60n,
      estimatedMaterialMilligrams: 10_000n,
    },
    tail: null,
    boundsXMicrometers: 20_000n,
    boundsYMicrometers: 20_000n,
    boundsZMicrometers: 20_000n,
    fulfilmentSlots: Array.from({ length: quantity }, (_, index) => ({
      packingUnitKey: `${id}:single:${index + 1}`,
    })),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    priceList: {
      id: "price-list",
      revision: "automatic-v0-czk",
      termsRevision: "terms-v0-cz",
      currency: "CZK",
      parameters,
    },
    items: [item("item-a"), item("item-b")],
    expressRequested: false,
    materialAndColorAvailable: true,
    withinBuildLimits: true,
    riskAcknowledgementsComplete: true,
    hasBlockingPreflightFinding: false,
    ...overrides,
  };
}

describe("automatic quote pricing preparation", () => {
  it("keeps a multi-item estimate non-binding with one order minimum and surcharge", async () => {
    const result = await prepareAutomaticQuote(input());

    expect(result.prepared.kind).toBe("provisional");
    expect(result.prepared.price.kind).toBe("provisional");
    expect(
      result.prepared.price.components.filter(
        ({ kind }) => kind === "ORDER_MIN_PRINT",
      ),
    ).toHaveLength(1);
    expect(
      result.prepared.price.components.filter(
        ({ kind }) => kind === "ORDER_SMALL_SURCHARGE",
      ),
    ).toHaveLength(1);
    expect(
      result.prepared.price.components.filter(
        ({ kind }) => kind === "ITEM_PRODUCTION",
      ),
    ).toHaveLength(2);
  });

  it("rejects whole-order express when one item lacks material availability", async () => {
    const result = await prepareAutomaticQuote(
      input({ expressRequested: true, materialAndColorAvailable: false }),
    );

    expect(result.prepared.kind).toBe("custom_request");
    expect(result.prepared.reasons).toContain("EXPRESS_INELIGIBLE");
    expect(result.prepared.expressEligibility.reasons).toContain(
      "MATERIAL_OR_COLOR_UNAVAILABLE",
    );
  });

  it("uses the configured express plate limit", async () => {
    const configuredForOnePlate = structuredClone(parameters);
    configuredForOnePlate.automaticQuote.expressMaximumPlateCount = "1";

    const result = await prepareAutomaticQuote(
      input({
        expressRequested: true,
        priceList: {
          id: "price-list",
          revision: "automatic-v0-czk",
          termsRevision: "terms-v0-cz",
          currency: "CZK",
          parameters: configuredForOnePlate,
        },
      }),
    );

    expect(result.prepared.kind).toBe("custom_request");
    expect(result.prepared.expressEligibility.reasons).toContain(
      "TOO_MANY_PLATES",
    );
  });

  it("returns a shipment handoff instead of binding to an incompatible endpoint", async () => {
    const result = await prepareAutomaticQuote(
      input({
        deliveryDestination: {
          id: "destination",
          capabilitySnapshot: { supportedCategoryIds: ["unsupported"] },
        },
        shipmentPlanIdForOrdinal: (ordinal: number) => `plan-${ordinal}`,
      }),
    );

    expect(result.prepared.kind).toBe("custom_request");
    expect(result.prepared.reasons).toContain("SHIPMENT_INELIGIBLE");
  });

  it("produces a binding total whose item and order components reconcile", async () => {
    const result = await prepareAutomaticQuote(
      input({
        deliveryDestination: {
          id: "destination",
          capabilitySnapshot: { supportedCategoryIds: ["box"] },
        },
        shipmentPlanIdForOrdinal: (ordinal: number) => `plan-${ordinal}`,
      }),
    );

    expect(result.prepared.kind).toBe("binding_quote");
    if (result.prepared.kind !== "binding_quote") return;
    const componentTotal = result.prepared.price.components.reduce(
      (sum, component) => sum + component.amount.minorUnits,
      0n,
    );
    expect(componentTotal).toBe(result.prepared.price.contractTotal.minorUnits);
    expect(result.prepared.price.captures).toHaveLength(1);
    expect(result.prepared.price.captures[0]?.role).toBe("FULL");
    expect(result.prepared.shipmentPlan.parcels[0]?.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packingUnitKey: "item-a:single:1" }),
        expect.objectContaining({ packingUnitKey: "item-b:single:1" }),
      ]),
    );
  });

  it("applies the automatic-value ceiling to the fee-inclusive checkout total", async () => {
    const destination = {
      deliveryDestination: {
        id: "destination",
        capabilitySnapshot: { supportedCategoryIds: ["box"] },
      },
      shipmentPlanIdForOrdinal: (ordinal: number) => `plan-${ordinal}`,
    };
    const baselineInput = input(destination);
    const baseline = await prepareAutomaticQuote(baselineInput);
    expect(baseline.prepared.kind).toBe("binding_quote");
    if (baseline.prepared.kind !== "binding_quote") return;
    const contractTotal = baseline.prepared.price.contractTotal.minorUnits;
    expect(contractTotal).toBeGreaterThan(
      baseline.prepared.price.breakdown.subtotal.minorUnits,
    );

    const withCap = (maximumAutomaticAmountMinor: bigint) => ({
      ...baselineInput,
      priceList: {
        ...baselineInput.priceList,
        parameters: {
          automaticQuote: {
            ...parameters.automaticQuote,
            maximumAutomaticAmountMinor: maximumAutomaticAmountMinor.toString(),
          },
        },
      },
    });
    const overLimit = await prepareAutomaticQuote(withCap(contractTotal - 1n));
    expect(overLimit.prepared.kind).toBe("custom_request");
    expect(overLimit.prepared.reasons).toContain(
      "AUTOMATIC_AMOUNT_LIMIT_EXCEEDED",
    );

    const atLimit = await prepareAutomaticQuote(withCap(contractTotal));
    expect(atLimit.prepared.kind).toBe("binding_quote");
  });
});
