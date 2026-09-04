import { DomainError } from "../primitives/errors.js";
import { Money } from "../primitives/money.js";
import { allocateMoney } from "./allocations.js";
import {
  moneyFromRational,
  multiplyMoneyRational,
  sumMoney,
} from "./arithmetic.js";
import { grossUpPaymentSchedule } from "./payment.js";
import {
  taxBreakdownFromNet,
  type CustomerTaxBreakdown,
  type SellerTaxPolicy,
} from "./tax.js";
import type {
  AllocationTarget,
  GrossedUpPaymentCapture,
  MonetaryAllocation,
  PaymentScheduleCapture,
  Rational,
} from "./types.js";

export interface ProductionMetrics {
  readonly materialWeightMilligrams: bigint;
  readonly machineSeconds: bigint;
  readonly plateCount: bigint;
  /** Already includes the quantity-specific, degressive piece effect. */
  readonly pieceHandlingSeconds: bigint;
}

export interface OrderItemPricingInput {
  readonly itemId: string;
  readonly quantity: bigint;
  readonly materialRateMinorPerMilligram: Rational;
  /** The first unit/occupancy contribution for this configuration. */
  readonly base: ProductionMetrics;
  /** The independently sliced contribution from the remaining quantity. */
  readonly quantityEffect: ProductionMetrics;
  /** Total for this item and phase; it is never multiplied again. */
  readonly postprocessingSeconds: bigint;
  readonly packingUnits: readonly AllocationTarget[];
}

export interface ParcelPricingInput {
  /** Identity of this parcel's persistable ShipmentPlan row. */
  readonly shipmentPlanId: string;
  readonly categoryId: string;
  readonly packingUnitKeys: readonly string[];
  readonly carrierCost: Money;
  readonly customerShippingRate: Money;
  readonly packagingCost: Money;
}

export interface BindingShipmentPricingInput {
  readonly deliveryDestinationId: string;
  readonly deliveryCapabilitySnapshotId: string;
  readonly parcels: readonly ParcelPricingInput[];
}

export interface PriceListCalculationInput {
  readonly revision: string;
  readonly termsRevision: string;
  readonly currency: string;
  readonly taxPolicy: SellerTaxPolicy;
  readonly machineRateMinorPerSecond: Rational;
  readonly laborRateMinorPerSecond: Rational;
  readonly amortizationRateMinorPerSecond: Rational;
  readonly reprintRate: Rational;
  /** Margin increment: 30/100 means cost multiplied by 1.30. */
  readonly marginRate: Rational;
  readonly handlingOrderFixedSeconds: bigint;
  readonly handlingPlateSeconds: bigint;
  readonly handlingPackSeconds: bigint;
  readonly shippingTripSeconds: bigint;
  readonly shippingTripPricingDivisor: bigint;
  readonly minimumPrintPrice: Money;
  readonly smallOrderWeightThresholdMilligrams: bigint;
  readonly smallOrderSurcharge: Money;
  readonly freeShippingPrintThreshold: Money;
  readonly expressMultiplier: Rational;
}

export interface OrderPriceCalculationInput {
  readonly priceList: PriceListCalculationInput;
  readonly profileRevisionIds: readonly string[];
  readonly items: readonly OrderItemPricingInput[];
  /** Omit until an endpoint-bound plan exists. */
  readonly shipment?: BindingShipmentPricingInput;
  readonly expressRequested: boolean;
  /** Result of the whole-order express gate for these exact inputs. */
  readonly expressEligible: boolean;
  readonly paymentSchedule: readonly PaymentScheduleCapture[];
}

export type CalculatedPriceComponentKind =
  | "ITEM_PRODUCTION"
  | "ITEM_QUANTITY"
  | "ITEM_POSTPROCESSING"
  | "ORDER_MIN_PRINT"
  | "ORDER_SMALL_SURCHARGE"
  | "SHIPMENT"
  | "EXPRESS"
  | "PAYMENT_FEE"
  | "VAT";

export interface CalculatedPriceComponent {
  readonly componentId: string;
  readonly kind: CalculatedPriceComponentKind;
  readonly targetId?: string;
  readonly amount: Money;
  /** Pre-quote keys are atomically replaced with FulfilmentSlot IDs on binding. */
  readonly allocations: readonly MonetaryAllocation[];
}

