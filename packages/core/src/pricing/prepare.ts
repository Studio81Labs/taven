import { DomainError } from "../primitives/errors.js";
import type { Money } from "../primitives/money.js";
import { evaluateExpressEligibility, evaluateQuoteGates } from "./gates.js";
import {
  calculateOrderPrice,
  type BindingShipmentPricingInput,
  type OrderPriceCalculation,
  type OrderPriceCalculationInput,
} from "./quote.js";
import {
  planShipment,
  type ShipmentPlanNoFit,
  type ShipmentPlannerInput,
  type ShipmentPlanSuccess,
} from "./shipment-plan.js";
import type {
  ExpressEligibility,
  ExpressEligibilityInput,
  QuoteGateInput,
  QuoteGateReason,
} from "./types.js";

export type AutomaticQuoteFacts = Pick<
  QuoteGateInput,
  | "referenceSlicingComplete"
  | "supportedFormat"
  | "hasBlockingPreflightFinding"
  | "riskAcknowledgementsComplete"
  | "withinAutomaticQuantityLimit"
  | "withinAutomaticAmountLimit"
  | "withinBuildLimits"
>;

export interface ShipmentCategoryPricing {
  readonly categoryId: string;
  readonly carrierCost: Money;
  readonly customerShippingRate: Money;
  readonly packagingCost: Money;
}

export interface DestinationShipmentPreparation {
  readonly deliveryDestinationId: string;
  readonly deliveryCapabilitySnapshotId: string;
  readonly plannerInput: ShipmentPlannerInput;
  readonly categoryPricing: readonly ShipmentCategoryPricing[];
  /** Called once per planned parcel in ordinal order to bind its database row. */
  readonly shipmentPlanIdForOrdinal: (ordinal: number) => string;
}

export interface PrepareOrderQuoteInput {
  readonly pricing: Omit<
    OrderPriceCalculationInput,
    "shipment" | "expressEligible"
  >;
  readonly automaticQuoteFacts: AutomaticQuoteFacts;
  readonly expressEligibility: ExpressEligibilityInput;
  /** Omit before a customer selects an endpoint and its capability snapshot. */
  readonly destinationShipment?: DestinationShipmentPreparation;
}

type ProvisionalPrice = Extract<OrderPriceCalculation, { kind: "provisional" }>;
type BindingPrice = Extract<OrderPriceCalculation, { kind: "binding" }>;

export type PreparedOrderQuote =
  | {
      readonly kind: "provisional";
      readonly reasons: readonly QuoteGateReason[];
      readonly expressEligibility: ExpressEligibility;
      readonly price: ProvisionalPrice;
      readonly shipmentPlan?: ShipmentPlanSuccess;
    }
  | {
      readonly kind: "custom_request";
      readonly reasons: readonly QuoteGateReason[];
      readonly expressEligibility: ExpressEligibility;
      readonly price: ProvisionalPrice;
      readonly shipmentFailure?: ShipmentPlanNoFit;
    }
  | {
      readonly kind: "binding_quote";
      readonly reasons: readonly [];
      readonly expressEligibility: ExpressEligibility;
      readonly shipmentPlan: ShipmentPlanSuccess;
      readonly price: BindingPrice;
    };

function provisionalPrice(
  input: PrepareOrderQuoteInput,
  express: ExpressEligibility,
): ProvisionalPrice {
  const calculated = calculateOrderPrice({
    ...input.pricing,
    expressRequested: input.pricing.expressRequested && express.eligible,
    expressEligible: express.eligible,
  });
  if (calculated.kind !== "provisional") {
    throw new DomainError(
      "TRANSITION_GUARD_FAILED",
      "a quote without a ShipmentPlan must remain provisional",
    );
  }
  return calculated;
}

function gateInput(
  input: PrepareOrderQuoteInput,
  express: ExpressEligibility,
  shipment: {
    readonly destinationSelected: boolean;
    readonly capabilitySnapshotPresent: boolean;
    readonly planPresent: boolean;
    readonly eligible: boolean;
  },
): QuoteGateInput {
  return {
    ...input.automaticQuoteFacts,
    deliveryDestinationSelected: shipment.destinationSelected,
    deliveryCapabilitySnapshotPresent: shipment.capabilitySnapshotPresent,
    shipmentPlanPresent: shipment.planPresent,
    shipmentEligible: shipment.eligible,
    expressRequested: input.pricing.expressRequested,
    expressEligible: express.eligible,
  };
}

