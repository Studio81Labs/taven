import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { OperatorRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { OperatorContext } from "../admin-access/operator-context";
import { MeasurementService } from "./measurement.service";

const operator: OperatorContext = {
  operatorId: "00000000-0000-4000-8000-000000000001",
  role: OperatorRole.OPERATOR,
  permissions: [],
  nodeIds: ["00000000-0000-4000-8000-000000000002"],
  authenticationMethod: "DEVELOPMENT_PASSWORD",
  sessionId: "00000000-0000-4000-8000-000000000003",
};

describe("MeasurementService command boundaries", () => {
  it("fingerprints parsed bigint timer evidence without throwing", async () => {
    const now = new Date("2026-09-06T10:00:00.000Z");
    const transaction = {
      $queryRaw: async () => [{ now }],
      idempotencyRecord: {
        findFirst: async () => null,
        create: async () => ({ id: "record" }),
        update: async () => undefined,
      },
      handlingSession: {
        create: async () => ({ id: "session", lifecycle: "OPEN" }),
      },
    };
    const service = new MeasurementService(
      {
        $transaction: async (operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
      } as never,
      { recordOperator: async () => undefined } as never,
    );

    await expect(
      service.start(
        operator,
        {
          component: "HANDLING_PACK",
          laborRateNumerator: "300",
          laborRateDenominator: "1",
          currency: "CZK",
        },
        "valid-key",
      ),
    ).resolves.toEqual({ id: "session", status: "OPEN" });
  });

  it("rejects malformed timer evidence before persistence", () => {
    const service = new MeasurementService({} as never, {} as never);
    expect(() =>
      service.start(
        operator,
        {
          component: "not-a-component",
          laborRateNumerator: "1",
          laborRateDenominator: "1",
          currency: "CZK",
        },
        "valid-key",
      ),
    ).toThrow(BadRequestException);
  });

  it("reserves manual measurements for administrators", async () => {
    const service = new MeasurementService({} as never, {} as never);
    await expect(
      service.recordManual(
        operator,
        {
          component: "HANDLING_PACK",
          laborRateNumerator: "1",
          laborRateDenominator: "1",
          currency: "CZK",
          startedAt: "2026-09-06T10:00:00.000Z",
          endedAt: "2026-09-06T10:00:01.000Z",
          durationMilliseconds: "1000",
          reason: "manual measurement",
          allocations: [],
        },
        "valid-key",
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
