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
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
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
        outboxMessage: { updateMany },
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
    const claim = vi
      .fn()
      .mockResolvedValueOnce([message(1)])
      .mockResolvedValueOnce([message(2)]);
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ claimed_at: new Date() }])
      .mockResolvedValueOnce([{ claimed_at: null }])
      .mockResolvedValueOnce([]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(
        async (work: (transaction: { $queryRaw: typeof claim }) => unknown) =>
          work({ $queryRaw: claim }),
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
      outboxMessage: { updateMany },
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
    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      status: "FAILED",
      lockedAt: null,
    });

    await expect(service.runOnce()).resolves.toBe(1);
    expect(refund).toHaveBeenCalledTimes(2);
    expect(refund.mock.calls[0]?.[0].idempotencyKey).toBe(
      "late_initial_capture:event-1",
    );
    expect(refund.mock.calls[1]?.[0].idempotencyKey).toBe(
      "late_initial_capture:event-1",
    );
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(updateMany.mock.calls[1]?.[0].data).toMatchObject({
      status: "DELIVERED",
      lockedAt: null,
      lastError: null,
    });
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
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
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
      outboxMessage: { updateMany },
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
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: expect.stringContaining("manual provider reconciliation"),
        }),
      }),
    );
  });
});