export interface OrderPriceBreakdown {
  readonly material: Money;
  readonly machine: Money;
  readonly itemHandling: Money;
  readonly sharedHandling: Money;
  readonly amortization: Money;
  readonly reprintReserve: Money;
  readonly packaging: Money;
  readonly carrierCost: Money;
  readonly productionCost: Money;
  readonly printPriceBeforeSubsidy: Money;
  readonly customerShipping: Money;
  readonly shippingSubsidy: Money;
  readonly printPriceBeforeMinimum: Money;
  readonly minimumPrintTopUp: Money;
  readonly basePrintPrice: Money;
  readonly expressSurcharge: Money;
  readonly smallOrderSurcharge: Money;
  readonly subtotal: Money;
}

export type OrderPriceCalculation =
  | {
      readonly kind: "provisional";
      readonly priceListRevision: string;
      readonly termsRevision: string;
      readonly profileRevisionIds: readonly string[];
      readonly breakdown: OrderPriceBreakdown;
      readonly customerTotal: Money;
      readonly tax: CustomerTaxBreakdown;
      readonly components: readonly CalculatedPriceComponent[];
    }
  | {
      readonly kind: "binding";
      readonly priceListRevision: string;
      readonly termsRevision: string;
      readonly profileRevisionIds: readonly string[];
      readonly shipmentPlanIds: readonly string[];
      readonly deliveryDestinationId: string;
      readonly deliveryCapabilitySnapshotId: string;
      readonly breakdown: OrderPriceBreakdown;
      readonly customerTotal: Money;
      readonly tax: CustomerTaxBreakdown;
      readonly contractTotal: Money;
      readonly paymentFee: Money;
      readonly captures: readonly GrossedUpPaymentCapture[];
      readonly components: readonly CalculatedPriceComponent[];
    };

interface ItemCostBucket {
  readonly componentId: string;
  readonly kind: "ITEM_PRODUCTION" | "ITEM_QUANTITY" | "ITEM_POSTPROCESSING";
  readonly itemId: string;
  readonly amount: Money;
  readonly allocationTargets: readonly AllocationTarget[];
}

interface DirectCosts {
  readonly buckets: readonly ItemCostBucket[];
  readonly material: Money;
  readonly machine: Money;
  readonly itemHandling: Money;
  readonly amortization: Money;
  readonly reprintReserve: Money;
}

function assertNonNegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new DomainError("NEGATIVE_RESULT", `${name} must not be negative`);
  }
}

function assertIdentity(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new DomainError("INVALID_ARGUMENT", `${name} must not be blank`);
  }
}

function assertCurrency(value: Money, currency: string, name: string): void {
  if (value.currency !== currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `${name} must use the PriceList currency`,
    );
  }
}

function addMargin(cost: Money, margin: Rational): Money {
  if (margin.numerator < 0n || margin.denominator <= 0n) {
    throw new DomainError("INVALID_ARGUMENT", "margin must not be negative");
  }
  return cost.multiply(
    margin.denominator + margin.numerator,
    margin.denominator,
    "ceil",
  );
}

function maximum(left: Money, right: Money): Money {
  return left.compare(right) >= 0 ? left : right;
}

function differenceOrZero(left: Money, right: Money): Money {
  return left.compare(right) > 0
    ? left.subtract(right)
    : Money.zero(left.currency);
}

function metricCost(
  currency: string,
  item: OrderItemPricingInput,
  metrics: ProductionMetrics,
  priceList: PriceListCalculationInput,
): {
  readonly total: Money;
  readonly material: Money;
  readonly machine: Money;
  readonly handling: Money;
  readonly amortization: Money;
} {
  assertNonNegative(metrics.materialWeightMilligrams, "material weight");
  assertNonNegative(metrics.machineSeconds, "machine seconds");
  assertNonNegative(metrics.plateCount, "plate count");
  assertNonNegative(metrics.pieceHandlingSeconds, "piece handling seconds");

  const material = moneyFromRational(
    currency,
    metrics.materialWeightMilligrams,
    item.materialRateMinorPerMilligram,
  );
  const machine = moneyFromRational(
    currency,
    metrics.machineSeconds,
    priceList.machineRateMinorPerSecond,
  );
  const handlingSeconds =
    metrics.plateCount * priceList.handlingPlateSeconds +
    metrics.pieceHandlingSeconds;
  const handling = moneyFromRational(
    currency,
    handlingSeconds,
    priceList.laborRateMinorPerSecond,
  );
  const amortization = moneyFromRational(
    currency,
    metrics.machineSeconds,
    priceList.amortizationRateMinorPerSecond,
  );
  return {
    total: sumMoney(currency, [material, machine, handling, amortization]),
    material,
    machine,
    handling,
    amortization,
  };
}

