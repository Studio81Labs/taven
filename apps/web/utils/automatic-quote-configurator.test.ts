import { describe, expect, it } from "vitest";
import {
  configurationValues,
  groupsFromAssignments,
  initialBodyAssignments,
  initialBodyGroups,
  isExpressVisible,
  quantityComparison,
  requiresAssistedQuote,
  requiresQuoteRestart,
  selectConfigurationOption,
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
  it("keeps multiple bodies together by default and permits meaningful groups", () => {
    expect(initialBodyGroups(["case", "lid", "pin"], [])).toEqual([
      { bodyIds: ["case", "lid", "pin"], ordinal: 0 },
    ]);
    expect(
      groupsFromAssignments(["case", "lid", "pin"], {
        case: 0,
        lid: 0,
        pin: 1,
      }),
    ).toEqual([
      { bodyIds: ["case", "lid"], ordinal: 0 },
      { bodyIds: ["pin"], ordinal: 1 },
    ]);
  });

  it("omits bodies that the customer explicitly excludes", () => {
    expect(
      groupsFromAssignments(["case", "support", "lid"], {
        case: 0,
        support: -1,
        lid: 0,
      }),
    ).toEqual([{ bodyIds: ["case", "lid"], ordinal: 0 }]);
  });

  it("restores bodies absent from saved items as explicitly excluded", () => {
    const groups = initialBodyGroups(
      ["case", "lid", "pin"],
      [{ bodyIds: ["case"], ordinal: 0 }],
    );

    expect(groups).toEqual([{ bodyIds: ["case"], ordinal: 0 }]);
    expect(initialBodyAssignments(["case", "lid", "pin"], groups)).toEqual({
      case: 0,
      lid: -1,
      pin: -1,
    });
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
    ]);
    expect(visible.map(({ id }) => id)).toEqual([
      "shipment-1",
      "shipment-2",
      "minimum-1",
      "surcharge-1",
    ]);
  });
});
