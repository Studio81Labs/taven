import {
  CapacityReservationStatus,
  Material,
  PrintQuality,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { OperatorReadsService, orderBarriers } from "./operator-reads.service";

const nodeId = "11111111-1111-4111-8111-111111111111";
const cursorId = "22222222-2222-4222-8222-222222222222";
const secondReservationId = "33333333-3333-4333-8333-333333333333";
const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-02T00:00:00.000Z";
const cursorStartsAt = "2026-01-01T08:00:00.000Z";
const secondStartsAt = new Date("2026-01-01T09:00:00.000Z");

describe("OperatorReadsService capacity reservations", () => {
  it("uses ordering values after a capacity cursor row leaves the filtered status", async () => {
    const filterHash = createHash("sha256")
      .update(
        JSON.stringify({
          nodeId,
          machineId: undefined,
          status: "HELD",
          from,
          to,
          kind: "capacity-reservations",
        }),
      )
      .digest("hex");
    const cursor = Buffer.from(
      JSON.stringify({ id: cursorId, startsAt: cursorStartsAt, filterHash }),
      "utf8",
    ).toString("base64url");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: secondReservationId,
        machineId: "44444444-4444-4444-8444-444444444444",
        status: CapacityReservationStatus.HELD,
        startsAt: secondStartsAt,
        endsAt: new Date("2026-01-01T10:00:00.000Z"),
        expiresAt: new Date("2026-01-01T11:00:00.000Z"),
      },
    ]);
    const service = new OperatorReadsService(
      { capacityReservation: { findMany } } as never,
      {} as never,
    );

    await expect(
      service.capacityReservations(
        {
          operatorId: "55555555-5555-4555-8555-555555555555",
          role: "VIEWER",
          permissions: [OPERATOR_PERMISSIONS.OPERATIONS_READ],
          nodeIds: [nodeId],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
          sessionId: "66666666-6666-4666-8666-666666666666",
        },
        nodeId,
        { from, to, status: "HELD", cursor, limit: 1 },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: secondReservationId,
          machineId: "44444444-4444-4444-8444-444444444444",
          status: "HELD",
          startsAt: secondStartsAt.toISOString(),
          endsAt: "2026-01-01T10:00:00.000Z",
          expiresAt: "2026-01-01T11:00:00.000Z",
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        nodeId,
        status: CapacityReservationStatus.HELD,
        startsAt: { lt: new Date(to) },
        endsAt: { gt: new Date(from) },
        OR: [
          { startsAt: { gt: new Date(cursorStartsAt) } },
          { startsAt: new Date(cursorStartsAt), id: { gt: cursorId } },
        ],
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 2,
    });
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty("cursor");
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty("skip");
  });
});

describe("OperatorReadsService reference-profile activation notices", () => {
  it("uses the committed activation tuple for a version-bound keyset page", async () => {
    const activatedAt = "2026-01-02T03:04:05.678Z";
    const filterHash = createHash("sha256")
      .update(
        JSON.stringify({
          kind: "reference-profile-activation-notices",
          version: 1,
        }),
      )
      .digest("hex");
    const cursor = Buffer.from(
      JSON.stringify({ id: cursorId, activatedAt, filterHash }),
      "utf8",
    ).toString("base64url");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: secondReservationId,
        material: Material.PLA,
        quality: PrintQuality.FINE,
        activatedAt: new Date("2026-01-01T03:04:05.678Z"),
      },
    ]);
    const service = new OperatorReadsService(
      { referenceProfile: { findMany } } as never,
      {} as never,
    );
    const operator = {
      operatorId: "55555555-5555-4555-8555-555555555555",
      role: "VIEWER" as const,
      permissions: [OPERATOR_PERMISSIONS.OPERATIONS_READ],
      nodeIds: [nodeId],
      authenticationMethod: "DEVELOPMENT_PASSWORD" as const,
      sessionId: "66666666-6666-4666-8666-666666666666",
    };

    await expect(
      service.referenceProfileActivationNotices(operator, { cursor, limit: 1 }),
    ).resolves.toEqual({
      items: [
        {
          id: `reference-profile-activated:${secondReservationId}`,
          schemaVersion: 1,
          kind: "REFERENCE_PROFILE_ACTIVATED",
          referenceProfileId: secondReservationId,
          material: "PLA",
          quality: "FINE",
          activatedAt: "2026-01-01T03:04:05.678Z",
          action: "REVIEW_PRICE_LIST",
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        activatedAt: { not: null },
        OR: [
          { activatedAt: { lt: new Date(activatedAt) } },
          { activatedAt: new Date(activatedAt), id: { lt: cursorId } },
        ],
      },
      select: {
        id: true,
        material: true,
        quality: true,
        activatedAt: true,
      },
      orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
      take: 2,
    });
  });
});

