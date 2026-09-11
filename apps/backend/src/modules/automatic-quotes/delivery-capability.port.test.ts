import { describe, expect, it } from "vitest";
import {
  ConfiguredDeliveryCapabilityAdapter,
  PacketaDeliveryCapabilityAdapter,
} from "./delivery-capability.port";

describe("ConfiguredDeliveryCapabilityAdapter", () => {
  it("freezes validated delivery configuration for the process lifetime", async () => {
    const previous = process.env.TAVEN_DELIVERY_ENDPOINTS_JSON;
    process.env.TAVEN_DELIVERY_ENDPOINTS_JSON = JSON.stringify([
      {
        providerEndpointId: "configured-once",
        endpointType: "pickup_point",
        addressSnapshot: { country: "CZ", city: "Praha", label: "Once" },
        supportedCategoryIds: ["pickup"],
      },
    ]);
    try {
      const adapter = new ConfiguredDeliveryCapabilityAdapter();
      process.env.TAVEN_DELIVERY_ENDPOINTS_JSON = JSON.stringify([
        {
          providerEndpointId: "changed-without-restart",
          endpointType: "pickup_point",
          addressSnapshot: { country: "CZ", city: "Brno", label: "Changed" },
          supportedCategoryIds: ["zbox"],
        },
      ]);

      expect(adapter.configuredOptions()).toEqual([
        {
          providerEndpointId: "configured-once",
          endpointType: "pickup_point",
          label: "Once",
          supportedCategoryIds: ["pickup"],
        },
      ]);
      const resolved = await adapter.validateSelection({
        providerEndpointId: "configured-once",
        endpointType: "pickup_point",
        parcels: [],
      });
      expect(Object.isFrozen(resolved.addressSnapshot)).toBe(true);
      await expect(
        adapter.validateSelection({
          providerEndpointId: "changed-without-restart",
          endpointType: "pickup_point",
          parcels: [],
        }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      if (previous === undefined) {
        delete process.env.TAVEN_DELIVERY_ENDPOINTS_JSON;
      } else {
        process.env.TAVEN_DELIVERY_ENDPOINTS_JSON = previous;
      }
    }
  });
});

describe("PacketaDeliveryCapabilityAdapter", () => {
  it("uses server-owned feeds and validation, retaining only a narrow immutable snapshot", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const adapter = new PacketaDeliveryCapabilityAdapter(
      { accountId: "public-widget-key", widgetOptions: { language: "cs" } },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/branch/json")) {
          return Response.json([
            {
              id: "pickup-1",
              name: "Výdejní místo",
              street: "Náměstí 1",
              city: "Praha",
              zip: "110 00",
              country: "cz",
              displayFrontend: 1,
              maxWeight: 5,
            },
          ]);
        }
        if (String(url).includes("/box/json")) {
          return Response.json([
            {
              id: "zbox-1",
              name: "Z-BOX",
              street: "Ulice 2",
              city: "Praha",
              zip: "120 00",
              country: "cz",
              displayFrontend: 1,
            },
          ]);
        }
        return Response.json({ isValid: true });
      }) as typeof fetch,
    );

    const selected = await adapter.validateSelection({
      providerEndpointId: "zbox-1",
      endpointType: "pickup_point",
      parcels: [
        {
          weightMilligrams: 1_000_000n,
          xMicrometers: 100_000n,
          yMicrometers: 200_000n,
          zMicrometers: 300_000n,
        },
      ],
    });

    expect(selected).toMatchObject({
      providerEndpointId: "zbox-1",
      supportedCategoryIds: ["zbox"],
      capabilitySnapshot: {
        provider: "packeta",
        version: 1,
        supportedCategoryIds: ["zbox"],
      },
    });
    expect(calls).toHaveLength(3);
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      point: { id: "zbox-1" },
      options: {
        country: "cz",
        carriers: "packeta",
        cashOnDelivery: false,
        vendors: [{ country: "cz" }, { country: "cz", group: "zbox" }],
      },
    });
    expect(
      adapter.readCommittedCapability({
        ...selected,
      }),
    ).toMatchObject(selected);
  });

  it("rejects provider invalid-200 responses instead of treating HTTP success as validation", async () => {
    const adapter = new PacketaDeliveryCapabilityAdapter(
      { accountId: "public-widget-key", widgetOptions: {} },
      (async (url) => {
        if (String(url).includes("/branch/json")) {
          return Response.json([
            {
              id: "pickup-1",
              name: "Výdejní místo",
              street: "Náměstí 1",
              city: "Praha",
              zip: "110 00",
              country: "cz",
              displayFrontend: 1,
            },
          ]);
        }
        if (String(url).includes("/box/json")) return Response.json([]);
        return Response.json({
          isValid: false,
          errors: [{ code: "PickupPointIsFull" }],
        });
      }) as typeof fetch,
    );

    await expect(
      adapter.validateSelection({
        providerEndpointId: "pickup-1",
        endpointType: "pickup_point",
        parcels: [
          {
            weightMilligrams: 1_000_000n,
            xMicrometers: 100_000n,
            yMicrometers: 100_000n,
            zMicrometers: 100_000n,
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
