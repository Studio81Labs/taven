import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
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
    const now = new Date("2026-09-06T10:01:00.000Z");
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

  it("scopes timer idempotency records to the authenticated operator", async () => {
    const now = new Date("2026-09-06T10:01:00.000Z");
    const namespaces: string[] = [];
    const transaction = {
      $queryRaw: async () => [{ now }],
      idempotencyRecord: {
        findFirst: async (input: { where: { namespace: string } }) => {
          namespaces.push(input.where.namespace);
          return null;
        },
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
    const input = {
      component: "HANDLING_PACK",
      laborRateNumerator: "300",
      laborRateDenominator: "1",
      currency: "CZK",
    };

    await service.start(operator, input, "valid-key");
    await service.start(
      { ...operator, operatorId: "00000000-0000-4000-8000-000000000004" },
      input,
      "valid-key",
    );

    expect(namespaces).toEqual([
      "handling:start:00000000-0000-4000-8000-000000000001",
      "handling:start:00000000-0000-4000-8000-000000000004",
    ]);
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

  it("rejects numeric values outside their persistence ranges", () => {
    const service = new MeasurementService({} as never, {} as never);
    expect(() =>
      service.start(
        operator,
        {
          component: "HANDLING_PACK",
          laborRateNumerator: "9223372036854775808",
          laborRateDenominator: "1",
          currency: "CZK",
        },
        "valid-key",
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects non-string timestamps before date coercion", () => {
    const service = new MeasurementService({} as never, {} as never);
    expect(() =>
      service.recordActualCost(
        operator,
        "00000000-0000-4000-8000-000000000011",
        {
          category: "MATERIAL",
          amountMinor: "1",
          currency: "CZK",
          occurredAt: null as never,
          source: "MEASURED",
          sourceKey: "source-key",
          sourceEntityType: "measurement",
        },
        "valid-key",
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects non-string currency before persistence", () => {
    const service = new MeasurementService({} as never, {} as never);
    expect(() =>
      service.recordActualCost(
        operator,
        "00000000-0000-4000-8000-000000000011",
        {
          category: "MATERIAL",
          amountMinor: "1",
          currency: ["CZK"] as never,
          occurredAt: "2026-09-06T10:00:00.000Z",
          source: "MEASURED",
          sourceKey: "source-key",
          sourceEntityType: "measurement",
        },
        "valid-key",
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects non-object allocation entries before reading their fields", async () => {
    const service = new MeasurementService({} as never, {} as never);
    const admin = { ...operator, role: OperatorRole.ADMIN };
    await expect(
      service.recordManual(
        admin,
        {
          component: "HANDLING_PACK",
          laborRateNumerator: "1",
          laborRateDenominator: "1",
          currency: "CZK",
          startedAt: "2026-09-06T10:00:00.000Z",
          endedAt: "2026-09-06T10:00:01.000Z",
          durationMilliseconds: "1000",
          reason: "manual measurement",
          allocations: [null as never],
        },
        "valid-key",
      ),
    ).rejects.toThrow(BadRequestException);
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

  it("treats a changed manual rationale as an idempotency conflict", async () => {
    const now = new Date("2026-09-06T10:01:00.000Z");
    let record:
      | {
          expiresAt: Date;
          requestFingerprint: string;
          status: "COMPLETED";
          responseBody: { id: string; status: string };
          generation: number;
        }
      | undefined;
    const transaction = {
      $queryRaw: async () => [{ now }],
      idempotencyRecord: {
        findFirst: async () => record ?? null,
        create: async (input: { data: { requestFingerprint: string } }) => {
          record = {
            expiresAt: new Date("2026-10-06T10:00:00.000Z"),
            requestFingerprint: input.data.requestFingerprint,
            status: "COMPLETED",
            responseBody: { id: "session", status: "COMPLETED" },
            generation: 1,
          };
          return { id: "record" };
        },
        update: async () => undefined,
      },
      handlingSession: {
        findFirst: async () => null,
        create: async () => ({
          id: "00000000-0000-4000-8000-000000000010",
          component: "HANDLING_PACK",
          nodeId: operator.nodeIds[0],
          operatorIdentityId: operator.operatorId,
          startedAt: now,
          laborRateNumerator: 300n,
          laborRateDenominator: 1n,
          currency: "CZK",
        }),
        update: async () => ({
          id: "00000000-0000-4000-8000-000000000010",
          component: "HANDLING_PACK",
          nodeId: operator.nodeIds[0],
        }),
      },
      job: { findMany: async () => [{ nodeId: operator.nodeIds[0] }] },
      shipment: { findFirst: async () => ({ id: "shipment" }) },
      handlingAllocation: { createMany: async () => undefined },
      businessEvent: { create: async () => undefined },
    };
    const service = new MeasurementService(
      {
        $transaction: async (operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
      } as never,
      { recordOperator: async () => undefined } as never,
    );
    const admin = { ...operator, role: OperatorRole.ADMIN };
    const input = {
      component: "HANDLING_PACK",
      laborRateNumerator: "300",
      laborRateDenominator: "1",
      currency: "CZK",
      startedAt: "2026-09-06T10:00:00.000Z",
      endedAt: "2026-09-06T10:00:01.000Z",
      durationMilliseconds: "1000",
      reason: "first rationale",
      allocations: [
        {
          orderId: "00000000-0000-4000-8000-000000000011",
          shipmentId: "00000000-0000-4000-8000-000000000012",
          servedUnitCount: "1",
        },
      ],
    };

    await service.recordManual(admin, input, "valid-key");
    await expect(
      service.recordManual(
        admin,
        { ...input, reason: "changed rationale" },
        "valid-key",
      ),
    ).rejects.toThrow(ConflictException);
  });

  it("rejects irrelevant allocation targets for single-unit components", async () => {
    const service = new MeasurementService({} as never, {} as never);
    const assertAllocationLineage = (
      service as unknown as {
        assertAllocationLineage: (
          tx: unknown,
          nodeId: string,
          component: string,
          inputs: unknown[],
        ) => Promise<void>;
      }
    ).assertAllocationLineage.bind(service);
    const orderId = "00000000-0000-4000-8000-000000000011";

    await expect(
      assertAllocationLineage(
        {} as never,
        operator.nodeIds[0]!,
        "SHIPPING_TRIP",
        [
          {
            orderId,
            shipmentId: "00000000-0000-4000-8000-000000000012",
            jobId: "00000000-0000-4000-8000-000000000013",
            servedUnits: 1n,
          },
        ],
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      assertAllocationLineage(
        {} as never,
        operator.nodeIds[0]!,
        "POSTPROCESSING_ITEM",
        [
          {
            orderId,
            orderItemId: "00000000-0000-4000-8000-000000000014",
            shipmentId: "00000000-0000-4000-8000-000000000012",
            servedUnits: 1n,
          },
        ],
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
