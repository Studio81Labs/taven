import { test, expect } from "@playwright/test";

test.describe("Payment Outcomes & Session Protection", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("direct navigation to payment return without stored session fails closed", async ({
    page,
  }) => {
    await page.goto(
      "/checkout/payment/success?paymentId=pay-fake-123&sessionId=session-fake-123",
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
          sessionId: "session-real-123",
          sessionToken: "token-real-123",
          filename: "cube.stl",
          publicReference: "TAV-REAL-123",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      );
      window.sessionStorage.setItem(
        "taven:checkout-session:v1",
        JSON.stringify({
          sessionId: "session-real-123",
          command: {
            paymentId: "pay-real-123",
            idempotencyKey: "key-real-12345",
            requestFingerprint: "fingerprint-real",
          },
        }),
      );
    });

    // Mismatched session ID
    await page.goto(
      "/checkout/payment/success?paymentId=pay-real-123&sessionId=session-wrong-999",
    );
    await expect(
      page.getByText("Návrat neodpovídá uložené relaci objednávky."),
    ).toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();

    // Mismatched payment ID
    await page.goto(
      "/checkout/payment/success?paymentId=pay-wrong-999&sessionId=session-real-123",
    );
    await expect(
      page.getByText("Návrat neodpovídá uloženému platebnímu pokusu."),
    ).toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();
  });

  test("captured payment displays order reference and confirmed receipt", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "CAPTURED" },
    });

    const sessionId = "session-captured-001";
    const paymentId = "pay-captured-001";

    await page.goto("/");
    await page.evaluate(
      ({ sessId, payId }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sessId,
            sessionToken: `token-${sessId}`,
            filename: "cube.stl",
            publicReference: "TAV-2026-TEST",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sessId,
            command: {
              paymentId: payId,
              idempotencyKey: `key-${payId}-valid`,
              requestFingerprint: "fingerprint-captured",
            },
          }),
        );
      },
      { sessId: sessionId, payId: paymentId },
    );

    await page.goto(
      `/checkout/payment/success?paymentId=${paymentId}&sessionId=${sessionId}`,
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

    const sessionId = "session-pending-001";
    const paymentId = "pay-pending-001";

    await page.goto("/");
    await page.evaluate(
      ({ sessId, payId }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sessId,
            sessionToken: `token-${sessId}`,
            filename: "cube.stl",
            publicReference: "TAV-2026-TEST",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sessId,
            command: {
              paymentId: payId,
              idempotencyKey: `key-${payId}-valid`,
              requestFingerprint: "fingerprint-pending",
            },
          }),
        );
      },
      { sessId: sessionId, payId: paymentId },
    );

    await page.goto(
      `/checkout/payment/pending?paymentId=${paymentId}&sessionId=${sessionId}`,
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

    const sessionId = "session-failed-001";
    const paymentId = "pay-failed-001";

    await page.goto("/");
    await page.evaluate(
      ({ sessId, payId }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sessId,
            sessionToken: `token-${sessId}`,
            filename: "cube.stl",
            publicReference: "TAV-2026-TEST",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sessId,
            command: {
              paymentId: payId,
              idempotencyKey: `key-${payId}-valid`,
              requestFingerprint: "fingerprint-failed",
            },
          }),
        );
      },
      { sessId: sessionId, payId: paymentId },
    );

    await page.goto(
      `/checkout/payment/cancelled?paymentId=${paymentId}&sessionId=${sessionId}`,
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
