import type { Prisma } from "@prisma/client";

type Transaction = Prisma.TransactionClient;

type EventBase = Readonly<{
  observedAt: Date;
}>;

export type BusinessEventInput =
  | (EventBase &
      Readonly<{
        eventType: "upload.confirmed";
        modelFileId: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "quote.viewed";
        quoteSessionId: string;
        orderId: string;
        orderPriceBindingId: string;
        expiresAt: Date;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "checkout.started";
        quoteSessionId: string;
        orderId: string;
        expiresAt: Date;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "quote.bound";
        bindingId: string;
        orderId?: string;
        quoteId?: string;
        quoteSessionId?: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "quote-request.created";
        quoteRequestId: string;
        quoteSessionId: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "order.confirmed" | "order.completed";
        orderId: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "payment.captured";
        paymentId: string;
        orderId: string;
        providerTransactionId: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "refund.succeeded";
        refundTransactionId: string;
        paymentId: string;
        orderId: string;
        providerRefundId: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "job.qc-approved" | "job.failed";
        jobId: string;
        orderId: string;
        nodeId: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "shipment.handed-off" | "shipment.delivered";
        shipmentId: string;
        orderId: string;
        nodeId: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "handling.completed";
        handlingSessionId: string;
        nodeId: string;
        component: string;
      }>)
  | (EventBase &
      Readonly<{
        eventType: "actual-cost.recorded";
        actualCostId: string;
        orderId: string;
        nodeId: string;
        category: string;
      }>);

/**
 * Writes only committed, schema-versioned metric facts. Callers must invoke it
 * with the same transaction that persists the source-of-truth state change.
 */
export async function writeBusinessEvent(
  transaction: Transaction,
  event: BusinessEventInput,
): Promise<void> {
  const record = eventRecord(event);
  await transaction.businessEvent.upsert({
    where: {
      eventType_dedupeKey: {
        eventType: record.eventType,
        dedupeKey: record.dedupeKey,
      },
    },
    create: record,
    update: {},
  });
}

function eventRecord(
  event: BusinessEventInput,
): Prisma.BusinessEventUncheckedCreateInput {
  switch (event.eventType) {
    case "upload.confirmed":
      return serverRecord(event, event.modelFileId, {
        payload: {
          modelFileId: requiredUuid(event.modelFileId, "modelFileId"),
        },
      });
    case "quote.viewed":
      return clientRecord(event, `${event.quoteSessionId}:quote.viewed`, 2, {
        quoteSessionId: requiredUuid(event.quoteSessionId, "quoteSessionId"),
        orderId: requiredUuid(event.orderId, "orderId"),
        expiresAt: event.expiresAt,
      });
    case "checkout.started":
      return clientRecord(
        event,
        `${event.quoteSessionId}:checkout.started`,
        1,
        {
          quoteSessionId: requiredUuid(event.quoteSessionId, "quoteSessionId"),
          orderId: requiredUuid(event.orderId, "orderId"),
          expiresAt: event.expiresAt,
        },
      );
    case "quote.bound": {
      const bindingId = requiredUuid(event.bindingId, "bindingId");
      const orderId = optionalUuid(event.orderId, "orderId");
      const quoteId = optionalUuid(event.quoteId, "quoteId");
      const quoteSessionId = optionalUuid(
        event.quoteSessionId,
        "quoteSessionId",
      );
      if ((orderId ? 1 : 0) + (quoteId ? 1 : 0) !== 1) {
        throw new Error(
          "quote.bound requires exactly one bound quote or order",
        );
      }
      return serverRecord(event, bindingId, {
        ...(orderId ? { orderId } : {}),
        ...(quoteSessionId ? { quoteSessionId } : {}),
        payload: {
          bindingId,
          bindingKind: orderId ? "ORDER" : "QUOTE",
          ...(quoteId ? { quoteId } : {}),
        },
      });
    }
    case "quote-request.created":
      return serverRecord(event, event.quoteRequestId, {
        quoteSessionId: requiredUuid(event.quoteSessionId, "quoteSessionId"),
        payload: {
          quoteRequestId: requiredUuid(event.quoteRequestId, "quoteRequestId"),
        },
      });
    case "order.confirmed":
    case "order.completed":
      return serverRecord(event, event.orderId, {
        orderId: requiredUuid(event.orderId, "orderId"),
      });
    case "payment.captured": {
      const providerTransactionId = requiredProviderIdentifier(
        event.providerTransactionId,
        "providerTransactionId",
      );
      return serverRecord(event, event.paymentId, {
        orderId: requiredUuid(event.orderId, "orderId"),
        payload: {
          paymentId: requiredUuid(event.paymentId, "paymentId"),
          providerTransactionId,
        },
      });
    }
    case "refund.succeeded": {
      const providerRefundId = requiredProviderIdentifier(
        event.providerRefundId,
        "providerRefundId",
      );
      return serverRecord(event, event.refundTransactionId, {
        orderId: requiredUuid(event.orderId, "orderId"),
        payload: {
          refundTransactionId: requiredUuid(
            event.refundTransactionId,
            "refundTransactionId",
          ),
          paymentId: requiredUuid(event.paymentId, "paymentId"),
          providerRefundId,
        },
      });
    }
    case "job.qc-approved":
    case "job.failed":
      return serverRecord(event, event.jobId, {
        orderId: requiredUuid(event.orderId, "orderId"),
        jobId: requiredUuid(event.jobId, "jobId"),
        nodeId: requiredUuid(event.nodeId, "nodeId"),
      });
    case "shipment.handed-off":
    case "shipment.delivered":
      return serverRecord(event, event.shipmentId, {
        orderId: requiredUuid(event.orderId, "orderId"),
        nodeId: requiredUuid(event.nodeId, "nodeId"),
        payload: {
          shipmentId: requiredUuid(event.shipmentId, "shipmentId"),
        },
      });
    case "handling.completed":
      return serverRecord(event, event.handlingSessionId, {
        nodeId: requiredUuid(event.nodeId, "nodeId"),
        payload: {
          handlingSessionId: requiredUuid(
            event.handlingSessionId,
            "handlingSessionId",
          ),
          component: requiredIdentifier(event.component, "component", 100),
        },
      });
    case "actual-cost.recorded":
      return serverRecord(event, event.actualCostId, {
        orderId: requiredUuid(event.orderId, "orderId"),
        nodeId: requiredUuid(event.nodeId, "nodeId"),
        payload: {
          actualCostId: requiredUuid(event.actualCostId, "actualCostId"),
          category: requiredIdentifier(event.category, "category", 100),
        },
      });
  }
}

