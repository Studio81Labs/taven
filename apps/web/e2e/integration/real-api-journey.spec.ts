import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const INTEGRATION_API_URL =
  process.env.INTEGRATION_API_URL || "https://api-staging.taven.cz";
const integrationTest = process.env.INTEGRATION_TEST === "true";
const completePayment = process.env.INTEGRATION_COMPLETE_PAYMENT === "true";
const requireCheckout =
  process.env.INTEGRATION_REQUIRE_CHECKOUT === "true" || completePayment;
const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

async function startSandboxPayment(
  page: Page,
  method: "CARD" | "BANK_TRANSFER",
) {
  await page.goto("/");
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByText("Přetáhni soubor sem").click();
  await (await fileChooserPromise).setFiles(FIXTURE_PATH);
  const proceed = page.getByRole("button", {
    name: "Nahrát a pokračovat ke konfiguraci",
  });
  await expect(proceed).toBeEnabled({ timeout: 120_000 });
  await proceed.click();
  await expect(page).toHaveURL(/\/objednavka/, { timeout: 120_000 });
  await page.getByRole("button", { name: "Uložit a přepočítat" }).click();
  const verifyDelivery = page.getByRole("button", {
    name: "Ověřit dopravu a závaznou cenu",
  });
  await expect(verifyDelivery).toBeEnabled({ timeout: 120_000 });
  await verifyDelivery.click();
  await expect(
    page.getByRole("heading", { name: "Dokončení objednávky" }),
  ).toBeVisible({ timeout: 120_000 });
  await page
    .getByRole("radio", {
      name: method === "CARD" ? "Platební karta" : "Bankovní tlačítko / převod",
    })
    .check();
  await page.getByLabel("Jméno kontaktní osoby").fill("E2E Payment Test");
  await page.getByLabel("E-mail").fill("browser-144-payment@example.test");
  await page.getByLabel("Fakturační jméno nebo název").fill("E2E Payment Test");
  await page.getByLabel("Ulice a číslo").fill("Testovací 123");
  await page.getByLabel("Město").fill("Brno");
  await page.getByLabel("PSČ").fill("60200");
  await page.getByRole("checkbox", { name: /VOP/i }).check();
  await page.getByRole("checkbox", { name: /reklamačním řádem/i }).check();
  await page.getByRole("checkbox", { name: /výjimka/i }).check();
  const checkoutSession = await page.evaluate(() => {
    const raw = sessionStorage.getItem("taven:automatic-quote-session:v1");
    return raw
      ? (JSON.parse(raw) as { sessionId: string; sessionToken: string })
      : null;
  });
  if (!checkoutSession) {
    throw new Error("Checkout session evidence is unavailable");
  }
  await page.getByRole("button", { name: /Objednat a zaplatit/i }).click();
  await expect(
    page.getByRole("heading", { name: "TAVEN. sandbox checkout" }),
  ).toBeVisible({ timeout: 120_000 });
  const sandboxUrl = page.url();
  const paymentId = await page.locator("main code").textContent();
  if (!paymentId) {
    throw new Error("Sandbox checkout did not identify its payment");
  }
  return { checkoutSession, paymentId, sandboxUrl };
}

