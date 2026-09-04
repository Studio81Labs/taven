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
        taxPolicy: { regime: "NON_VAT_PAYER", vatRateBasisPoints: 0 },
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
      maximumPlateCount: 2n,
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
      shipmentPlanIdsByOrdinal: new Map([[1, "plan-1"]]),
    },
  };
}

function splitInput(): PrepareOrderQuoteInput {
  const quoteInput = input();
  const plannerInput = quoteInput.destinationShipment!.plannerInput;
  return {
    ...quoteInput,
    pricing: {
      ...quoteInput.pricing,
      items: [
        {
          ...quoteInput.pricing.items[0]!,
          quantity: 2n,
          packingUnits: [
            { id: "item-1:SINGLE:1", basis: 1n },
            { id: "item-1:SINGLE:2", basis: 1n },
          ],
        },
      ],
    },
    destinationShipment: {
      ...quoteInput.destinationShipment!,
      plannerInput: {
        ...plannerInput,
        units: [
          {
            packingUnitKey: "item-1:SINGLE:1",
            box: {
              xMicrometers: 100n,
              yMicrometers: 100n,
              zMicrometers: 100n,
            },
            weightMilligrams: 10n,
          },
          {
            packingUnitKey: "item-1:SINGLE:2",
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
            id: "small",
            maxXMicrometers: 20n,
            maxYMicrometers: 20n,
            maxZMicrometers: 20n,
            maxDimensionSumMicrometers: 30n,
            maxWeightMilligrams: 1_000n,
            maxParcelVolumeCubicMicrometers: 10_000n,
          },
          {
            id: "large",
            maxXMicrometers: 100n,
            maxYMicrometers: 100n,
            maxZMicrometers: 100n,
            maxDimensionSumMicrometers: 300n,
            maxWeightMilligrams: 1_000n,
            maxParcelVolumeCubicMicrometers: 1_818_182n,
          },
        ],
        supportedCategoryIds: new Set(["small", "large"]),
      },
      categoryPricing: [
        {
          categoryId: "large",
          carrierCost: Money.of(20n, "CZK"),
          customerShippingRate: Money.of(20n, "CZK"),
          packagingCost: Money.zero("CZK"),
        },
      ],
      shipmentPlanIdsByOrdinal: new Map([
        [1, "plan-1"],
        [2, "plan-2"],
      ]),
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
    const quoteInput = input();
    const prepared = prepareOrderQuote(quoteInput);
    expect(prepared.kind).toBe("binding_quote");
    if (prepared.kind !== "binding_quote") return;
    expect(prepared.shipmentPlan.parcels).toHaveLength(1);
    expect(prepared.price.shipmentPlanIds).toEqual(["plan-1"]);
    expect(prepared.price.contractTotal.minorUnits).toBe(120n);
  });

  it("does not bind shipment rows while the quote remains provisional", () => {
    const quoteInput = input();
    const prepared = prepareOrderQuote({
      ...quoteInput,
      automaticQuoteFacts: {
        ...quoteInput.automaticQuoteFacts,
        riskAcknowledgementsComplete: false,
      },
    });

    expect(prepared.kind).toBe("provisional");
    expect(prepared.reasons).toEqual(["RISK_ACKNOWLEDGEMENT_REQUIRED"]);
  });

  it("does not bind shipment rows for a custom request", () => {
    const quoteInput = input();
    const prepared = prepareOrderQuote({
      ...quoteInput,
      automaticQuoteFacts: {
        ...quoteInput.automaticQuoteFacts,
        supportedFormat: false,
      },
      destinationShipment: {
        ...quoteInput.destinationShipment!,
        categoryPricing: [],
      },
    });

    expect(prepared.kind).toBe("custom_request");
    expect(prepared.reasons).toEqual(["UNSUPPORTED_FORMAT"]);
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

  it("validates a later parcel before binding the first parcel", () => {
    const quoteInput = splitInput();

    expect(() =>
      prepareOrderQuote({
        ...quoteInput,
      }),
    ).toThrow("missing pricing for shipment category small");
  });

  it("validates shipment currencies before binding any parcel", () => {
    const quoteInput = splitInput();
    const categoryPricing = [
      ...quoteInput.destinationShipment!.categoryPricing,
      {
        categoryId: "small",
        carrierCost: Money.of(20n, "EUR"),
        customerShippingRate: Money.of(20n, "EUR"),
        packagingCost: Money.zero("EUR"),
      },
    ];

    expect(() =>
      prepareOrderQuote({
        ...quoteInput,
        destinationShipment: {
          ...quoteInput.destinationShipment!,
          categoryPricing,
        },
      }),
    ).toThrow("carrier cost must use the PriceList currency");
  });

  it("validates duplicate category pricing IDs before binding any parcel", () => {
    const quoteInput = splitInput();
    const large = quoteInput.destinationShipment!.categoryPricing[0]!;

    expect(() =>
      prepareOrderQuote({
        ...quoteInput,
        destinationShipment: {
          ...quoteInput.destinationShipment!,
          categoryPricing: [large, large],
        },
      }),
    ).toThrow("shipment category pricing IDs must be non-blank and unique");
  });

  it("validates the payment schedule before binding any parcel", () => {
    const quoteInput = splitInput();

    expect(() =>
      prepareOrderQuote({
        ...quoteInput,
        pricing: {
          ...quoteInput.pricing,
          paymentSchedule: [
            {
              ...quoteInput.pricing.paymentSchedule[0]!,
              id: "full-a",
            },
            {
              ...quoteInput.pricing.paymentSchedule[0]!,
              id: "full-b",
              sequence: 1,
              role: "BALANCE",
            },
          ],
        },
        destinationShipment: {
          ...quoteInput.destinationShipment!,
          categoryPricing: [
            ...quoteInput.destinationShipment!.categoryPricing,
            {
              categoryId: "small",
              carrierCost: Money.of(20n, "CZK"),
              customerShippingRate: Money.of(20n, "CZK"),
              packagingCost: Money.zero("CZK"),
            },
          ],
        },
      }),
    ).toThrow(
      "payment schedule must be FULL:0 or DEPOSIT:0 plus BALANCE:1 with shares totaling 10000 basis points",
    );
  });

  it("rejects blank, missing, and duplicate preallocated plan IDs", () => {
    const quoteInput = input();
    expect(() =>
      prepareOrderQuote({
        ...quoteInput,
        destinationShipment: {
          ...quoteInput.destinationShipment!,
          shipmentPlanIdsByOrdinal: new Map([[1, ""]]),
        },
      }),
    ).toThrow("ShipmentPlan ID must not be blank");
    expect(() =>
      prepareOrderQuote({
        ...quoteInput,
        destinationShipment: {
          ...quoteInput.destinationShipment!,
          shipmentPlanIdsByOrdinal: new Map<number, string>(),
        },
      }),
    ).toThrow("ShipmentPlan IDs must match planned parcel ordinals exactly");

    const splitQuoteInput = splitInput();
    expect(() =>
      prepareOrderQuote({
        ...splitQuoteInput,
        destinationShipment: {
          ...splitQuoteInput.destinationShipment!,
          categoryPricing: [
            ...splitQuoteInput.destinationShipment!.categoryPricing,
            {
              categoryId: "small",
              carrierCost: Money.of(20n, "CZK"),
              customerShippingRate: Money.of(20n, "CZK"),
              packagingCost: Money.zero("CZK"),
            },
          ],
          shipmentPlanIdsByOrdinal: new Map([
            [1, "same"],
            [2, "same"],
          ]),
        },
      }),
    ).toThrow("ShipmentPlan IDs must be unique");
  });
});
