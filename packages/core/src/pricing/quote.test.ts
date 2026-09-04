import { describe, expect, it } from "vitest";
import { Money } from "../primitives/money.js";
import {
  calculateOrderPrice,
  type OrderItemPricingInput,
  type OrderPriceCalculationInput,
  type ParcelPricingInput,
  type PriceListCalculationInput,
  type ProductionMetrics,
} from "./quote.js";

const zeroRate = { numerator: 0n, denominator: 1n } as const;

function priceList(
  overrides: Partial<PriceListCalculationInput> = {},
): PriceListCalculationInput {
  return {
    revision: "price-list-v1",
    termsRevision: "terms-v1",
    currency: "CZK",
    taxPolicy: { regime: "NON_VAT_PAYER", vatRateBasisPoints: 0 },
    machineRateMinorPerSecond: zeroRate,
    laborRateMinorPerSecond: zeroRate,
    amortizationRateMinorPerSecond: zeroRate,
    reprintRate: zeroRate,
    marginRate: zeroRate,
    handlingOrderFixedSeconds: 0n,
    handlingPlateSeconds: 0n,
    handlingPackSeconds: 0n,
    shippingTripSeconds: 0n,
    shippingTripPricingDivisor: 1n,
    minimumPrintPrice: Money.of(25_000n, "CZK"),
    smallOrderWeightThresholdMilligrams: 100_000n,
    smallOrderSurcharge: Money.of(5_000n, "CZK"),
    freeShippingPrintThreshold: Money.of(100_000n, "CZK"),
    expressMultiplier: { numerator: 2n, denominator: 1n },
    ...overrides,
  };
}

function metrics(
  materialWeightMilligrams: bigint,
  overrides: Partial<ProductionMetrics> = {},
): ProductionMetrics {
  return {
    materialWeightMilligrams,
    machineSeconds: 0n,
    plateCount: 1n,
    pieceHandlingSeconds: 0n,
    ...overrides,
  };
}

function item(
  itemId: string,
  weightMilligrams: bigint,
  overrides: Partial<OrderItemPricingInput> = {},
): OrderItemPricingInput {
  return {
    itemId,
    quantity: 1n,
    materialRateMinorPerMilligram: zeroRate,
    base: metrics(weightMilligrams),
    quantityEffect: metrics(0n, { plateCount: 0n }),
    postprocessingSeconds: 0n,
    packingUnits: [{ id: `${itemId}:SINGLE:1`, basis: 1n }],
    ...overrides,
  };
}

function parcel(
  packingUnitKeys: readonly string[],
  overrides: Partial<ParcelPricingInput> = {},
): ParcelPricingInput {
  return {
    shipmentPlanId: "plan-1",
    categoryId: "zbox",
    packingUnitKeys,
    carrierCost: Money.of(8_500n, "CZK"),
    customerShippingRate: Money.of(8_500n, "CZK"),
    packagingCost: Money.zero("CZK"),
    ...overrides,
  };
}

function fullCapture(rateBasisPoints = 150, fixedMinor = 300) {
  return [
    {
      id: "full",
      sequence: 0,
      role: "FULL" as const,
      shareBasisPoints: 10_000,
      feeRateBasisPoints: rateBasisPoints,
      feeFixed: Money.of(fixedMinor, "CZK"),
    },
  ];
}

function bindingInput(
  anItem: OrderItemPricingInput,
  overrides: Partial<OrderPriceCalculationInput> = {},
): OrderPriceCalculationInput {
  return {
    priceList: priceList(),
    profileRevisionIds: ["ref-pla-standard-v1"],
    items: [anItem],
    shipment: {
      deliveryDestinationId: "destination-1",
      deliveryCapabilitySnapshotId: "capability-1",
      parcels: [parcel(anItem.packingUnits.map(({ id }) => id))],
    },
    expressRequested: false,
    expressEligible: true,
    paymentSchedule: fullCapture(),
    ...overrides,
  };
}

function minor(value: Money): bigint {
  return value.minorUnits;
}

