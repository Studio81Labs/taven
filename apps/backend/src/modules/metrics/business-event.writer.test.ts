import { describe, expect, it, vi } from "vitest";
import { writeBusinessEvent } from "./business-event.writer";

const ids = {
  session: "00000000-0000-4000-8000-000000000001",
  order: "00000000-0000-4000-8000-000000000002",
  binding: "00000000-0000-4000-8000-000000000003",
  payment: "00000000-0000-4000-8000-000000000004",
};

describe("writeBusinessEvent", () => {
  it("records a binding-attributed quote view as schema version 2", async () => {
    const upsert = vi.fn();
    const observedAt = new Date("2026-09-08T12:00:00.000Z");
    const expiresAt = new Date("2026-12-07T12:00:00.000Z");

    await writeBusinessEvent({ businessEvent: { upsert } } as never, {
      eventType: "quote.viewed",
      quoteSessionId: ids.session,
      orderId: ids.order,
      orderPriceBindingId: ids.binding,
      observedAt,
      expiresAt,
    });

    expect(upsert).toHaveBeenCalledWith({
      where: {
        eventType_dedupeKey: {
          eventType: "quote.viewed",
          dedupeKey: `${ids.session}:quote.viewed`,
        },
      },
      create: {
        schemaVersion: 2,
        eventType: "quote.viewed",
        dedupeKey: `${ids.session}:quote.viewed`,
        observedAt,
        source: "CLIENT",
        quoteSessionId: ids.session,
        orderId: ids.order,
        expiresAt,
        payload: { orderPriceBindingId: ids.binding },
      },
      update: {},
    });
  });

  it("keeps checkout observations on their compatible version 1 shape", async () => {
    const upsert = vi.fn();
    const observedAt = new Date("2026-09-08T12:00:00.000Z");
    const expiresAt = new Date("2026-12-07T12:00:00.000Z");

    await writeBusinessEvent({ businessEvent: { upsert } } as never, {
      eventType: "checkout.started",
      quoteSessionId: ids.session,
      orderId: ids.order,
      observedAt,
      expiresAt,
    });

    expect(upsert.mock.calls[0]?.[0]?.create).toMatchObject({
      schemaVersion: 1,
      eventType: "checkout.started",
      source: "CLIENT",
      payload: {},
    });
  });

  it("allows only the allowlisted capture identity in payment payloads", async () => {
    const upsert = vi.fn();

    await writeBusinessEvent({ businessEvent: { upsert } } as never, {
      eventType: "payment.captured",
      paymentId: ids.payment,
      orderId: ids.order,
      providerTransactionId: "provider-capture-1",
      observedAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    expect(upsert.mock.calls[0]?.[0]?.create).toMatchObject({
      eventType: "payment.captured",
      dedupeKey: ids.payment,
      source: "SERVER",
      orderId: ids.order,
      payload: {
        paymentId: ids.payment,
        providerTransactionId: "provider-capture-1",
      },
    });
  });

  it("rejects a quote binding without exactly one immutable subject", async () => {
    await expect(
      writeBusinessEvent({ businessEvent: { upsert: vi.fn() } } as never, {
        eventType: "quote.bound",
        bindingId: ids.binding,
        orderId: ids.order,
        quoteId: ids.payment,
        observedAt: new Date("2026-09-08T12:00:00.000Z"),
      }),
    ).rejects.toThrow("quote.bound requires exactly one bound quote or order");
  });
});