function directCosts(
  items: readonly OrderItemPricingInput[],
  priceList: PriceListCalculationInput,
): DirectCosts {
  const currency = priceList.currency;
  const buckets: ItemCostBucket[] = [];
  const material: Money[] = [];
  const machine: Money[] = [];
  const itemHandling: Money[] = [];
  const amortization: Money[] = [];

  for (const item of items) {
    const base = metricCost(currency, item, item.base, priceList);
    const quantity = metricCost(currency, item, item.quantityEffect, priceList);
    const postprocessing = moneyFromRational(
      currency,
      item.postprocessingSeconds,
      priceList.laborRateMinorPerSecond,
    );
    buckets.push(
      {
        componentId: `item:${item.itemId}:production`,
        kind: "ITEM_PRODUCTION",
        itemId: item.itemId,
        amount: base.total,
        allocationTargets: item.packingUnits,
      },
      {
        componentId: `item:${item.itemId}:quantity`,
        kind: "ITEM_QUANTITY",
        itemId: item.itemId,
        amount: quantity.total,
        allocationTargets: item.packingUnits,
      },
      {
        componentId: `item:${item.itemId}:postprocessing`,
        kind: "ITEM_POSTPROCESSING",
        itemId: item.itemId,
        amount: postprocessing,
        allocationTargets: item.packingUnits,
      },
    );
    material.push(base.material, quantity.material);
    machine.push(base.machine, quantity.machine);
    itemHandling.push(base.handling, quantity.handling, postprocessing);
    amortization.push(base.amortization, quantity.amortization);
  }

  const reprintBase = sumMoney(
    currency,
    buckets.map((bucket) => bucket.amount),
  );
  return {
    buckets,
    material: sumMoney(currency, material),
    machine: sumMoney(currency, machine),
    itemHandling: sumMoney(currency, itemHandling),
    amortization: sumMoney(currency, amortization),
    reprintReserve: multiplyMoneyRational(
      reprintBase,
      priceList.reprintRate,
      "ceil",
    ),
  };
}

function validateAndCollectPackingUnits(
  items: readonly OrderItemPricingInput[],
): readonly AllocationTarget[] {
  if (items.length === 0) {
    throw new DomainError("INVALID_ARGUMENT", "pricing requires an OrderItem");
  }
  const itemIds = new Set<string>();
  const packingUnitKeys = new Set<string>();
  const allTargets: AllocationTarget[] = [];
  for (const item of items) {
    assertIdentity(item.itemId, "OrderItem ID");
    if (itemIds.has(item.itemId)) {
      throw new DomainError("INVALID_ARGUMENT", "OrderItem IDs must be unique");
    }
    itemIds.add(item.itemId);
    if (item.quantity <= 0n) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "item quantity must be positive",
      );
    }
    assertNonNegative(item.postprocessingSeconds, "post-processing seconds");
    if (BigInt(item.packingUnits.length) !== item.quantity) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "each item quantity needs one pre-quote packing unit",
      );
    }
    for (const target of item.packingUnits) {
      assertIdentity(target.id, "packing unit key");
      assertNonNegative(target.basis, "packing unit allocation basis");
      if (packingUnitKeys.has(target.id)) {
        throw new DomainError(
          "INVALID_ARGUMENT",
          "packing unit keys must be unique across the order",
        );
      }
      packingUnitKeys.add(target.id);
      allTargets.push(target);
    }
  }
  return allTargets;
}