test.describe("Real API Integration Journey", () => {
  test.skip(
    !integrationTest,
    "Skipped unless INTEGRATION_TEST=true environment variable is present",
  );

  test("runs a browser upload through the live API and estimate path", async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const healthResponse = await request.get(`${INTEGRATION_API_URL}/health`);
    expect(healthResponse.status()).toBe(200);

    const legal = await request.get(
      `${INTEGRATION_API_URL}/legal-documents/availability`,
    );
    expect(legal.status()).toBe(200);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Nahraj model/i, level: 1 }),
    ).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni soubor sem").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(FIXTURE_PATH);

    await expect(
      page.getByText(/Odhad pro PLA, standardní kvalitu/i),
    ).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByText(/standardní kvalitu/i)).toBeVisible();
    const proceed = page.getByRole("button", {
      name: "Nahrát a pokračovat ke konfiguraci",
    });
    const approvalGate = page.getByRole("button", {
      name: "Kalkulace čeká na schválení",
    });
    await expect(proceed.or(approvalGate)).toBeVisible();
    if (!requireCheckout && (await approvalGate.isVisible())) {
      await expect(approvalGate).toBeDisabled();
    } else {
      await expect(proceed).toBeEnabled();
    }
    if (requireCheckout) {
      await proceed.click();
      await expect(page).toHaveURL(/\/objednavka/, { timeout: 120_000 });
      await expect(
        page.getByRole("heading", { name: "Nastavte výrobu.", level: 2 }),
      ).toBeVisible();

      if (completePayment) {
        await page.getByRole("button", { name: "Uložit a přepočítat" }).click();
        await expect(
          page.getByRole("button", {
            name: "Ověřit dopravu a závaznou cenu",
          }),
        ).toBeEnabled({ timeout: 120_000 });
        await page
          .getByRole("button", { name: "Ověřit dopravu a závaznou cenu" })
          .click();
        await expect(
          page.getByRole("heading", { name: "Dokončení objednávky" }),
        ).toBeVisible({ timeout: 120_000 });
        await page.getByLabel("Jméno kontaktní osoby").fill("E2E Browser Test");
        await page.getByLabel("E-mail").fill("browser-144@example.test");
        await page
          .getByLabel("Fakturační jméno nebo název")
          .fill("E2E Browser Test");
        await page.getByLabel("Ulice a číslo").fill("Testovací 123");
        await page.getByLabel("Město").fill("Brno");
        await page.getByLabel("PSČ").fill("60200");
        await page.getByRole("checkbox", { name: /VOP/i }).check();
        await page
          .getByRole("checkbox", { name: /reklamačním řádem/i })
          .check();
        await page.getByRole("checkbox", { name: /výjimka/i }).check();
        const checkoutSession = await page.evaluate(() => {
          const raw = sessionStorage.getItem(
            "taven:automatic-quote-session:v1",
          );
          return raw
            ? (JSON.parse(raw) as {
                sessionId: string;
                sessionToken: string;
              })
            : null;
        });
        if (!checkoutSession) {
          throw new Error("Checkout session evidence is unavailable");
        }
        await page
          .getByRole("button", { name: /Objednat a zaplatit/i })
          .click();
        await expect(
          page.getByRole("heading", { name: "TAVEN. sandbox checkout" }),
        ).toBeVisible({ timeout: 120_000 });
        const sandboxUrl = page.url();
        const pendingPaymentId = await page.locator("main code").textContent();
        if (!pendingPaymentId) {
          throw new Error("Sandbox checkout did not identify its payment");
        }
        await page.goto(
          `/checkout/payment/success?sessionId=${checkoutSession.sessionId}&paymentId=${pendingPaymentId}`,
        );
        await expect(
          page.getByRole("heading", { name: "Čekáme na potvrzení platby." }),
        ).toBeVisible({ timeout: 120_000 });
        await expect(
          page.getByRole("heading", { name: "Platba byla potvrzena." }),
        ).not.toBeVisible();
        const prematureStatus = await request.get(
          `${INTEGRATION_API_URL}/automatic-quote-sessions/${checkoutSession.sessionId}/checkout/payment`,
          {
            headers: {
              Authorization: `Bearer ${checkoutSession.sessionToken}`,
            },
            params: { paymentId: pendingPaymentId },
          },
        );
        expect(prematureStatus.status()).toBe(200);
        expect(["CREATED", "PENDING"]).toContain(
          (await prematureStatus.json()).status,
        );

        await page.goto(sandboxUrl);
        await page.getByRole("button", { name: "Capture payment" }).click();
        await expect(page).toHaveURL(/\/checkout\/payment\/success/);
        await expect(
          page.getByRole("heading", { name: "Platba byla potvrzena." }),
        ).toBeVisible({ timeout: 120_000 });
        await expect(page.getByText("PLATBA PŘIJATA")).toBeVisible();
        const returnUrl = new URL(page.url());
        const sessionId = returnUrl.searchParams.get("sessionId");
        const paymentId = returnUrl.searchParams.get("paymentId");
        const stored = await page.evaluate(() => {
          const raw = sessionStorage.getItem(
            "taven:automatic-quote-session:v1",
          );
          return raw
            ? (JSON.parse(raw) as {
                capturedPaymentId?: string;
                publicReference: string;
                sessionId: string;
                sessionToken: string;
              })
            : null;
        });
        if (!sessionId || !paymentId || !stored) {
          throw new Error(
            "Captured checkout return is missing its session evidence",
          );
        }
        expect(sessionId).toBe(checkoutSession.sessionId);
        expect(paymentId).toBe(pendingPaymentId);
        expect(stored.sessionId).toBe(sessionId);
        expect(stored.capturedPaymentId).toBe(paymentId);
        await expect(
          page.getByText(`Reference ${stored.publicReference}`),
        ).toBeVisible();
        const confirmed = await request.get(
          `${INTEGRATION_API_URL}/automatic-quote-sessions/${sessionId}/checkout/payment`,
          {
            headers: { Authorization: `Bearer ${stored.sessionToken}` },
            params: { paymentId },
          },
        );
        expect(confirmed.status()).toBe(200);
        expect(await confirmed.json()).toMatchObject({
          paymentId,
          status: "CAPTURED",
          provider: "sandbox",
        });
      }
    }
  });

  test("selects bank transfer and follows pending to captured sandbox payment", async ({
    page,
    request,
  }) => {
    test.skip(
      !completePayment,
      "Requires the isolated sandbox checkout profile",
    );
    test.setTimeout(360_000);

    const { checkoutSession, paymentId, sandboxUrl } =
      await startSandboxPayment(page, "BANK_TRANSFER");
    const paymentStatus = async () => {
      const response = await request.get(
        `${INTEGRATION_API_URL}/automatic-quote-sessions/${checkoutSession.sessionId}/checkout/payment`,
        {
          headers: { Authorization: `Bearer ${checkoutSession.sessionToken}` },
          params: { paymentId },
        },
      );
      expect(response.status()).toBe(200);
      return response.json();
    };
    const initialPayment = await paymentStatus();
    expect(initialPayment).toMatchObject({
      paymentId,
      method: "BANK_TRANSFER",
      provider: "sandbox",
    });
    expect(["CREATED", "PENDING"]).toContain(initialPayment.status);

    await page.getByRole("button", { name: "Keep pending" }).click();
    await expect(page).toHaveURL(/\/checkout\/payment\/pending/);
    await expect(
      page.getByRole("heading", { name: "Čekáme na potvrzení platby." }),
    ).toBeVisible({ timeout: 120_000 });
    expect(await paymentStatus()).toMatchObject({
      paymentId,
      method: "BANK_TRANSFER",
      status: "PENDING",
    });

    await page.goto(sandboxUrl);
    await page.getByRole("button", { name: "Capture payment" }).click();
    await expect(page).toHaveURL(/\/checkout\/payment\/success/);
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena." }),
    ).toBeVisible({ timeout: 120_000 });
    expect(await paymentStatus()).toMatchObject({
      paymentId,
      method: "BANK_TRANSFER",
      status: "CAPTURED",
    });
  });

  test("keeps a declined card payment unpaid and offers a retry", async ({
    page,
    request,
  }) => {
    test.skip(
      !completePayment,
      "Requires the isolated sandbox checkout profile",
    );
    test.setTimeout(360_000);

    const { checkoutSession, paymentId } = await startSandboxPayment(
      page,
      "CARD",
    );
    await page.getByRole("button", { name: "Decline payment" }).click();
    await expect(page).toHaveURL(/\/checkout\/payment\/cancelled/);
    await expect(
      page.getByRole("heading", { name: "Platba nebyla dokončena." }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena." }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("link", { name: "Zpět ke kalkulaci" }),
    ).toBeVisible();
    const response = await request.get(
      `${INTEGRATION_API_URL}/automatic-quote-sessions/${checkoutSession.sessionId}/checkout/payment`,
      {
        headers: { Authorization: `Bearer ${checkoutSession.sessionToken}` },
        params: { paymentId },
      },
    );
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      paymentId,
      method: "CARD",
      status: "FAILED",
      provider: "sandbox",
    });
    await page.getByRole("link", { name: "Zpět ke kalkulaci" }).click();
    await expect(page).toHaveURL(/\/objednavka\?retry=1/);
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible({ timeout: 120_000 });
    await page
      .getByRole("button", { name: "Zvolit nový platební pokus" })
      .click();
    await expect(
      page.getByRole("button", { name: /Objednat a zaplatit/i }),
    ).toBeEnabled({ timeout: 120_000 });
    await page.getByRole("button", { name: /Objednat a zaplatit/i }).click();
    await expect(
      page.getByRole("heading", { name: "TAVEN. sandbox checkout" }),
    ).toBeVisible({ timeout: 120_000 });
    const retryPaymentId = await page.locator("main code").textContent();
    if (!retryPaymentId) {
      throw new Error("Retry sandbox checkout did not identify its payment");
    }
    expect(retryPaymentId).not.toBe(paymentId);
    await page.getByRole("button", { name: "Capture payment" }).click();
    await expect(page).toHaveURL(/\/checkout\/payment\/success/);
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena." }),
    ).toBeVisible({ timeout: 120_000 });
    const retriedPayment = await request.get(
      `${INTEGRATION_API_URL}/automatic-quote-sessions/${checkoutSession.sessionId}/checkout/payment`,
      {
        headers: { Authorization: `Bearer ${checkoutSession.sessionToken}` },
        params: { paymentId: retryPaymentId },
      },
    );
    expect(retriedPayment.status()).toBe(200);
    expect(await retriedPayment.json()).toMatchObject({
      paymentId: retryPaymentId,
      method: "CARD",
      status: "CAPTURED",
    });
  });
});
