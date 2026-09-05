import { afterEach, describe, expect, it, vi } from "vitest";
import { ComgatePaymentProviderAdapter } from "./comgate-payment-provider.adapter";
import { PaymentIntentCreationError } from "./payment-provider.port";

const adapter = new ComgatePaymentProviderAdapter({
  provider: "comgate",
  merchantId: "merchant",
  secret: "secret",
  testMode: true,
  apiBaseUrl: "https://payments.comgate.cz/v2.0",
});

describe("ComgatePaymentProviderAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("discovers and caches the merchant's enabled CZK checkout methods", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: "OK",
          methods: [
            { id: "CARD_CZ_CSOB_2", group: "CARD" },
            { id: "BANK_CZ_RB", group: "BANK" },
            { id: "LATER_CZ_TWISTO", group: "LATER" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(adapter.capabilities()).resolves.toEqual({
      provider: "comgate",
      methods: ["CARD", "BANK_TRANSFER"],
    });
    await adapter.capabilities();

    expect(adapter.providerName()).toBe("comgate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://payments.comgate.cz/v2.0/method.json?lang=cs&curr=CZK&country=CZ",
    );
  });

  it("maps the neutral card method and preserves Comgate's redirect URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: "OK",
          transId: "ABCD-EFGH-IJKL",
          redirect:
            "https://payments.comgate.cz/client/instructions/index?id=opaque",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await adapter.createIntent({
      paymentId: "00000000-0000-4000-8000-000000000001",
      merchantReference: "00000000-0000-4000-8000-000000000001",
      orderReference: "TAV-1",
      amountMinor: 12_300n,
      currency: "CZK",
      method: "CARD",
      email: "customer@example.test",
      fullName: "Customer",
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      returnUrls: {
        success: "https://taven.cz/success",
        cancelled: "https://taven.cz/cancelled",
        pending: "https://taven.cz/pending",
      },
    });
    expect(result).toEqual({
      providerIntentId: "ABCD-EFGH-IJKL",
      checkoutUrl:
        "https://payments.comgate.cz/client/instructions/index?id=opaque",
    });
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://payments.comgate.cz/v2.0/payment.json");
    const body = JSON.parse(String(request?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      price: 12300,
      curr: "CZK",
      refId: "00000000-0000-4000-8000-000000000001",
      method: "CARD_ALL",
      email: "customer@example.test",
      expirationTime: "60m",
      dynamicExpiration: true,
      label: "TAVEN order",
    });
    expect(body).not.toHaveProperty("phone");
  });

  it("treats callback data only as a locator and verifies status over authenticated API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: "OK",
          transId: "ABCD-EFGH-IJKL",
          status: "PAID",
          price: "12300",
          curr: "CZK",
          refId: "00000000-0000-4000-8000-000000000001",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      adapter.verifyEvent({
        headers: {},
        body: { transId: "ABCD-EFGH-IJKL", status: "CANCELLED" },
      }),
    ).resolves.toMatchObject({
      provider: "comgate",
      providerEventId: expect.stringMatching(/^comgate:[0-9a-f]{64}$/),
      status: "CAPTURED",
      merchantReference: "00000000-0000-4000-8000-000000000001",
      amountMinor: 12_300n,
      currency: "CZK",
      evidence: { source: "authenticated-status-api" },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://payments.comgate.cz/v2.0/payment/transId/ABCD-EFGH-IJKL.json",
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("merchant:secret").toString("base64")}`,
    );
  });

  it("maps the bank method and rejects non-HTTPS provider redirects", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: "OK",
          transId: "bank-intent",
          redirect: "http://unsafe.example.test/checkout",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      adapter.createIntent({
        paymentId: "00000000-0000-4000-8000-000000000001",
        merchantReference: "00000000-0000-4000-8000-000000000001",
        orderReference: "TAV-1",
        amountMinor: 12_300n,
        currency: "CZK",
        method: "BANK_TRANSFER",
        email: "customer@example.test",
        fullName: "Customer",
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        returnUrls: {
          success: "https://taven.cz/success",
          cancelled: "https://taven.cz/cancelled",
          pending: "https://taven.cz/pending",
        },
      }),
    ).rejects.toMatchObject({
      outcome: "AMBIGUOUS",
      providerIntentId: "bank-intent",
    } satisfies Partial<PaymentIntentCreationError>);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.method).toBe("BANK_ONLY");
  });

  it("classifies a lost create response as ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connection reset"),
    );

    await expect(
      adapter.createIntent({
        paymentId: "00000000-0000-4000-8000-000000000001",
        merchantReference: "00000000-0000-4000-8000-000000000001",
        orderReference: "TAV-1",
        amountMinor: 12_300n,
        currency: "CZK",
        method: "CARD",
        email: "customer@example.test",
        fullName: "Customer",
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        returnUrls: {
          success: "https://taven.cz/success",
          cancelled: "https://taven.cz/cancelled",
          pending: "https://taven.cz/pending",
        },
      }),
    ).rejects.toMatchObject({ outcome: "AMBIGUOUS" });
  });

  it("classifies an explicit create rejection as definitive", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 1309, message: "invalid amount" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      adapter.createIntent({
        paymentId: "00000000-0000-4000-8000-000000000001",
        merchantReference: "00000000-0000-4000-8000-000000000001",
        orderReference: "TAV-1",
        amountMinor: 12_300n,
        currency: "CZK",
        method: "CARD",
        email: "customer@example.test",
        fullName: "Customer",
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        returnUrls: {
          success: "https://taven.cz/success",
          cancelled: "https://taven.cz/cancelled",
          pending: "https://taven.cz/pending",
        },
      }),
    ).rejects.toMatchObject({ outcome: "DEFINITIVE_FAILURE" });
  });

  it("keeps an explicit provider-side database error ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 1200, message: "database error" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      adapter.createIntent({
        paymentId: "00000000-0000-4000-8000-000000000001",
        merchantReference: "00000000-0000-4000-8000-000000000001",
        orderReference: "TAV-1",
        amountMinor: 12_300n,
        currency: "CZK",
        method: "CARD",
        email: "customer@example.test",
        fullName: "Customer",
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        returnUrls: {
          success: "https://taven.cz/success",
          cancelled: "https://taven.cz/cancelled",
          pending: "https://taven.cz/pending",
        },
      }),
    ).rejects.toMatchObject({ outcome: "AMBIGUOUS" });
  });

  it("accepts a successful empty cancellation response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    await expect(adapter.cancelIntent("ABCD-EFGH-IJKL")).resolves.toBe(
      undefined,
    );
  });

  it("treats an authenticated already-cancelled intent as a successful retry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 1400, message: "wrong query" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            message: "OK",
            status: "CANCELLED",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await expect(adapter.cancelIntent("ABCD-EFGH-IJKL")).resolves.toBe(
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
  });
});