function validatePriceList(priceList: PriceListCalculationInput): void {
  assertIdentity(priceList.revision, "PriceList revision");
  assertIdentity(priceList.termsRevision, "terms revision");
  for (const [name, value] of [
    ["order fixed handling seconds", priceList.handlingOrderFixedSeconds],
    ["plate handling seconds", priceList.handlingPlateSeconds],
    ["pack handling seconds", priceList.handlingPackSeconds],
    ["shipping trip seconds", priceList.shippingTripSeconds],
    [
      "small-order weight threshold",
      priceList.smallOrderWeightThresholdMilligrams,
    ],
  ] as const) {
    assertNonNegative(value, name);
  }
  if (priceList.shippingTripPricingDivisor <= 0n) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "shipping trip pricing divisor must be positive",
    );
  }
  if (
    priceList.expressMultiplier.denominator <= 0n ||
    priceList.expressMultiplier.numerator <
      priceList.expressMultiplier.denominator
  ) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "express multiplier must be at least one",
    );
  }
  for (const [name, value] of [
    ["minimum print price", priceList.minimumPrintPrice],
    ["small-order surcharge", priceList.smallOrderSurcharge],
    ["free-shipping threshold", priceList.freeShippingPrintThreshold],
  ] as const) {
    assertCurrency(value, priceList.currency, name);
  }
}

function validateShipment(
  shipment: BindingShipmentPricingInput,
  allPackingUnits: readonly AllocationTarget[],
  currency: string,
): void {
  assertIdentity(shipment.deliveryDestinationId, "delivery destination ID");
  assertIdentity(
    shipment.deliveryCapabilitySnapshotId,
    "delivery capability snapshot ID",
  );
  if (shipment.parcels.length === 0) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "a binding ShipmentPlan needs at least one parcel",
    );
  }
  const expectedKeys = new Set(allPackingUnits.map(({ id }) => id));
  const allocatedKeys = new Set<string>();
  const shipmentPlanIds = new Set<string>();
  for (const parcel of shipment.parcels) {
    assertIdentity(parcel.shipmentPlanId, "ShipmentPlan ID");
    assertIdentity(parcel.categoryId, "shipping category ID");
    if (shipmentPlanIds.has(parcel.shipmentPlanId)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "ShipmentPlan IDs must be unique",
      );
    }
    shipmentPlanIds.add(parcel.shipmentPlanId);
    if (parcel.packingUnitKeys.length === 0) {
      throw new DomainError("INVALID_ARGUMENT", "a parcel must not be empty");
    }
    for (const key of parcel.packingUnitKeys) {
      if (!expectedKeys.has(key) || allocatedKeys.has(key)) {
        throw new DomainError(
          "INVALID_ARGUMENT",
          "ShipmentPlan must allocate every packing unit exactly once",
        );
      }
      allocatedKeys.add(key);
    }
    assertCurrency(parcel.carrierCost, currency, "carrier cost");
    assertCurrency(
      parcel.customerShippingRate,
      currency,
      "customer shipping rate",
    );
    assertCurrency(parcel.packagingCost, currency, "packaging cost");
  }
  if (allocatedKeys.size !== expectedKeys.size) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "ShipmentPlan must allocate every packing unit exactly once",
    );
  }
}

function allocatedComponent(
  componentId: string,
  kind: CalculatedPriceComponentKind,
  amount: Money,
  targets: readonly AllocationTarget[],
  targetId?: string,
): CalculatedPriceComponent {
  return {
    componentId,
    kind,
    ...(targetId === undefined ? {} : { targetId }),
    amount,
    allocations: allocateMoney(amount, targets),
  };
}

/**
 * Replays the documented order-level pricing boundary without floating point.
 * A missing endpoint-bound ShipmentPlan deliberately returns only a provisional
 * subtotal and never produces a contract total or payment schedule.
 */