function categoryPricingById(
  values: readonly ShipmentCategoryPricing[],
): ReadonlyMap<string, ShipmentCategoryPricing> {
  const result = new Map<string, ShipmentCategoryPricing>();
  for (const value of values) {
    if (value.categoryId.trim().length === 0 || result.has(value.categoryId)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "shipment category pricing IDs must be non-blank and unique",
      );
    }
    result.set(value.categoryId, value);
  }
  return result;
}

/**
 * Composes the direct quote decision. A slice can expose a provisional price,
 * while only an endpoint-filtered successful plan can produce a binding total.
 */
export function prepareOrderQuote(
  input: PrepareOrderQuoteInput,
): PreparedOrderQuote {
  const express = evaluateExpressEligibility(input.expressEligibility);
  const provisional = provisionalPrice(input, express);
  const destination = input.destinationShipment;
  if (destination === undefined) {
    const gates = evaluateQuoteGates(
      gateInput(input, express, {
        destinationSelected: false,
        capabilitySnapshotPresent: false,
        planPresent: false,
        eligible: true,
      }),
    );
    return gates.kind === "custom_request"
      ? {
          kind: "custom_request",
          reasons: gates.reasons,
          expressEligibility: express,
          price: provisional,
        }
      : {
          kind: "provisional",
          reasons: gates.reasons,
          expressEligibility: express,
          price: provisional,
        };
  }

  const shipmentPlan = planShipment(destination.plannerInput);
  if (shipmentPlan.status === "no_fit") {
    const gates = evaluateQuoteGates(
      gateInput(input, express, {
        destinationSelected: true,
        capabilitySnapshotPresent: true,
        planPresent: false,
        eligible: false,
      }),
    );
    return {
      kind: "custom_request",
      reasons:
        gates.kind === "custom_request"
          ? gates.reasons
          : (["SHIPMENT_INELIGIBLE"] as const),
      expressEligibility: express,
      price: provisional,
      shipmentFailure: shipmentPlan,
    };
  }

  const gates = evaluateQuoteGates(
    gateInput(input, express, {
      destinationSelected: true,
      capabilitySnapshotPresent: true,
      planPresent: true,
      eligible: true,
    }),
  );
  if (gates.kind !== "binding_quote") {
    return gates.kind === "custom_request"
      ? {
          kind: "custom_request",
          reasons: gates.reasons,
          expressEligibility: express,
          price: provisional,
        }
      : {
          kind: "provisional",
          reasons: gates.reasons,
          expressEligibility: express,
          price: provisional,
          shipmentPlan,
        };
  }

  const prices = categoryPricingById(destination.categoryPricing);
  const bindingShipment: BindingShipmentPricingInput = {
    deliveryDestinationId: destination.deliveryDestinationId,
    deliveryCapabilitySnapshotId: destination.deliveryCapabilitySnapshotId,
    parcels: shipmentPlan.parcels.map((parcel) => {
      const price = prices.get(parcel.categoryId);
      if (price === undefined) {
        throw new DomainError(
          "INVALID_ARGUMENT",
          `missing pricing for shipment category ${parcel.categoryId}`,
        );
      }
      return {
        shipmentPlanId: destination.shipmentPlanIdForOrdinal(parcel.ordinal),
        categoryId: parcel.categoryId,
        packingUnitKeys: parcel.placements.map(
          ({ packingUnitKey }) => packingUnitKey,
        ),
        carrierCost: price.carrierCost,
        customerShippingRate: price.customerShippingRate,
        packagingCost: price.packagingCost,
      };
    }),
  };
  const price = calculateOrderPrice({
    ...input.pricing,
    expressEligible: express.eligible,
    shipment: bindingShipment,
  });
  if (price.kind !== "binding") {
    throw new DomainError(
      "TRANSITION_GUARD_FAILED",
      "a successful endpoint-bound plan must produce a binding price",
    );
  }
  return {
    kind: "binding_quote",
    reasons: [],
    expressEligibility: express,
    shipmentPlan,
    price,
  };
}