describe("OperatorReadsService claim child history", () => {
  it("pages a scoped claim and omits internal refund dispatch fields", async () => {
    const orderId = "77777777-7777-4777-8777-777777777777";
    const claimId = "88888888-8888-4888-8888-888888888888";
    const now = new Date("2026-01-02T03:04:05.678Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: cursorId,
        paymentId: "99999999-9999-4999-8999-999999999999",
        claimId,
        priceAdjustmentId: null,
        provider: "SANDBOX",
        providerRefundId: null,
        amountMinor: 100n,
        reason: "CUSTOMER_CANCELLATION",
        status: "FAILED",
        requestedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        idempotencyKey: "internal-command-key",
      },
      { id: secondReservationId },
    ]);
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ node_id: nodeId }]),
      claim: { findFirst: vi.fn().mockResolvedValue({ id: claimId }) },
      refundTransaction: { findMany },
    };
    const service = new OperatorReadsService(
      {
        $transaction: (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      } as never,
      {} as never,
    );
    const operator = {
      operatorId: "55555555-5555-4555-8555-555555555555",
      role: "VIEWER" as const,
      permissions: [OPERATOR_PERMISSIONS.OPERATIONS_READ],
      nodeIds: [nodeId],
      authenticationMethod: "DEVELOPMENT_PASSWORD" as const,
      sessionId: "66666666-6666-4666-8666-666666666666",
    };

    await expect(
      service.claimChildHistory(operator, orderId, claimId, "refunds", {
        limit: 1,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: cursorId,
          paymentId: "99999999-9999-4999-8999-999999999999",
          claimId,
          priceAdjustmentId: null,
          provider: "SANDBOX",
          providerRefundId: null,
          amountMinor: "100",
          reason: "CUSTOMER_CANCELLATION",
          status: "FAILED",
          requestedAt: now.toISOString(),
          completedAt: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      nextCursor: cursorId,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { claimId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    });
  });
});

describe("operator order barriers", () => {
  const orderId = "77777777-7777-4777-8777-777777777777";
  const originalId = "88888888-8888-4888-8888-888888888888";
  const replacementId = "99999999-9999-4999-8999-999999999999";

  it("clears a failed source refund only after its replacement succeeds", () => {
    const fulfilment = {
      shipments: [],
      replacementRequests: [],
      claims: [],
      priceAdjustments: [],
    };
    const root = {
      id: originalId,
      replacesRefundTransactionId: null,
      status: "FAILED",
      amountMinor: 100n,
      priceAdjustmentId: null,
    };
    const child = {
      ...root,
      id: replacementId,
      replacesRefundTransactionId: originalId,
      status: "SUCCEEDED",
    };
    const payment = {
      role: "FULL",
      status: "REFUNDED",
      refunds: [root, child],
    };
    expect(orderBarriers(fulfilment as never, [payment], [], 0n)).not.toContain(
      "REFUND_UNRESOLVED",
    );
    expect(
      orderBarriers(
        fulfilment as never,
        [{ ...payment, refunds: [root, { ...child, status: "PENDING" }] }],
        [],
        0n,
      ),
    ).toContain("REFUND_UNRESOLVED");
  });

  it("uses the current shipment leaf after a lost shipment is replaced", () => {
    const fulfilment = {
      orderId,
      shipments: [
        { id: originalId, replacesShipmentId: null, status: "LOST" },
        {
          id: replacementId,
          replacesShipmentId: originalId,
          status: "DELIVERED",
        },
      ],
      replacementRequests: [],
      claims: [],
      priceAdjustments: [],
    };
    expect(orderBarriers(fulfilment as never, [], [], 0n)).not.toContain(
      "SHIPMENT_UNRESOLVED",
    );
    fulfilment.shipments[1]!.status = "IN_TRANSIT";
    expect(orderBarriers(fulfilment as never, [], [], 0n)).toContain(
      "SHIPMENT_UNRESOLVED",
    );
  });
});