export function calculateOrderPrice(
  input: OrderPriceCalculationInput,
): OrderPriceCalculation {
  const { priceList } = input;
  validatePriceList(priceList);
  if (input.profileRevisionIds.length === 0) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "pricing requires immutable profile revisions",
    );
  }
  const profileRevisionIds = new Set<string>();
  for (const revisionId of input.profileRevisionIds) {
    assertIdentity(revisionId, "profile revision ID");
    if (profileRevisionIds.has(revisionId)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "profile revision IDs must be unique",
      );
    }
    profileRevisionIds.add(revisionId);
  }
  if (input.expressRequested && !input.expressEligible) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "express pricing requires whole-order eligibility",
    );
  }
  const allPackingUnits = validateAndCollectPackingUnits(input.items);
  const currency = priceList.currency;
  const direct = directCosts(input.items, priceList);
  const parcels = input.shipment?.parcels ?? [];
  if (input.shipment !== undefined) {
    validateShipment(input.shipment, allPackingUnits, currency);
  }

  const orderFixedHandling = moneyFromRational(
    currency,
    priceList.handlingOrderFixedSeconds,
    priceList.laborRateMinorPerSecond,
  );
  const perParcelHandling = parcels.map(() =>
    moneyFromRational(
      currency,
      priceList.handlingPackSeconds,
      priceList.laborRateMinorPerSecond,
    ).add(
      moneyFromRational(currency, priceList.shippingTripSeconds, {
        numerator: priceList.laborRateMinorPerSecond.numerator,
        denominator:
          priceList.laborRateMinorPerSecond.denominator *
          priceList.shippingTripPricingDivisor,
      }),
    ),
  );
  const sharedHandling = orderFixedHandling.add(
    sumMoney(currency, perParcelHandling),
  );
  const packaging = sumMoney(
    currency,
    parcels.map(({ packagingCost }) => packagingCost),
  );
  const carrierCost = sumMoney(
    currency,
    parcels.map(({ carrierCost: cost }) => cost),
  );
  const directBucketTotal = sumMoney(
    currency,
    direct.buckets.map(({ amount }) => amount),
  );
  const productionCost = sumMoney(currency, [
    directBucketTotal,
    sharedHandling,
    packaging,
    direct.reprintReserve,
  ]);
  const printPriceBeforeSubsidy = maximum(
    priceList.minimumPrintPrice,
    addMargin(productionCost, priceList.marginRate),
  );
  const customerShipping =
    input.shipment !== undefined &&
    printPriceBeforeSubsidy.compare(priceList.freeShippingPrintThreshold) < 0
      ? sumMoney(
          currency,
          parcels.map(({ customerShippingRate }) => customerShippingRate),
        )
      : Money.zero(currency);
  const shippingSubsidy = differenceOrZero(carrierCost, customerShipping);
  const printPriceBeforeMinimum = addMargin(
    productionCost.add(shippingSubsidy),
    priceList.marginRate,
  );
  const basePrintPrice = maximum(
    priceList.minimumPrintPrice,
    printPriceBeforeMinimum,
  );
  const minimumPrintTopUp = basePrintPrice.subtract(printPriceBeforeMinimum);
  const expressSurcharge = input.expressRequested
    ? basePrintPrice.multiply(
        priceList.expressMultiplier.numerator -
          priceList.expressMultiplier.denominator,
        priceList.expressMultiplier.denominator,
        "ceil",
      )
    : Money.zero(currency);
  const totalWeight = input.items.reduce(
    (sum, item) =>
      sum +
      item.base.materialWeightMilligrams +
      item.quantityEffect.materialWeightMilligrams,
    0n,
  );
  const smallOrderSurcharge =
    totalWeight < priceList.smallOrderWeightThresholdMilligrams
      ? priceList.smallOrderSurcharge
      : Money.zero(currency);
  const subtotal = sumMoney(currency, [
    basePrintPrice,
    expressSurcharge,
    customerShipping,
    smallOrderSurcharge,
  ]);

  const subsidyAllocations =
    parcels.length === 0
      ? []
      : allocateMoney(
          shippingSubsidy,
          parcels.map((parcel) => ({
            id: parcel.shipmentPlanId,
            basis: parcel.carrierCost.minorUnits,
          })),
        );
  const subsidyByParcel = new Map(
    subsidyAllocations.map(({ targetId, amount }) => [targetId, amount]),
  );
  const shipmentPricingBases = parcels.map((parcel, index) => ({
    id: `shipment:${parcel.shipmentPlanId}`,
    basis: sumMoney(currency, [
      parcel.packagingCost,
      perParcelHandling[index] ?? Money.zero(currency),
      subsidyByParcel.get(parcel.shipmentPlanId) ?? Money.zero(currency),
    ]).minorUnits,
  }));
  const positiveBuckets = [
    ...direct.buckets.map((bucket) => ({
      id: bucket.componentId,
      basis: bucket.amount.minorUnits,
    })),
    ...shipmentPricingBases,
  ].filter(({ basis }) => basis > 0n);
  const pricingBases =
    positiveBuckets.length > 0
      ? positiveBuckets
      : direct.buckets
          .filter(({ kind }) => kind === "ITEM_PRODUCTION")
          .map((bucket) => ({ id: bucket.componentId, basis: 0n }));
  const pricedBucketAmounts = allocateMoney(
    printPriceBeforeMinimum,
    pricingBases,
  );
  const amountByBucket = new Map(
    pricedBucketAmounts.map(({ targetId, amount }) => [targetId, amount]),
  );
  const components: CalculatedPriceComponent[] = direct.buckets.map((bucket) =>
    allocatedComponent(
      bucket.componentId,
      bucket.kind,
      amountByBucket.get(bucket.componentId) ?? Money.zero(currency),
      bucket.allocationTargets,
      bucket.itemId,
    ),
  );
  components.push(
    allocatedComponent(
      "order:min-print",
      "ORDER_MIN_PRINT",
      minimumPrintTopUp,
      allPackingUnits,
    ),
    allocatedComponent(
      "order:small-order-surcharge",
      "ORDER_SMALL_SURCHARGE",
      smallOrderSurcharge,
      allPackingUnits,
    ),
    allocatedComponent(
      "order:express",
      "EXPRESS",
      expressSurcharge,
      allPackingUnits,
    ),
  );
  for (const parcel of parcels) {
    const parcelTargets = allPackingUnits.filter(({ id }) =>
      parcel.packingUnitKeys.includes(id),
    );
    const customerShippingForParcel =
      customerShipping.minorUnits === 0n
        ? Money.zero(currency)
        : parcel.customerShippingRate;
    const shipmentComponentAmount = (
      amountByBucket.get(`shipment:${parcel.shipmentPlanId}`) ??
      Money.zero(currency)
    ).add(customerShippingForParcel);
    components.push(
      allocatedComponent(
        `shipment:${parcel.shipmentPlanId}`,
        "SHIPMENT",
        shipmentComponentAmount,
        parcelTargets,
        parcel.shipmentPlanId,
      ),
    );
  }

  const breakdown: OrderPriceBreakdown = {
    material: direct.material,
    machine: direct.machine,
    itemHandling: direct.itemHandling,
    sharedHandling,
    amortization: direct.amortization,
    reprintReserve: direct.reprintReserve,
    packaging,
    carrierCost,
    productionCost,
    printPriceBeforeSubsidy,
    customerShipping,
    shippingSubsidy,
    printPriceBeforeMinimum,
    minimumPrintTopUp,
    basePrintPrice,
    expressSurcharge,
    smallOrderSurcharge,
    subtotal,
  };
  const common = {
    priceListRevision: priceList.revision,
    termsRevision: priceList.termsRevision,
    profileRevisionIds: [...profileRevisionIds].sort(),
    breakdown,
  } as const;

  if (input.shipment === undefined) {
    const tax = taxBreakdownFromNet(subtotal, priceList.taxPolicy);
    if (tax.vat.minorUnits > 0n) {
      components.push(
        allocatedComponent("order:vat", "VAT", tax.vat, allPackingUnits),
      );
    }
    return {
      kind: "provisional",
      ...common,
      customerTotal: tax.gross,
      tax,
      components,
    };
  }

  const grossedUp = grossUpPaymentSchedule(
    subtotal,
    input.paymentSchedule,
    priceList.taxPolicy,
  );
  components.push(
    allocatedComponent(
      "order:payment-fee",
      "PAYMENT_FEE",
      grossedUp.paymentFee,
      allPackingUnits,
    ),
  );
  if (grossedUp.tax.vat.minorUnits > 0n) {
    components.push(
      allocatedComponent(
        "order:vat",
        "VAT",
        grossedUp.tax.vat,
        allPackingUnits,
      ),
    );
  }
  return {
    kind: "binding",
    ...common,
    shipmentPlanIds: input.shipment.parcels.map(
      ({ shipmentPlanId }) => shipmentPlanId,
    ),
    deliveryDestinationId: input.shipment.deliveryDestinationId,
    deliveryCapabilitySnapshotId: input.shipment.deliveryCapabilitySnapshotId,
    customerTotal: grossedUp.contractTotal,
    tax: grossedUp.tax,
    contractTotal: grossedUp.contractTotal,
    paymentFee: grossedUp.paymentFee,
    captures: grossedUp.captures,
    components,
  };
}