describe("calculateOrderPrice", () => {
  it("reproduces the documented one-capture checkout floors", () => {
    const regular = calculateOrderPrice(
      bindingInput(item("regular", 150_000n)),
    );
    expect(regular.kind).toBe("binding");
    if (regular.kind !== "binding") return;
    expect(minor(regular.breakdown.basePrintPrice)).toBe(25_000n);
    expect(minor(regular.breakdown.customerShipping)).toBe(8_500n);
    expect(minor(regular.breakdown.smallOrderSurcharge)).toBe(0n);
    expect(minor(regular.breakdown.subtotal)).toBe(33_500n);
    expect(minor(regular.contractTotal)).toBe(34_315n);
    expect(regular.tax).toEqual({
      regime: "NON_VAT_PAYER",
      vatRateBasisPoints: 0,
      net: Money.of(34_315n, "CZK"),
      vat: Money.zero("CZK"),
      gross: Money.of(34_315n, "CZK"),
    });

    const small = calculateOrderPrice(bindingInput(item("small", 99_999n)));
    expect(small.kind).toBe("binding");
    if (small.kind !== "binding") return;
    expect(minor(small.breakdown.smallOrderSurcharge)).toBe(5_000n);
    expect(minor(small.breakdown.subtotal)).toBe(38_500n);
    expect(minor(small.contractTotal)).toBe(39_391n);
  });

  it("grosses up both fixed fees for deposit and balance", () => {
    const input = bindingInput(item("split-payments", 150_000n), {
      paymentSchedule: [
        {
          id: "deposit",
          sequence: 0,
          role: "DEPOSIT",
          shareBasisPoints: 5_000,
          feeRateBasisPoints: 150,
          feeFixed: Money.of(300n, "CZK"),
        },
        {
          id: "balance",
          sequence: 1,
          role: "BALANCE",
          shareBasisPoints: 5_000,
          feeRateBasisPoints: 150,
          feeFixed: Money.of(300n, "CZK"),
        },
      ],
    });
    const result = calculateOrderPrice(input);
    expect(result.kind).toBe("binding");
    if (result.kind !== "binding") return;
    expect(result.captures.map(({ gross }) => minor(gross))).toEqual([
      17_310n,
      17_310n,
    ]);
    expect(minor(result.paymentFee)).toBe(1_120n);
    expect(minor(result.contractTotal)).toBe(34_620n);
  });

  it("applies VAT to the complete customer consideration without reducing the pricing subtotal", () => {
    const result = calculateOrderPrice(
      bindingInput(item("vat", 150_000n), {
        priceList: priceList({
          taxPolicy: { regime: "VAT_PAYER", vatRateBasisPoints: 2_100 },
        }),
      }),
    );
    expect(result.kind).toBe("binding");
    if (result.kind !== "binding") return;
    expect(result.tax.regime).toBe("VAT_PAYER");
    expect(result.tax.vatRateBasisPoints).toBe(2_100);
    expect(result.tax.net.add(result.tax.vat)).toEqual(result.contractTotal);
    expect(result.tax.net.minorUnits - result.paymentFee.minorUnits).toBe(
      result.breakdown.subtotal.minorUnits,
    );
    expect(
      result.components.find(({ kind }) => kind === "VAT")?.amount,
    ).toEqual(result.tax.vat);
    expect(
      result.components.reduce(
        (sum, component) => sum + component.amount.minorUnits,
        0n,
      ),
    ).toBe(result.contractTotal.minorUnits);
  });

  it("applies express once to the whole-order base print price", () => {
    const result = calculateOrderPrice(
      bindingInput(item("express", 150_000n), {
        expressRequested: true,
        expressEligible: true,
        paymentSchedule: fullCapture(0, 0),
      }),
    );
    expect(result.kind).toBe("binding");
    if (result.kind !== "binding") return;
    expect(minor(result.breakdown.basePrintPrice)).toBe(25_000n);
    expect(minor(result.breakdown.expressSurcharge)).toBe(25_000n);
    expect(minor(result.contractTotal)).toBe(58_500n);
    expect(
      result.components.filter(({ kind }) => kind === "EXPRESS"),
    ).toHaveLength(1);
  });

  it("adds free-shipping subsidy to the cost base before margin", () => {
    const costly = item("free-shipping", 100_000n, {
      materialRateMinorPerMilligram: { numerator: 1n, denominator: 1n },
    });
    const result = calculateOrderPrice(
      bindingInput(costly, {
        priceList: priceList({
          minimumPrintPrice: Money.zero("CZK"),
          smallOrderWeightThresholdMilligrams: 0n,
        }),
        paymentSchedule: fullCapture(0, 0),
      }),
    );
    expect(result.kind).toBe("binding");
    if (result.kind !== "binding") return;
    expect(minor(result.breakdown.printPriceBeforeSubsidy)).toBe(100_000n);
    expect(minor(result.breakdown.customerShipping)).toBe(0n);
    expect(minor(result.breakdown.shippingSubsidy)).toBe(8_500n);
    expect(minor(result.breakdown.basePrintPrice)).toBe(108_500n);
    expect(minor(result.contractTotal)).toBe(108_500n);
    expect(
      result.components.find(({ kind }) => kind === "SHIPMENT")?.amount
        .minorUnits,
    ).toBe(8_500n);
  });

  it("charges and allocates every parcel in a split ShipmentPlan", () => {
    const configured = item("split", 150_000n, {
      quantity: 2n,
      packingUnits: [
        { id: "split:SINGLE:1", basis: 1n },
        { id: "split:SINGLE:2", basis: 1n },
      ],
    });
    const firstParcel = parcel(["split:SINGLE:1"], {
      shipmentPlanId: "plan-1",
    });
    const secondParcel = parcel(["split:SINGLE:2"], {
      shipmentPlanId: "plan-2",
    });
    const result = calculateOrderPrice(
      bindingInput(configured, {
        shipment: {
          deliveryDestinationId: "destination-1",
          deliveryCapabilitySnapshotId: "capability-1",
          parcels: [firstParcel, secondParcel],
        },
        paymentSchedule: fullCapture(0, 0),
      }),
    );
    expect(result.kind).toBe("binding");
    if (result.kind !== "binding") return;
    expect(minor(result.breakdown.customerShipping)).toBe(17_000n);
    expect(
      result.components
        .filter(({ kind }) => kind === "SHIPMENT")
        .map(({ amount }) => minor(amount)),
    ).toEqual([8_500n, 8_500n]);
    expect(minor(result.contractTotal)).toBe(42_000n);
  });

  it("applies reprint reserve and post-processing exactly once", () => {
    const configured = item("reprint", 10_000n, {
      quantity: 10n,
      materialRateMinorPerMilligram: { numerator: 1n, denominator: 1n },
      postprocessingSeconds: 100n,
      packingUnits: Array.from({ length: 10 }, (_, index) => ({
        id: `reprint:SINGLE:${index + 1}`,
        basis: 1n,
      })),
    });
    const result = calculateOrderPrice(
      bindingInput(configured, {
        priceList: priceList({
          laborRateMinorPerSecond: { numerator: 1n, denominator: 1n },
          reprintRate: { numerator: 5n, denominator: 100n },
          minimumPrintPrice: Money.zero("CZK"),
          smallOrderWeightThresholdMilligrams: 0n,
        }),
        shipment: {
          deliveryDestinationId: "destination-1",
          deliveryCapabilitySnapshotId: "capability-1",
          parcels: [
            parcel(
              configured.packingUnits.map(({ id }) => id),
              {
                carrierCost: Money.zero("CZK"),
                customerShippingRate: Money.zero("CZK"),
              },
            ),
          ],
        },
        paymentSchedule: fullCapture(0, 0),
      }),
    );
    expect(result.kind).toBe("binding");
    if (result.kind !== "binding") return;
    expect(minor(result.breakdown.itemHandling)).toBe(100n);
    expect(minor(result.breakdown.reprintReserve)).toBe(505n);
    expect(minor(result.breakdown.productionCost)).toBe(10_605n);
  });

  it("prices quantity effects per item and applies order policies once", () => {
    const first = item("first", 0n, {
      quantity: 2n,
      materialRateMinorPerMilligram: { numerator: 1n, denominator: 1n },
      base: metrics(1_000n),
      quantityEffect: metrics(4_000n),
      packingUnits: [
        { id: "first:SINGLE:1", basis: 1n },
        { id: "first:SINGLE:2", basis: 1n },
      ],
    });
    const second = item("second", 0n, {
      quantity: 2n,
      materialRateMinorPerMilligram: { numerator: 1n, denominator: 1n },
      base: metrics(1_000n),
      quantityEffect: metrics(1_000n),
      packingUnits: [
        { id: "second:SINGLE:1", basis: 1n },
        { id: "second:SINGLE:2", basis: 1n },
      ],
    });
    const allKeys = [...first.packingUnits, ...second.packingUnits].map(
      ({ id }) => id,
    );
    const result = calculateOrderPrice({
      ...bindingInput(first),
      items: [first, second],
      priceList: priceList({
        minimumPrintPrice: Money.of(25_000n, "CZK"),
        smallOrderWeightThresholdMilligrams: 100_000n,
      }),
      shipment: {
        deliveryDestinationId: "destination-1",
        deliveryCapabilitySnapshotId: "capability-1",
        parcels: [
          parcel(allKeys, {
            carrierCost: Money.zero("CZK"),
            customerShippingRate: Money.zero("CZK"),
          }),
        ],
      },
      paymentSchedule: fullCapture(0, 0),
    });
    expect(result.kind).toBe("binding");
    if (result.kind !== "binding") return;
    const quantityComponents = result.components.filter(
      ({ kind }) => kind === "ITEM_QUANTITY",
    );
    expect(quantityComponents.map(({ amount }) => minor(amount))).toEqual([
      4_000n,
      1_000n,
    ]);
    expect(
      result.components.filter(({ kind }) => kind === "ORDER_MIN_PRINT"),
    ).toHaveLength(1);
    expect(
      result.components.filter(({ kind }) => kind === "ORDER_SMALL_SURCHARGE"),
    ).toHaveLength(1);
    expect(minor(result.breakdown.minimumPrintTopUp)).toBe(18_000n);
    expect(minor(result.breakdown.smallOrderSurcharge)).toBe(5_000n);
    expect(minor(result.contractTotal)).toBe(30_000n);
  });

  it("keeps sliced pricing provisional until a destination-bound plan exists", () => {
    const configured = item("provisional", 50_000n);
    const result = calculateOrderPrice({
      ...bindingInput(configured),
      shipment: undefined,
    });
    expect(result.kind).toBe("provisional");
    expect(result).not.toHaveProperty("contractTotal");
    expect(result).not.toHaveProperty("captures");
    expect(result.customerTotal).toEqual(result.breakdown.subtotal);
    expect(result.components.some(({ kind }) => kind === "SHIPMENT")).toBe(
      false,
    );
  });

  it("cannot price express before the whole-order gate passes", () => {
    expect(() =>
      calculateOrderPrice(
        bindingInput(item("express-ineligible", 50_000n), {
          expressRequested: true,
          expressEligible: false,
        }),
      ),
    ).toThrow(/whole-order eligibility/);
  });

  it("reconciles every component and pre-quote unit allocation exactly", () => {
    const configured = item("reconcile", 50_000n, {
      quantity: 2n,
      packingUnits: [
        { id: "reconcile:SINGLE:1", basis: 2n },
        { id: "reconcile:SINGLE:2", basis: 1n },
      ],
    });
    const result = calculateOrderPrice(bindingInput(configured));
    expect(result.kind).toBe("binding");
    if (result.kind !== "binding") return;
    const componentTotal = result.components.reduce(
      (sum, { amount }) => sum + minor(amount),
      0n,
    );
    expect(componentTotal).toBe(minor(result.contractTotal));
    for (const component of result.components) {
      expect(
        component.allocations.reduce(
          (sum, { amount }) => sum + minor(amount),
          0n,
        ),
      ).toBe(minor(component.amount));
    }
  });

  it("rejects a ShipmentPlan that does not map packing keys bijectively", () => {
    const configured = item("bijection", 50_000n, {
      quantity: 2n,
      packingUnits: [
        { id: "bijection:SINGLE:1", basis: 1n },
        { id: "bijection:SINGLE:2", basis: 1n },
      ],
    });
    expect(() =>
      calculateOrderPrice(
        bindingInput(configured, {
          shipment: {
            deliveryDestinationId: "destination-1",
            deliveryCapabilitySnapshotId: "capability-1",
            parcels: [parcel(["bijection:SINGLE:1"])],
          },
        }),
      ),
    ).toThrow(/exactly once/);
  });
});
