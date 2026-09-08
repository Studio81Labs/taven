import { describe, expect, it, vi } from "vitest";
import { PaymentOutboxDispatcherService } from "./payment-outbox-dispatcher.service";

describe("PaymentOutboxDispatcherService", () => {
  it("voids a returned intent stored durably in the command payload", async () => {
    const message = {
      id: "00000000-0000-4000-8000-000000000001",
      attempts: 1,
      message_type: "void_payment" as const,
      aggregate_id: "00000000-0000-4000-8000-000000000002",
      payload: {
        paymentId: "00000000-0000-4000-8000-000000000002",
        provider: "comgate",
        providerIntentId: "returned-intent-1",
        action: "void_payment",
      },
    };
    const claim = vi.fn().mockResolvedValue([message]);
    const executeRaw = vi.fn().mockResolvedValue(1);
    const cancelIntent = vi.fn().mockResolvedValue(undefined);
    const service = new PaymentOutboxDispatcherService(
      {
        $transaction: vi.fn(
          async (work: (transaction: { $queryRaw: typeof claim }) => unknown) =>
            work({ $queryRaw: claim }),
        ),
        payment: {
          findUnique: vi.fn().mockResolvedValue({
            id: message.aggregate_id,
            status: "VOIDED",
            provider: "comgate",
            providerIntentId: null,
          }),
        },
        $executeRaw: executeRaw,
      } as never,
      {
        providerName: () => "comgate",
        capabilities: async () => ({ provider: "comgate", methods: ["CARD"] }),
        refundRetrySafety: () => "MANUAL_RECONCILIATION",
        createIntent: vi.fn(),
        locateEvent: vi.fn(),
        verifyEvent: vi.fn(),
        cancelIntent,
        refund: vi.fn(),
      },
    );

    await expect(service.runOnce()).resolves.toBe(1);
    expect(cancelIntent).toHaveBeenCalledWith("returned-intent-1");
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(sqlText(executeRaw.mock.calls[0])).toContain(
      "delivered_at = clock_timestamp()",
    );
  });

  it("retries the same claimed refund after a provider outage", async () => {
    const message = (attempts: number) => ({
      id: "00000000-0000-4000-8000-000000000010",
      attempts,
      message_type: "refund_payment" as const,
      aggregate_id: "00000000-0000-4000-8000-000000000011",
      payload: {
        refundTransactionId: "00000000-0000-4000-8000-000000000011",
        paymentId: "00000000-0000-4000-8000-000000000012",
        provider: "sandbox",
        providerIntentId: "sandbox-payment-1",
        amountMinor: "12300",
        currency: "CZK",
        idempotencyKey: "late_initial_capture:event-1",
        action: "refund_payment",
      },
    });
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ claimed_at: new Date() }])
      .mockResolvedValueOnce([{ claimed_at: null }]);
    const executeRaw = vi.fn().mockResolvedValue(1);
    const transactionQuery = vi
      .fn()
      .mockResolvedValueOnce([message(1)])
      .mockResolvedValueOnce([message(2)])
      .mockResolvedValueOnce([{ applied: true }]);
    const eventUpsert = vi.fn();
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000011",
      paymentId: "00000000-0000-4000-8000-000000000012",
      providerRefundId: "sandbox-refund-1",
      completedAt: new Date("2026-09-04T12:00:00Z"),
      payment: { orderId: "00000000-0000-4000-8000-000000000013" },
    });
    const prisma = {
      $transaction: vi.fn(
        async (work: (transaction: Record<string, unknown>) => unknown) =>
          work({
            $queryRaw: transactionQuery,
            refundTransaction: { findUniqueOrThrow },
            businessEvent: { upsert: eventUpsert },
          }),
      ),
      $queryRaw: queryRaw,
      refundTransaction: {
        findUnique: vi.fn().mockResolvedValue({
          id: "00000000-0000-4000-8000-000000000011",
          paymentId: "00000000-0000-4000-8000-000000000012",
          status: "PENDING",
          amountMinor: 12_300n,
          idempotencyKey: "late_initial_capture:event-1",
          payment: {
            provider: "sandbox",
            providerIntentId: "sandbox-payment-1",
            currency: "CZK",
          },
        }),
      },
      $executeRaw: executeRaw,
    };
    const refund = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({
        providerRefundId: "sandbox-refund-1",
        occurredAt: new Date("2026-09-04T12:00:00Z"),
        evidence: { source: "sandbox" },
      });
    const service = new PaymentOutboxDispatcherService(prisma as never, {
      providerName: () => "sandbox",
      capabilities: async () => ({ provider: "sandbox", methods: ["CARD"] }),
      refundRetrySafety: () => "IDEMPOTENT",
      createIntent: vi.fn(),
      locateEvent: vi.fn(),
      verifyEvent: vi.fn(),
      cancelIntent: vi.fn(),
      refund,
    });

    await expect(service.runOnce()).resolves.toBe(0);
    expect(sqlText(executeRaw.mock.calls[0])).toContain(
      "available_at = clock_timestamp()",
    );
    expect(sqlText(executeRaw.mock.calls[0])).toContain("make_interval");
    expect(sqlText(transactionQuery.mock.calls[0])).toContain(
      "locked_at < clock_timestamp()",
    );

    await expect(service.runOnce()).resolves.toBe(1);
    expect(refund).toHaveBeenCalledTimes(2);
    expect(refund.mock.calls[0]?.[0].idempotencyKey).toBe(
      "late_initial_capture:event-1",
    );
    expect(refund.mock.calls[1]?.[0].idempotencyKey).toBe(
      "late_initial_capture:event-1",
    );
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(eventUpsert).toHaveBeenCalledTimes(1);
    expect(sqlText(executeRaw.mock.calls[1])).toContain(
      "delivered_at = clock_timestamp()",
    );
  });

  it("does not replay an ambiguous non-idempotent refund", async () => {
    const message = {
      id: "00000000-0000-4000-8000-000000000020",
      attempts: 2,
      message_type: "refund_payment" as const,
      aggregate_id: "00000000-0000-4000-8000-000000000021",
      payload: {
        refundTransactionId: "00000000-0000-4000-8000-000000000021",
        paymentId: "00000000-0000-4000-8000-000000000022",
        provider: "comgate",
        providerIntentId: "comgate-payment-1",
        amountMinor: "12300",
        currency: "CZK",
        idempotencyKey: "late_initial_capture:event-2",
        action: "refund_payment",
      },
    };
    const claim = vi.fn().mockResolvedValue([message]);
    const executeRaw = vi.fn().mockResolvedValue(1);
    const prisma = {
      $transaction: vi.fn(
        async (work: (transaction: { $queryRaw: typeof claim }) => unknown) =>
          work({ $queryRaw: claim }),
      ),
      $queryRaw: vi.fn().mockResolvedValue([{ claimed_at: null }]),
      refundTransaction: {
        findUnique: vi.fn().mockResolvedValue({
          id: message.aggregate_id,
          paymentId: "00000000-0000-4000-8000-000000000022",
          status: "PENDING",
          amountMinor: 12_300n,
          idempotencyKey: "late_initial_capture:event-2",
          payment: {
            provider: "comgate",
            providerIntentId: "comgate-payment-1",
            currency: "CZK",
          },
        }),
      },
      $executeRaw: executeRaw,
    };
    const refund = vi.fn();
    const service = new PaymentOutboxDispatcherService(prisma as never, {
      providerName: () => "comgate",
      capabilities: async () => ({ provider: "comgate", methods: ["CARD"] }),
      refundRetrySafety: () => "MANUAL_RECONCILIATION",
      createIntent: vi.fn(),
      locateEvent: vi.fn(),
      verifyEvent: vi.fn(),
      cancelIntent: vi.fn(),
      refund,
    });

    await expect(service.runOnce()).resolves.toBe(0);
    expect(refund).not.toHaveBeenCalled();
    expect(executeRaw.mock.calls[0]?.[2]).toContain(
      "manual provider reconciliation",
    );
  });

  it("retries persisting a confirmed non-idempotent refund result", async () => {
    const message = {
      id: "00000000-0000-4000-8000-000000000030",
      attempts: 1,
      message_type: "refund_payment" as const,
      aggregate_id: "00000000-0000-4000-8000-000000000031",
      payload: {
        refundTransactionId: "00000000-0000-4000-8000-000000000031",
        paymentId: "00000000-0000-4000-8000-000000000032",
        provider: "comgate",
        providerIntentId: "comgate-payment-2",
        amountMinor: "12300",
        currency: "CZK",
        idempotencyKey: "late_initial_capture:event-3",
        action: "refund_payment",
      },
    };
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ claimed_at: new Date() }]);
    const executeRaw = vi.fn().mockResolvedValue(1);
    const transactionQuery = vi
      .fn()
      .mockResolvedValueOnce([message])
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce([{ applied: true }]);
    const eventUpsert = vi.fn();
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: message.aggregate_id,
      paymentId: "00000000-0000-4000-8000-000000000032",
      providerRefundId: "comgate-refund-1",
      completedAt: new Date("2026-09-04T12:00:00Z"),
      payment: { orderId: "00000000-0000-4000-8000-000000000033" },
    });
    const prisma = {
      $transaction: vi.fn(
        async (work: (transaction: Record<string, unknown>) => unknown) =>
          work({
            $queryRaw: transactionQuery,
            refundTransaction: { findUniqueOrThrow },
            businessEvent: { upsert: eventUpsert },
          }),
      ),
      $queryRaw: queryRaw,
      refundTransaction: {
        findUnique: vi.fn().mockResolvedValue({
          id: message.aggregate_id,
          paymentId: "00000000-0000-4000-8000-000000000032",
          status: "PENDING",
          amountMinor: 12_300n,
          idempotencyKey: "late_initial_capture:event-3",
          payment: {
            provider: "comgate",
            providerIntentId: "comgate-payment-2",
            currency: "CZK",
          },
        }),
      },
      $executeRaw: executeRaw,
    };
    const refund = vi.fn().mockResolvedValue({
      providerRefundId: "comgate-refund-1",
      occurredAt: null,
      evidence: { source: "comgate" },
    });
    const service = new PaymentOutboxDispatcherService(prisma as never, {
      providerName: () => "comgate",
      capabilities: async () => ({ provider: "comgate", methods: ["CARD"] }),
      refundRetrySafety: () => "MANUAL_RECONCILIATION",
      createIntent: vi.fn(),
      locateEvent: vi.fn(),
      verifyEvent: vi.fn(),
      cancelIntent: vi.fn(),
      refund,
    });

    await expect(service.runOnce()).resolves.toBe(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(eventUpsert).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(sqlText(executeRaw.mock.calls[0])).toContain(
      "delivered_at = clock_timestamp()",
    );
  });
});

function sqlText(call: unknown[] | undefined): string {
  const strings = call?.[0];
  return Array.isArray(strings) ? strings.join(" ") : "";
}
