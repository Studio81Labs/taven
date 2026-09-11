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
        if (String(url).includes("/branch.json")) {
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
        if (String(url).includes("/box.json")) {
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
    expect(calls[0]?.url).toContain("/branch.json?lang=cs");
    expect(calls[1]?.url).toContain("/box.json?lang=cs");
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
        if (String(url).includes("/branch.json")) {
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
        if (String(url).includes("/box.json")) return Response.json([]);
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

  it("uses a usable stale snapshot for every concurrent caller when refresh fails", async () => {
    let currentTime = 0;
    let refreshFeedCalls = 0;
    const adapter = new PacketaDeliveryCapabilityAdapter(
      { accountId: "public-widget-key", widgetOptions: {} },
      (async (url) => {
        if (String(url).includes("/branch.json")) {
          if (currentTime > 0) {
            refreshFeedCalls += 1;
            throw new Error("provider unavailable");
          }
          return Response.json([packetaPickupPoint]);
        }
        if (String(url).includes("/box.json")) return Response.json([]);
        return Response.json({ isValid: true });
      }) as typeof fetch,
      () => currentTime,
    );

    await adapter.prepareSelection({
      providerEndpointId: "pickup-1",
      endpointType: "pickup_point",
    });
    currentTime = 60 * 60 * 1_000 + 1;

    await expect(
      Promise.all([
        adapter.prepareSelection({
          providerEndpointId: "pickup-1",
          endpointType: "pickup_point",
        }),
        adapter.prepareSelection({
          providerEndpointId: "pickup-1",
          endpointType: "pickup_point",
        }),
      ]),
    ).resolves.toHaveLength(2);
    expect(refreshFeedCalls).toBe(1);
  });

  it("bounds chunked provider responses while they are read", async () => {
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10 * 1_024 * 1_024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const adapter = new PacketaDeliveryCapabilityAdapter(
      { accountId: "public-widget-key", widgetOptions: {} },
      (async (url) => {
        if (String(url).includes("/branch.json"))
          return new Response(oversizedBody, {
            headers: { "Content-Type": "application/json" },
          });
        if (String(url).includes("/box.json")) return Response.json([]);
        return Response.json({ isValid: true });
      }) as typeof fetch,
    );

    await expect(
      adapter.prepareSelection({
        providerEndpointId: "pickup-1",
        endpointType: "pickup_point",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(cancelled).toBe(true);
  });

  it("reads committed snapshots across a selector-mode rollout", () => {
    const configuredAdapter = new ConfiguredDeliveryCapabilityAdapter();
    const packetaAdapter = new PacketaDeliveryCapabilityAdapter({
      accountId: "public-widget-key",
      widgetOptions: {},
    });
    const configuredSnapshot = {
      providerEndpointId: "configured-point",
      endpointType: "pickup_point",
      addressSnapshot: { country: "CZ", label: "Configured point" },
      capabilitySnapshot: {
        provider: "local-development",
        supportedCategoryIds: ["pickup", "oversize"],
      },
    };
    const packetaSnapshot = {
      providerEndpointId: "packeta-point",
      endpointType: "pickup_point",
      addressSnapshot: { country: "CZ", label: "Packeta point" },
      capabilitySnapshot: {
        provider: "packeta",
        version: 1,
        supportedCategoryIds: ["zbox"],
      },
    };

    expect(
      packetaAdapter.readCommittedCapability(configuredSnapshot),
    ).toMatchObject(configuredSnapshot);
    expect(
      configuredAdapter.readCommittedCapability(packetaSnapshot),
    ).toMatchObject(packetaSnapshot);
  });
});

const packetaPickupPoint = {
  id: "pickup-1",
  name: "Výdejní místo",
  street: "Náměstí 1",
  city: "Praha",
  zip: "110 00",
  country: "cz",
  displayFrontend: 1,
};
