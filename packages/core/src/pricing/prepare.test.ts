import { describe, expect, it } from "vitest";
import { Money } from "../primitives/money.js";
import { prepareOrderQuote, type PrepareOrderQuoteInput } from "./prepare.js";

const zero = { numerator: 0n, denominator: 1n } as const;

function input(): PrepareOrderQuoteInput {
  const packingUnitKey = "item-1:SINGLE:1";
  return {
    pricing: {
      priceList: {
        revision: "prices-v1",
        termsRevision: "terms-v1",
        currency: "CZK",
        machineRateMinorPerSecond: zero,
        laborRateMinorPerSecond: zero,
        amortizationRateMinorPerSecond: zero,
        reprintRate: zero,
        marginRate: zero,
        handlingOrderFixedSeconds: 0n,
        handlingPlateSeconds: 0n,
        handlingPackSeconds: 0n,
        shippingTripSeconds: 0n,
        shippingTripPricingDivisor: 1n,
        minimumPrintPrice: Money.of(100n, "CZK"),
        smallOrderWeightThresholdMilligrams: 0n,
        smallOrderSurcharge: Money.zero("CZK"),
        freeShippingPrintThreshold: Money.of(1_000n, "CZK"),
        expressMultiplier: { numerator: 2n, denominator: 1n },
      },
      profileRevisionIds: ["profile-v1"],
      items: [
        {
          itemId: "item-1",
          quantity: 1n,
          materialRateMinorPerMilligram: zero,
          base: {
            materialWeightMilligrams: 10n,
            machineSeconds: 10n,
            plateCount: 1n,
            pieceHandlingSeconds: 0n,
          },
          quantityEffect: {
            materialWeightMilligrams: 0n,
            machineSeconds: 0n,
            plateCount: 0n,
            pieceHandlingSeconds: 0n,
          },
          postprocessingSeconds: 0n,
          packingUnits: [{ id: packingUnitKey, basis: 1n }],
        },
      ],
      expressRequested: false,
      paymentSchedule: [
        {
          id: "full",
          sequence: 0,
          role: "FULL",
          shareBasisPoints: 10_000,
          feeRateBasisPoints: 0,
          feeFixed: Money.zero("CZK"),
        },
      ],
    },
    automaticQuoteFacts: {
      referenceSlicingComplete: true,
      supportedFormat: true,
      hasBlockingPreflightFinding: false,
      riskAcknowledgementsComplete: true,
      withinAutomaticQuantityLimit: true,
      withinAutomaticAmountLimit: true,
      withinBuildLimits: true,
    },
    expressEligibility: {
      phaseKind: "SINGLE",
      requiredPlateCount: 1n,
      materialAndColorAvailable: true,
      hasNonstandardPostprocessing: false,
      requiredProductionSeconds: 10n,
      availableProductionWindowSeconds: 100n,
      packagingBufferSeconds: 10n,
    },
    destinationShipment: {
      deliveryDestinationId: "destination-1",
      deliveryCapabilitySnapshotId: "capability-1",
      plannerInput: {
        units: [
          {
            packingUnitKey,
            box: {
              xMicrometers: 10n,
              yMicrometers: 10n,
              zMicrometers: 10n,
            },
            weightMilligrams: 10n,
          },
        ],
        categories: [
          {
            id: "zbox",
            maxXMicrometers: 100n,
            maxYMicrometers: 100n,
            maxZMicrometers: 100n,
            maxDimensionSumMicrometers: 300n,
            maxWeightMilligrams: 1_000n,
            maxParcelVolumeCubicMicrometers: 10_000n,
          },
        ],
        supportedCategoryIds: new Set(["zbox"]),
        fillCoefficientNumerator: 55n,
        fillCoefficientDenominator: 100n,
        packagingWeightMilligrams: 10n,
      },
      categoryPricing: [
        {
          categoryId: "zbox",
          carrierCost: Money.of(20n, "CZK"),
          customerShippingRate: Money.of(20n, "CZK"),
          packagingCost: Money.zero("CZK"),
        },
      ],
      shipmentPlanIdForOrdinal: (ordinal) => `plan-${ordinal}`,
    },
  };
}

describe("prepareOrderQuote", () => {
  it("keeps sliced pricing provisional without a selected destination", () => {
    const prepared = prepareOrderQuote({
      ...input(),
      destinationShipment: undefined,
    });
    expect(prepared.kind).toBe("provisional");
    expect(prepared.reasons).toEqual([
      "DELIVERY_DESTINATION_REQUIRED",
      "DELIVERY_CAPABILITY_SNAPSHOT_REQUIRED",
      "SHIPMENT_PLAN_REQUIRED",
    ]);
    expect(prepared.price.kind).toBe("provisional");
  });

  it("plans and prices a binding endpoint-compatible quote", () => {
    const prepared = prepareOrderQuote(input());
    expect(prepared.kind).toBe("binding_quote");
    if (prepared.kind !== "binding_quote") return;
    expect(prepared.shipmentPlan.parcels).toHaveLength(1);
    expect(prepared.price.shipmentPlanIds).toEqual(["plan-1"]);
    expect(prepared.price.contractTotal.minorUnits).toBe(120n);
  });

  it("routes an endpoint no-fit result to a custom request", () => {
    const prepared = prepareOrderQuote({
      ...input(),
      destinationShipment: {
        ...input().destinationShipment!,
        plannerInput: {
          ...input().destinationShipment!.plannerInput,
          supportedCategoryIds: new Set(),
        },
      },
    });
    expect(prepared.kind).toBe("custom_request");
    if (prepared.kind !== "custom_request") return;
    expect(prepared.reasons).toContain("SHIPMENT_INELIGIBLE");
    expect(prepared.shipmentFailure?.status).toBe("no_fit");
    expect(prepared.price.kind).toBe("provisional");
  });
});
