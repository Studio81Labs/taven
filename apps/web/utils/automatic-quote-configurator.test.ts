import { describe, expect, it } from "vitest";
import {
  bodyAssignmentKey,
  canRecoverWithStandardProduction,
  canAddBodyGroup,
  configurationValues,
  initialModelBodyAssignments,
  initialModelBodyGroups,
  isExpressVisible,
  modelGroupsFromAssignments,
  quantityComparison,
  requiresAssistedQuote,
  requiresQuoteRestart,
  selectConfigurationOption,
  shouldShowUnavailableConfigurationWarning,
  visiblePriceComponents,
  type ConfigurationOption,
  type PriceComponent,
} from "./automatic-quote-configurator";

const options: ConfigurationOption[] = [
  {
    color: "modrá",
    infillPreset: "STANDARD",
    material: "PLA",
    printConfigRevisionId: "pla-standard",
    quality: "STANDARD",
  },
  {
    color: "černá",
    infillPreset: "STRONG",
    material: "PETG",
    printConfigRevisionId: "petg-strong",
    quality: "FINE",
  },
];

describe("body grouping", () => {
  const modelFiles = [
    { discoveredBodyIds: ["body-1", "support"], modelFileId: "model-a" },
    { discoveredBodyIds: ["body-1", "lid"], modelFileId: "model-b" },
  ];

  it("creates one globally numbered default group per attached model file", () => {
    expect(initialModelBodyGroups(modelFiles, [])).toEqual([
      {
        bodyIds: ["body-1", "support"],
        modelFileId: "model-a",
        ordinal: 0,
      },
      {
        bodyIds: ["body-1", "lid"],
        modelFileId: "model-b",
        ordinal: 1,
      },
    ]);
  });

  it("restores stable ordinals and explicit exclusions across files", () => {
    const groups = initialModelBodyGroups(modelFiles, [
      { bodyIds: ["body-1"], modelFileId: "model-a", ordinal: 2 },
      { bodyIds: ["lid"], modelFileId: "model-b", ordinal: 7 },
    ]);
    const assignments = initialModelBodyAssignments(modelFiles, groups);

    expect(groups).toEqual([
      { bodyIds: ["body-1"], modelFileId: "model-a", ordinal: 2 },
      { bodyIds: ["lid"], modelFileId: "model-b", ordinal: 7 },
    ]);
    expect(assignments).toEqual({
      [bodyAssignmentKey("model-a", "body-1")]: 2,
      [bodyAssignmentKey("model-a", "support")]: -1,
      [bodyAssignmentKey("model-b", "body-1")]: -1,
      [bodyAssignmentKey("model-b", "lid")]: 7,
    });
  });

  it("scopes duplicate body IDs by model file", () => {
    const assignments = {
      [bodyAssignmentKey("model-a", "body-1")]: 2,
      [bodyAssignmentKey("model-a", "support")]: -1,
      [bodyAssignmentKey("model-b", "body-1")]: 7,
      [bodyAssignmentKey("model-b", "lid")]: -1,
    };

    expect(modelGroupsFromAssignments(modelFiles, assignments)).toEqual([
      { bodyIds: ["body-1"], modelFileId: "model-a", ordinal: 2 },
      { bodyIds: ["body-1"], modelFileId: "model-b", ordinal: 7 },
    ]);
  });

  it("does not re-include a wholly excluded file", () => {
    const groups = initialModelBodyGroups(modelFiles, [
      { bodyIds: ["body-1"], modelFileId: "model-a", ordinal: 2 },
    ]);
    const assignments = initialModelBodyAssignments(modelFiles, groups);

    expect(modelGroupsFromAssignments(modelFiles, assignments)).toEqual([
      { bodyIds: ["body-1"], modelFileId: "model-a", ordinal: 2 },
    ]);
    expect(assignments[bodyAssignmentKey("model-b", "body-1")]).toBe(-1);
    expect(assignments[bodyAssignmentKey("model-b", "lid")]).toBe(-1);
  });

  it("allows a fully assigned saved item to be split into another group", () => {
    expect(canAddBodyGroup(3, 1)).toBe(true);
    expect(canAddBodyGroup(3, 3)).toBe(false);
    expect(canAddBodyGroup(1, 1)).toBe(false);
    expect(canAddBodyGroup(1, 0)).toBe(true);
  });

  it("preserves the remaining group identity when an earlier group is excluded", () => {
    expect(
      modelGroupsFromAssignments(
        [
          {
            discoveredBodyIds: ["red-body", "blue-body"],
            modelFileId: "model-a",
          },
        ],
        {
          [bodyAssignmentKey("model-a", "red-body")]: -1,
          [bodyAssignmentKey("model-a", "blue-body")]: 1,
        },
      ),
    ).toEqual([{ bodyIds: ["blue-body"], modelFileId: "model-a", ordinal: 1 }]);
  });
});

describe("exact configuration eligibility", () => {
  it("never constructs a material/color union that the server did not return", () => {
    expect(configurationValues(options, options[0]!, "color")).toEqual([
      "modrá",
    ]);
    expect(
      selectConfigurationOption(options, options[0]!, "material", "PETG"),
    ).toEqual(options[1]);
  });
});

