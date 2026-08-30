import { DomainError } from "../primitives/errors.js";
import type {
  ExpressEligibility,
  ExpressEligibilityInput,
  ExpressGateReason,
  QuoteGateInput,
  QuoteGateReason,
  QuoteGateResult,
} from "./types.js";

function assertNonNegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new DomainError("NEGATIVE_RESULT", `${name} must not be negative`);
  }
}

/** Evaluates the all-or-nothing, whole-order express offer. */
export function evaluateExpressEligibility(
  input: ExpressEligibilityInput,
): ExpressEligibility {
  assertNonNegative(input.requiredPlateCount, "required plate count");
  assertNonNegative(
    input.requiredProductionSeconds,
    "required production seconds",
  );
  assertNonNegative(
    input.availableProductionWindowSeconds,
    "available production window seconds",
  );
  assertNonNegative(input.packagingBufferSeconds, "packaging buffer seconds");

  const reasons: ExpressGateReason[] = [];
  if (input.phaseKind !== "SINGLE") reasons.push("PHASE_NOT_SINGLE");
  if (input.requiredPlateCount > 2n) reasons.push("TOO_MANY_PLATES");
  if (!input.materialAndColorAvailable)
    reasons.push("MATERIAL_OR_COLOR_UNAVAILABLE");
  if (input.hasNonstandardPostprocessing)
    reasons.push("NONSTANDARD_POSTPROCESSING");
  if (
    input.availableProductionWindowSeconds < input.packagingBufferSeconds ||
    input.requiredProductionSeconds >
      input.availableProductionWindowSeconds - input.packagingBufferSeconds
  ) {
    reasons.push("PRODUCTION_WINDOW_INSUFFICIENT");
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Distinguishes a still-incomplete delivery flow from a request that cannot
 * receive an automatic price. A binding quote is possible only after a
 * destination-bound shipment plan exists.
 */
export function evaluateQuoteGates(input: QuoteGateInput): QuoteGateResult {
  const permanentReasons: QuoteGateReason[] = [];
  if (!input.supportedFormat) permanentReasons.push("UNSUPPORTED_FORMAT");
  if (input.hasBlockingPreflightFinding)
    permanentReasons.push("BLOCKING_PREFLIGHT_FINDING");
  if (!input.withinAutomaticQuantityLimit)
    permanentReasons.push("AUTOMATIC_QUANTITY_LIMIT_EXCEEDED");
  if (!input.withinAutomaticAmountLimit)
    permanentReasons.push("AUTOMATIC_AMOUNT_LIMIT_EXCEEDED");
  if (!input.withinBuildLimits) permanentReasons.push("BUILD_LIMIT_EXCEEDED");
  if (!input.shipmentEligible) permanentReasons.push("SHIPMENT_INELIGIBLE");
  if (input.expressRequested && !input.expressEligible) {
    permanentReasons.push("EXPRESS_INELIGIBLE");
  }
  if (permanentReasons.length > 0) {
    return { kind: "custom_request", reasons: permanentReasons };
  }

  const provisionalReasons: QuoteGateReason[] = [];
  if (!input.referenceSlicingComplete)
    provisionalReasons.push("REFERENCE_SLICING_PENDING");
  if (!input.riskAcknowledgementsComplete)
    provisionalReasons.push("RISK_ACKNOWLEDGEMENT_REQUIRED");
  if (!input.deliveryDestinationSelected)
    provisionalReasons.push("DELIVERY_DESTINATION_REQUIRED");
  if (!input.deliveryCapabilitySnapshotPresent)
    provisionalReasons.push("DELIVERY_CAPABILITY_SNAPSHOT_REQUIRED");
  if (!input.shipmentPlanPresent)
    provisionalReasons.push("SHIPMENT_PLAN_REQUIRED");
  if (provisionalReasons.length > 0) {
    return { kind: "provisional", reasons: provisionalReasons };
  }
  return { kind: "binding_quote", reasons: [] };
}