function serverRecord(
  event: Extract<BusinessEventInput, { eventType: string }>,
  dedupeKey: string,
  fields: Omit<
    Prisma.BusinessEventUncheckedCreateInput,
    "eventType" | "dedupeKey" | "observedAt" | "source" | "payload"
  > &
    Partial<Pick<Prisma.BusinessEventUncheckedCreateInput, "payload">>,
): Prisma.BusinessEventUncheckedCreateInput {
  return {
    schemaVersion: 1,
    eventType: event.eventType,
    dedupeKey,
    observedAt: event.observedAt,
    source: "SERVER",
    payload: fields.payload ?? {},
    ...fields,
  };
}

function clientRecord(
  event: Extract<
    BusinessEventInput,
    { eventType: "quote.viewed" | "checkout.started" }
  >,
  dedupeKey: string,
  schemaVersion: number,
  fields: Pick<
    Prisma.BusinessEventUncheckedCreateInput,
    "quoteSessionId" | "orderId" | "expiresAt"
  >,
): Prisma.BusinessEventUncheckedCreateInput {
  const payload =
    event.eventType === "quote.viewed"
      ? {
          orderPriceBindingId: requiredUuid(
            event.orderPriceBindingId,
            "orderPriceBindingId",
          ),
        }
      : {};
  return {
    schemaVersion,
    eventType: event.eventType,
    dedupeKey,
    observedAt: event.observedAt,
    source: "CLIENT",
    payload,
    ...fields,
  };
}

function requiredUuid(value: string, name: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function optionalUuid(
  value: string | undefined,
  name: string,
): string | undefined {
  return value === undefined ? undefined : requiredUuid(value, name);
}

function requiredProviderIdentifier(value: string, name: string): string {
  return requiredIdentifier(value, name, 255);
}

function requiredIdentifier(
  value: string,
  name: string,
  maximumLength: number,
): string {
  if (!value || value.length > maximumLength) {
    throw new Error(`${name} must be 1 through ${maximumLength} characters`);
  }
  return value;
}
