import { test, expect } from "@playwright/test";

async function createSeededSessionAndPayment(request: any) {
  const sessRes = await request.post(
    "http://127.0.0.1:4175/automatic-quote-sessions",
  );
  const session = await sessRes.json();
  await request.post(
    `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/prepare`,
    {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    },
  );
  const payRes = await request.post(
    `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payments`,
    {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    },
  );
  const payment = await payRes.json();
  return { session, payment };
}

test.describe("Payment Outcomes & Session Protection", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("direct navigation to payment return without stored session fails closed", async ({
    page,
  }) => {
    await page.goto(
      "/checkout/payment/success?paymentId=00000000-0000-4000-8000-000000000123&sessionId=00000000-0000-4000-8000-000000000456",
    );
    // Error must be displayed
    await expect(
      page.getByText(
        "Uložená relace objednávky není v tomto prohlížeči dostupná.",
      ),
    ).toBeVisible();
    // No success confirmation may be displayed
    await expect(page.getByText("Děkujeme za objednávku")).not.toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();
  });

  test("direct navigation with mismatched session or payment ID fails closed", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => {
      window.sessionStorage.setItem(
        "taven:automatic-quote-session:v1",
        JSON.stringify({
          sessionId: "00000000-0000-4000-8000-000000000123",
          sessionToken: "Abcdef1234567890_-Abcdef1234567890_-Abcdef1",
          filename: "cube.stl",
          publicReference: "TAV-REAL-123",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      );
      window.sessionStorage.setItem(
        "taven:checkout-session:v1",
        JSON.stringify({
          sessionId: "00000000-0000-4000-8000-000000000123",
          command: {
            paymentId: "00000000-0000-4000-8000-000000000456",
            idempotencyKey: "key-real-12345",
            requestFingerprint: "fingerprint-real",
          },
        }),
      );
    });

    // Mismatched session ID
    await page.goto(
      "/checkout/payment/success?paymentId=00000000-0000-4000-8000-000000000456&sessionId=00000000-0000-4000-8000-000000000999",
    );
    await expect(
      page.getByText("Návrat neodpovídá uložené relaci objednávky."),
    ).toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();

    // Mismatched payment ID
    await page.goto(
      "/checkout/payment/success?paymentId=00000000-0000-4000-8000-000000000888&sessionId=00000000-0000-4000-8000-000000000123",
    );
    await expect(
      page.getByText("Návrat neodpovídá uloženému platebnímu pokusu."),
    ).toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();
  });

  test("capability enforcement rejects missing or invalid bearer token", async ({
    request,
  }) => {
    const res = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
    );
    const session = await res.json();

    const noAuth = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}`,
    );
    expect(noAuth.status()).toBe(401);

    const badAuth = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}`,
      { headers: { Authorization: "Bearer wrong-token-123" } },
    );
    expect(badAuth.status()).toBe(401);

    const goodAuth = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}`,
      { headers: { Authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(goodAuth.status()).toBe(200);
  });

  test("backend rejects non-UUID or unknown payment IDs and fails closed", async ({
    request,
  }) => {
    const res = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
    );
    const session = await res.json();

    // Non-UUID payment rejected with 400
    const nonUuidRes = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payment?paymentId=not-a-uuid`,
      { headers: { Authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(nonUuidRes.status()).toBe(400);

    // Unknown UUID payment rejected with 404
    const unknownRes = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payment?paymentId=00000000-0000-4000-8000-000000000999`,
      { headers: { Authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(unknownRes.status()).toBe(404);
  });

  test("captured payment displays order reference and confirmed receipt", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "CAPTURED" },
    });

    const { session, payment } = await createSeededSessionAndPayment(request);

    await page.goto("/");
    await page.evaluate(
      ({ sess, pay }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            sessionToken: sess.sessionToken,
            filename: "cube.stl",
            publicReference: sess.publicReference,
            expiresAt: sess.expiresAt,
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            command: {
              paymentId: pay.paymentId,
              idempotencyKey: `key-${pay.paymentId}-valid`,
              requestFingerprint: "fingerprint-captured",
            },
          }),
        );
      },
      { sess: session, pay: payment },
    );

    await page.goto(
      `/checkout/payment/success?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );

    // Verify confirmed payment presentation
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena.", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Objednávku jsme přijali a připravujeme ji k výrobě."),
    ).toBeVisible();
    await expect(page.getByText("Reference TAV-2026-TEST")).toBeVisible();
  });

  test("pending payment displays processing state and polling", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "PENDING" },
    });

    const { session, payment } = await createSeededSessionAndPayment(request);

    await page.goto("/");
    await page.evaluate(
      ({ sess, pay }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            sessionToken: sess.sessionToken,
            filename: "cube.stl",
            publicReference: sess.publicReference,
            expiresAt: sess.expiresAt,
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            command: {
              paymentId: pay.paymentId,
              idempotencyKey: `key-${pay.paymentId}-valid`,
              requestFingerprint: "fingerprint-pending",
            },
          }),
        );
      },
      { sess: session, pay: payment },
    );

    await page.goto(
      `/checkout/payment/pending?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );

    // Verify pending presentation
    await expect(
      page.getByRole("heading", {
        name: "Čekáme na potvrzení platby.",
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Poskytovatel zatím nepotvrdil konečný výsledek."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Načíst aktuální stav" }),
    ).toBeVisible();

    // Transition backend payment status to CAPTURED
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "CAPTURED" },
    });

    // Verify automatic polling picks up the transition without user clicking refresh
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena.", level: 1 }),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("PLATBA PŘIJATA")).toBeVisible();
    await expect(
      page.getByText("Objednávku jsme přijali a připravujeme ji k výrobě."),
    ).toBeVisible();
  });

  test("failed or cancelled payment provides clear feedback and restart option", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "FAILED" },
    });

    const { session, payment } = await createSeededSessionAndPayment(request);

    await page.goto("/");
    await page.evaluate(
      ({ sess, pay }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            sessionToken: sess.sessionToken,
            filename: "cube.stl",
            publicReference: sess.publicReference,
            expiresAt: sess.expiresAt,
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            command: {
              paymentId: pay.paymentId,
              idempotencyKey: `key-${pay.paymentId}-valid`,
              requestFingerprint: "fingerprint-failed",
            },
          }),
        );
      },
      { sess: session, pay: payment },
    );

    await page.goto(
      `/checkout/payment/cancelled?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );

    // Should indicate failure and offer retry
    await expect(
      page.getByRole("heading", { name: "Platba nebyla dokončena.", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Zpět ke kalkulaci" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Načíst aktuální stav" }),
    ).toBeVisible();
  });
});
