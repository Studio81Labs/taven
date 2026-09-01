import { describe, expect, it } from "vitest";
import { evaluateExpressEligibility, evaluateQuoteGates } from "./gates.js";
import type { QuoteGateInput } from "./types.js";

const bindingInput: QuoteGateInput = {
  referenceSlicingComplete: true,
  deliveryDestinationSelected: true,
  deliveryCapabilitySnapshotPresent: true,
  shipmentPlanPresent: true,
  supportedFormat: true,
  hasBlockingPreflightFinding: false,
  riskAcknowledgementsComplete: true,
  withinAutomaticQuantityLimit: true,
  withinAutomaticAmountLimit: true,
  withinBuildLimits: true,
  shipmentEligible: true,
  expressRequested: false,
  expressEligible: false,
};

describe("quote gates", () => {
  it("keeps a completed slice provisional until endpoint-bound shipment planning", () => {
    expect(
      evaluateQuoteGates({
        ...bindingInput,
        deliveryDestinationSelected: false,
        deliveryCapabilitySnapshotPresent: false,
        shipmentPlanPresent: false,
      }),
    ).toEqual({
      kind: "provisional",
      reasons: [
        "DELIVERY_DESTINATION_REQUIRED",
        "DELIVERY_CAPABILITY_SNAPSHOT_REQUIRED",
        "SHIPMENT_PLAN_REQUIRED",
      ],
    });
  });

  it("routes actual automatic-quote failures to custom request before provisional state", () => {
    expect(
      evaluateQuoteGates({
        ...bindingInput,
        supportedFormat: false,
        hasBlockingPreflightFinding: true,
        deliveryDestinationSelected: false,
      }),
    ).toEqual({
      kind: "custom_request",
      reasons: ["UNSUPPORTED_FORMAT", "BLOCKING_PREFLIGHT_FINDING"],
    });
  });

  it("keeps an otherwise valid quote pending while risk acknowledgements remain", () => {
    expect(
      evaluateQuoteGates({
        ...bindingInput,
        riskAcknowledgementsComplete: false,
      }),
    ).toEqual({
      kind: "provisional",
      reasons: ["RISK_ACKNOWLEDGEMENT_REQUIRED"],
    });
  });

  it("requires every whole-order express condition", () => {
    expect(
      evaluateExpressEligibility({
        phaseKind: "SINGLE",
        requiredPlateCount: 2n,
        maximumPlateCount: 2n,
        materialAndColorAvailable: true,
        hasNonstandardPostprocessing: false,
        requiredProductionSeconds: 3_000n,
        availableProductionWindowSeconds: 3_600n,
        packagingBufferSeconds: 600n,
      }),
    ).toEqual({ eligible: true, reasons: [] });
    expect(
      evaluateExpressEligibility({
        phaseKind: "SAMPLE",
        requiredPlateCount: 3n,
        maximumPlateCount: 2n,
        materialAndColorAvailable: false,
        hasNonstandardPostprocessing: true,
        requiredProductionSeconds: 3_001n,
        availableProductionWindowSeconds: 3_600n,
        packagingBufferSeconds: 600n,
      }),
    ).toEqual({
      eligible: false,
      reasons: [
        "PHASE_NOT_SINGLE",
        "TOO_MANY_PLATES",
        "MATERIAL_OR_COLOR_UNAVAILABLE",
        "NONSTANDARD_POSTPROCESSING",
        "PRODUCTION_WINDOW_INSUFFICIENT",
      ],
    });
  });

  it("permits a binding quote only when every required input is complete", () => {
    expect(evaluateQuoteGates(bindingInput)).toEqual({
      kind: "binding_quote",
      reasons: [],
    });
    expect(
      evaluateQuoteGates({
        ...bindingInput,
        expressRequested: true,
        expressEligible: false,
      }),
    ).toEqual({ kind: "custom_request", reasons: ["EXPRESS_INELIGIBLE"] });
  });
});
