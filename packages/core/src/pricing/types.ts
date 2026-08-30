import type { Money } from "../primitives/money.js";

/** A non-negative rational number represented without floating point. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type PaymentScheduleRole = "FULL" | "DEPOSIT" | "BALANCE";

/**
 * A planned capture's share of the eventual gross contract total. Shares use
 * basis points so their sum is always exactly 10_000.
 */
export interface PaymentScheduleCapture {
  readonly id: string;
  readonly sequence: number;
  readonly role: PaymentScheduleRole;
  readonly shareBasisPoints: number;
  readonly feeRateBasisPoints: number;
  readonly feeFixed: Money;
}

export interface GrossedUpPaymentCapture {
  readonly id: string;
  readonly sequence: number;
  readonly role: PaymentScheduleRole;
  readonly gross: Money;
  readonly fee: Money;
}

export interface PaymentScheduleGrossUp {
  readonly contractTotal: Money;
  readonly paymentFee: Money;
  readonly captures: readonly GrossedUpPaymentCapture[];
}

export interface AllocationTarget {
  /** Stable, domain-owned identity used as the final tie-break. */
  readonly id: string;
  /** Non-negative allocation basis, normally a pre-rounding monetary value. */
  readonly basis: bigint;
}

export interface MonetaryAllocation {
  readonly targetId: string;
  readonly amount: Money;
}

export interface PriceComponentAllocationInput {
  readonly componentId: string;
  readonly amount: Money;
  readonly targets: readonly AllocationTarget[];
}

export interface AllocatedPriceComponent {
  readonly componentId: string;
  readonly amount: Money;
  readonly allocations: readonly MonetaryAllocation[];
}

export type QuoteGateReason =
  | "REFERENCE_SLICING_PENDING"
  | "DELIVERY_DESTINATION_REQUIRED"
  | "DELIVERY_CAPABILITY_SNAPSHOT_REQUIRED"
  | "SHIPMENT_PLAN_REQUIRED"
  | "UNSUPPORTED_FORMAT"
  | "BLOCKING_PREFLIGHT_FINDING"
  | "RISK_ACKNOWLEDGEMENT_REQUIRED"
  | "AUTOMATIC_QUANTITY_LIMIT_EXCEEDED"
  | "AUTOMATIC_AMOUNT_LIMIT_EXCEEDED"
  | "BUILD_LIMIT_EXCEEDED"
  | "SHIPMENT_INELIGIBLE"
  | "EXPRESS_INELIGIBLE";

export type QuoteGateResult =
  | {
      readonly kind: "provisional";
      readonly reasons: readonly QuoteGateReason[];
    }
  | {
      readonly kind: "custom_request";
      readonly reasons: readonly QuoteGateReason[];
    }
  | { readonly kind: "binding_quote"; readonly reasons: readonly [] };

/** Input facts only; orchestration supplies them from immutable slice/plan data. */
export interface QuoteGateInput {
  readonly referenceSlicingComplete: boolean;
  readonly deliveryDestinationSelected: boolean;
  readonly deliveryCapabilitySnapshotPresent: boolean;
  readonly shipmentPlanPresent: boolean;
  readonly supportedFormat: boolean;
  readonly hasBlockingPreflightFinding: boolean;
  readonly riskAcknowledgementsComplete: boolean;
  readonly withinAutomaticQuantityLimit: boolean;
  readonly withinAutomaticAmountLimit: boolean;
  readonly withinBuildLimits: boolean;
  readonly shipmentEligible: boolean;
  readonly expressRequested: boolean;
  readonly expressEligible: boolean;
}

export type ExpressGateReason =
  | "PHASE_NOT_SINGLE"
  | "TOO_MANY_PLATES"
  | "MATERIAL_OR_COLOR_UNAVAILABLE"
  | "NONSTANDARD_POSTPROCESSING"
  | "PRODUCTION_WINDOW_INSUFFICIENT";

export interface ExpressEligibilityInput {
  readonly phaseKind: "SINGLE" | "SAMPLE" | "BATCH";
  readonly requiredPlateCount: bigint;
  readonly materialAndColorAvailable: boolean;
  readonly hasNonstandardPostprocessing: boolean;
  readonly requiredProductionSeconds: bigint;
  readonly availableProductionWindowSeconds: bigint;
  readonly packagingBufferSeconds: bigint;
}

export interface ExpressEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly ExpressGateReason[];
}
