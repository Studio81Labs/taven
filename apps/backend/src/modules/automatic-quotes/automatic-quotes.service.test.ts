import { ConflictException, GoneException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../prisma/prisma.service";
import {
  AutomaticQuotesService,
  conservativePartsPerPlate,
  decimalToInteger,
  isCarrierValidationReady,
  parcelConfigurationChange,
  requiresShipmentHandoff,
} from "./automatic-quotes.service";

describe("AutomaticQuotesService", () => {
  it("converts API-valid volumes beyond JavaScript's safe integer range", () => {
    expect(decimalToInteger(9_261_000, 9, "volume")).toBe(
      9_261_000_000_000_000n,
    );
  });

  it("rejects positive values that cannot retain a whole target unit", () => {
    expect(() => decimalToInteger(0.0004, 3, "dimension")).toThrow(
      "Estimate dimension must remain positive",
    );
  });

  it("accepts the documented conversion-resolution minima", () => {
    expect(decimalToInteger(0.0005, 3, "dimension")).toBe(1n);
    expect(decimalToInteger(5e-10, 9, "volume")).toBe(1n);
  });

  it("uses one part per plate when local geometry cannot prove clearance", () => {
    expect(
      conservativePartsPerPlate(
        {
          boundsXMicrometers: 110_000n,
          boundsYMicrometers: 110_000n,
          boundsZMicrometers: 110_000n,
        },
        {
          buildVolumeXMicrometers: 220_000n,
          buildVolumeYMicrometers: 220_000n,
          buildVolumeZMicrometers: 220_000n,
        },
      ),
    ).toBe(1);
  });

  it("filters configured delivery options when pricing is unavailable", async () => {
    const priceList = { findUnique: vi.fn().mockResolvedValue(null) };
    const service = new AutomaticQuotesService(
      { priceList } as unknown as PrismaService,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    const deliveryOptions = service as unknown as {
      deliveryOptions: (
        input: undefined,
        client: { priceList: typeof priceList },
        configuredOptions: readonly unknown[],
      ) => Promise<unknown[]>;
    };

    await expect(
      deliveryOptions.deliveryOptions(undefined, { priceList }, [
        {
          endpointType: "pickup_point",
          providerEndpointId: "configured-pickup",
          supportedCategoryIds: ["pickup"],
        },
      ]),
    ).resolves.toEqual([]);
  });

  it("hands off empty configured delivery choices but keeps provider discovery available", () => {
    const base = {
      readyItems: true,
      checkoutReady: false,
      deliveryOptions: [],
      handoffReasons: [],
    };

    expect(
      requiresShipmentHandoff({
        ...base,
        deliverySelector: {
          mode: "CONFIGURED",
          available: true,
          allowedEndpointTypes: ["pickup_point"],
        },
      }),
    ).toBe(true);
    expect(
      requiresShipmentHandoff({
        ...base,
        deliverySelector: {
          mode: "PACKETA",
          available: true,
          allowedEndpointTypes: ["pickup_point"],
          widget: { accountId: "widget-key", options: {} },
        },
      }),
    ).toBe(false);
  });

  it("waits for reference slices before validating a Packeta selection", () => {
    const packetaSelector = {
      mode: "PACKETA" as const,
      available: true,
      allowedEndpointTypes: ["pickup_point"],
      widget: { accountId: "widget-key", options: {} },
    };

    expect(
      isCarrierValidationReady({
        deliverySelector: packetaSelector,
        allReferenceSliced: false,
      }),
    ).toBe(false);
    expect(
      isCarrierValidationReady({
        deliverySelector: packetaSelector,
        allReferenceSliced: true,
      }),
    ).toBe(true);
    expect(
      isCarrierValidationReady({
        deliverySelector: {
          mode: "CONFIGURED",
          available: true,
          allowedEndpointTypes: ["pickup_point"],
        },
        allReferenceSliced: false,
      }),
    ).toBe(true);
  });

  it("clears a Packeta destination after parcel configuration changes", async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      selectedDeliveryDestination: {
        capabilitySnapshot: { provider: "packeta", version: 1 },
      },
    });

    await expect(
      parcelConfigurationChange(
        {
          automaticQuoteDraft: { findUniqueOrThrow },
        } as never,
        "order-id",
      ),
    ).resolves.toEqual({
      configurationRevision: { increment: 1 },
      selectedDeliveryDestinationId: null,
    });
  });

  it.each(["P2002", "23505"])(
    "retries a handoff issuance uniqueness race (%s)",
    async (code) => {
      const transaction = vi
        .fn()
        .mockRejectedValueOnce({ code })
        .mockResolvedValueOnce("canonical response");
      const service = new AutomaticQuotesService(
        { $transaction: transaction } as unknown as PrismaService,
        null as never,
        null as never,
        null as never,
        null as never,
      );

      const handoffIssuance = service as unknown as {
        serializableHandoffIssuance: (
          operation: () => Promise<string>,
        ) => Promise<string>;
      };

      await expect(
        handoffIssuance.serializableHandoffIssuance(async () => "issued"),
      ).resolves.toBe("canonical response");
      expect(transaction).toHaveBeenCalledTimes(2);
    },
  );

  it("uses the locked transaction's database clock to reject expired observations", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const token = "a".repeat(43);
    const databaseNow = new Date("2026-09-07T12:00:00.000Z");
    const upsert = vi.fn();
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: sessionId }])
        .mockResolvedValueOnce([{ observed_at: databaseNow }]),
      quoteSession: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: sessionId,
          publicTokenHash: createHash("sha256").update(token).digest("hex"),
          status: "OPEN",
          expiresAt: new Date("2026-09-07T11:59:59.999Z"),
        }),
      },
      automaticOrderOrigin: { findUnique: vi.fn() },
      businessEvent: { upsert },
    };
    const prisma = {
      $transaction: (operation: (client: typeof transaction) => unknown) =>
        operation(transaction),
    };
    const service = new AutomaticQuotesService(
      prisma as unknown as PrismaService,
      null as never,
      null as never,
      null as never,
      null as never,
    );

    await expect(
      service.recordObservation(
        sessionId,
        { eventType: "quote.viewed" },
        `Bearer ${token}`,
      ),
    ).rejects.toBeInstanceOf(GoneException);

    expect(transaction.automaticOrderOrigin.findUnique).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("records a quote view against the current immutable price binding", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const orderId = "00000000-0000-4000-8000-000000000002";
    const bindingId = "00000000-0000-4000-8000-000000000003";
    const token = "a".repeat(43);
    const observedAt = new Date("2026-09-07T12:00:00.000Z");
    const upsert = vi.fn();
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: sessionId }])
        .mockResolvedValueOnce([{ observed_at: observedAt }]),
      quoteSession: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: sessionId,
          publicTokenHash: createHash("sha256").update(token).digest("hex"),
          status: "OPEN",
          expiresAt: new Date("2026-09-09T12:00:00.000Z"),
        }),
      },
      automaticOrderOrigin: {
        findUnique: vi.fn().mockResolvedValue({ orderId }),
      },
      orderActivePriceBinding: {
        findUnique: vi.fn().mockResolvedValue({
          orderPriceBindingId: bindingId,
          orderPriceBinding: { invalidatedAt: null },
        }),
      },
      businessEvent: { upsert },
    };
    const service = new AutomaticQuotesService(
      {
        $transaction: (operation: (client: typeof transaction) => unknown) =>
          operation(transaction),
      } as unknown as PrismaService,
      null as never,
      null as never,
      null as never,
      null as never,
    );

    await expect(
      service.recordObservation(
        sessionId,
        { eventType: "quote.viewed" },
        `Bearer ${token}`,
      ),
    ).resolves.toBeUndefined();

    expect(upsert.mock.calls[0]?.[0]?.create).toMatchObject({
      schemaVersion: 2,
      eventType: "quote.viewed",
      orderId,
      quoteSessionId: sessionId,
      payload: { orderPriceBindingId: bindingId },
    });
  });

  it("rejects a quote view when no current price binding exists", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const token = "a".repeat(43);
    const observedAt = new Date("2030-01-01T00:00:00.000Z");
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: sessionId }])
        .mockResolvedValueOnce([{ observed_at: observedAt }]),
      quoteSession: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: sessionId,
          publicTokenHash: createHash("sha256").update(token).digest("hex"),
          status: "OPEN",
          expiresAt: new Date("2030-01-01T00:00:01.000Z"),
        }),
      },
      automaticOrderOrigin: {
        findUnique: vi.fn().mockResolvedValue({
          orderId: "00000000-0000-4000-8000-000000000002",
        }),
      },
      orderActivePriceBinding: { findUnique: vi.fn().mockResolvedValue(null) },
      businessEvent: { upsert: vi.fn() },
    };
    const service = new AutomaticQuotesService(
      {
        $transaction: (operation: (client: typeof transaction) => unknown) =>
          operation(transaction),
      } as unknown as PrismaService,
      null as never,
      null as never,
      null as never,
      null as never,
    );

    await expect(
      service.recordObservation(
        sessionId,
        { eventType: "quote.viewed" },
        `Bearer ${token}`,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