describe("quantity comparison", () => {
  it("reads only the active item quantity", () => {
    const quantities = { 0: 20, 1: 5 };
    expect(
      quantityComparison(1, quantities, [
        {
          currency: "CZK",
          itemOrdinal: 0,
          orderTotalMinor: 999,
          quantity: 1,
        },
        {
          currency: "CZK",
          itemOrdinal: 1,
          orderTotalMinor: 12500,
          quantity: 5,
        },
      ]),
    ).toEqual([
      {
        active: false,
        currency: undefined,
        orderTotalMinor: undefined,
        value: 1,
      },
      {
        active: true,
        currency: "CZK",
        orderTotalMinor: 12500,
        value: 5,
      },
      {
        active: false,
        currency: undefined,
        orderTotalMinor: undefined,
        value: 20,
      },
    ]);
  });
});

describe("quote boundary states", () => {
  it("requires a new quote after expiry", () => {
    expect(requiresQuoteRestart({ phase: "EXPIRED" })).toBe(true);
  });

  it("hides whole-order express when one item makes it ineligible", () => {
    expect(
      isExpressVisible({
        express: {
          eligible: false,
          reasons: ["EXPRESS_INELIGIBLE"],
          requested: false,
        },
      }),
    ).toBe(false);
  });

  it("offers standard production only for pending or Express-only recovery", () => {
    expect(
      canRecoverWithStandardProduction({
        express: {
          eligible: false,
          reasons: ["ELIGIBILITY_PENDING"],
          requested: true,
        },
        handoff: null,
        phase: "ELIGIBILITY_PENDING",
      }),
    ).toBe(true);
    expect(
      canRecoverWithStandardProduction({
        express: {
          eligible: false,
          reasons: ["EXPRESS_INELIGIBLE"],
          requested: true,
        },
        handoff: {
          kind: "INDIVIDUAL_QUOTE_REQUEST",
          reasons: ["EXPRESS_INELIGIBLE"],
          safeContext: {},
        },
        phase: "HANDOFF_REQUIRED",
      }),
    ).toBe(true);
    expect(
      canRecoverWithStandardProduction({
        express: {
          eligible: false,
          reasons: ["EXPRESS_INELIGIBLE"],
          requested: true,
        },
        handoff: {
          kind: "INDIVIDUAL_QUOTE_REQUEST",
          reasons: ["EXPRESS_INELIGIBLE", "BUILD_LIMIT_EXCEEDED"],
          safeContext: {},
        },
        phase: "HANDOFF_REQUIRED",
      }),
    ).toBe(false);
  });

  it("routes no-capacity and other handoffs to the assisted path", () => {
    expect(
      requiresAssistedQuote({
        handoff: {
          kind: "INDIVIDUAL_QUOTE_REQUEST",
          reasons: ["NO_CONFIGURATION_AVAILABLE"],
          safeContext: {},
        },
        phase: "HANDOFF_REQUIRED",
      }),
    ).toBe(true);
  });

  it("only warns about an empty configuration catalog while editable or handed off", () => {
    expect(
      shouldShowUnavailableConfigurationWarning({
        configurationEditable: true,
        configurationOptions: [],
        handoff: null,
        phase: "CONFIGURATION_REQUIRED",
      }),
    ).toBe(true);
    expect(
      shouldShowUnavailableConfigurationWarning({
        configurationEditable: false,
        configurationOptions: [],
        handoff: {
          kind: "INDIVIDUAL_QUOTE_REQUEST",
          reasons: ["NO_CONFIGURATION_AVAILABLE"],
          safeContext: {},
        },
        phase: "HANDOFF_REQUIRED",
      }),
    ).toBe(true);
    expect(
      shouldShowUnavailableConfigurationWarning({
        configurationEditable: false,
        configurationOptions: [],
        handoff: null,
        phase: "CHECKOUT_READY",
      }),
    ).toBe(false);
    expect(
      shouldShowUnavailableConfigurationWarning({
        configurationEditable: true,
        configurationOptions: options,
        handoff: null,
        phase: "CONFIGURATION_REQUIRED",
      }),
    ).toBe(false);
  });
});

describe("order price breakdown", () => {
  it("shows split shipments while singleton order charges appear once", () => {
    const component = (
      id: string,
      kind: PriceComponent["kind"],
      scope: PriceComponent["scope"] = "ORDER",
    ): PriceComponent => ({
      amountMinor: 5_000,
      id,
      itemOrdinal: null,
      kind,
      scope,
      shipmentPlanOrdinal: null,
    });
    const visible = visiblePriceComponents([
      component("shipment-1", "SHIPMENT", "SHIPMENT_PLAN"),
      component("shipment-2", "SHIPMENT", "SHIPMENT_PLAN"),
      component("minimum-1", "ORDER_MIN_PRINT"),
      component("minimum-duplicate", "ORDER_MIN_PRINT"),
      component("surcharge-1", "ORDER_SMALL_SURCHARGE"),
      component("surcharge-duplicate", "ORDER_SMALL_SURCHARGE"),
      component("vat-1", "VAT"),
      component("vat-duplicate", "VAT"),
    ]);
    expect(visible.map(({ id }) => id)).toEqual([
      "shipment-1",
      "shipment-2",
      "minimum-1",
      "surcharge-1",
      "vat-1",
    ]);
  });
});
