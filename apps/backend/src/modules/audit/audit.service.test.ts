import { describe, expect, it, vi } from "vitest";
import { AuditService } from "./audit.service";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";

const nodeId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const quoteId = "66666666-6666-4666-8666-666666666666";
const refundTransactionId = "77777777-7777-4777-8777-777777777777";

const operator: OperatorContext = {
  operatorId: "44444444-4444-4444-8444-444444444444",
  role: "ADMIN",
  permissions: [OPERATOR_PERMISSIONS.AUDIT_READ],
  nodeIds: [nodeId],
  authenticationMethod: "DEVELOPMENT_PASSWORD",
  sessionId: "55555555-5555-4555-8555-555555555555",
};

describe("AuditService legacy projection", () => {
  it("shows a legacy order event only after its parent scope is proven", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: eventId,
        eventType: "legacy.quote_offer_expired",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        operatorIdentityId: null,
        nodeId: null,
        schemaVersion: 1,
        orderId,
        paymentId: null,
        refundTransactionId,
        quoteRequestId: null,
        quoteId,
        correlationId: null,
        reasonCode: null,
        reason: null,
        payload: { operation: "legacy" },
      },
    ]);
    const service = new AuditService({ auditEvent: { findMany } } as never);

    await expect(service.list(operator, {})).resolves.toEqual({
      items: [
        {
          id: eventId,
          eventType: "legacy.quote_offer_expired",
          createdAt: "2026-01-01T00:00:00.000Z",
          legacy: true,
          orderId,
          refundTransactionId,
          quoteId,
          payload: { operation: "legacy" },
        },
      ],
    });
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  OR: expect.arrayContaining([
                    expect.objectContaining({
                      AND: expect.arrayContaining([
                        { quoteId: { not: null } },
                        { orderId: null },
                      ]),
                    }),
                  ]),
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  it("projects safe attachment identifiers without exposing other payload data", async () => {
    const photoAssetId = "88888888-8888-4888-8888-888888888888";
    const findMany = vi.fn().mockResolvedValue([
      {
        id: eventId,
        eventType: "quote_request.attachment_download_issued",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        operatorIdentityId: operator.operatorId,
        nodeId,
        schemaVersion: 2,
        orderId: null,
        paymentId: null,
        refundTransactionId: null,
        quoteRequestId: orderId,
        quoteId: null,
        correlationId: null,
        reasonCode: null,
        reason: null,
        payload: {
          operation: "attachment_download",
          photoAssetId,
          storageObjectKey: "quote-photos/private-key",
        },
      },
    ]);
    const service = new AuditService({ auditEvent: { findMany } } as never);

    const page = await service.list(operator, {});

    expect(page.items[0]?.payload).toEqual({
      operation: "attachment_download",
      photoAssetId,
    });
  });

  it("rejects malformed operator reason pairs before writing an audit event", async () => {
    const create = vi.fn();
    const service = new AuditService({} as never);
    const transaction = { auditEvent: { create } } as never;

    await expect(
      service.recordOperator(transaction, operator, {
        eventType: "fulfilment.command_completed",
        nodeId,
        reasonCode: "FULFILMENT_COMMAND",
        reason: " ",
        payload: {},
      }),
    ).rejects.toThrow("Audit reason is invalid");
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves an explicit operator audit timestamp", async () => {
    const create = vi.fn().mockResolvedValue({});
    const service = new AuditService({} as never);
    const transaction = { auditEvent: { create } } as never;
    const createdAt = new Date("2026-01-01T00:00:01.000Z");

    await service.recordOperator(transaction, operator, {
      eventType: "quote_offer.expired",
      quoteRequestId: orderId,
      nodeId,
      createdAt,
      payload: { operation: "expire_offer", status: "EXPIRED" },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdAt }),
    });
  });
});
