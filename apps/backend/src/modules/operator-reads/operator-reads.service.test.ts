import { CapacityReservationStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { OperatorReadsService } from "./operator-reads.service";

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
