import { describe, expect, it } from "vitest";
import { ConfiguredDeliveryCapabilityAdapter } from "./delivery-capability.port";

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

      await expect(adapter.list()).resolves.toEqual([
        {
          providerEndpointId: "configured-once",
          endpointType: "pickup_point",
          label: "Once",
          supportedCategoryIds: ["pickup"],
        },
      ]);
      const resolved = await adapter.resolve({
        providerEndpointId: "configured-once",
        endpointType: "pickup_point",
      });
      expect(Object.isFrozen(resolved.addressSnapshot)).toBe(true);
      await expect(
        adapter.resolve({
          providerEndpointId: "changed-without-restart",
          endpointType: "pickup_point",
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
