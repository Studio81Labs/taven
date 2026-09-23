import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  archiveE2eCheckoutDocumentsForBrowser,
  readE2eCheckoutEffectsForBrowser,
  readE2eParcelAllocationsForBrowser,
  resetE2eAnonymousAdmissionLimitsForBrowser,
} from "../../../backend/test/support/publish-e2e-legal-fixtures";

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
const TWO_BODY_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/two-body/two-body.3mf",
);

async function startSandboxPayment(
  page: Page,
  method: "CARD" | "BANK_TRANSFER",
  consentToPhotos = false,
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
  if (consentToPhotos) {
    await page.getByRole("checkbox", { name: /Dobrovolně souhlasím/i }).check();
  }
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

async function assertArchivedCheckoutFailsBeforeAcceptance(
  page: Page,
  request: APIRequestContext,
  checkoutSession: { sessionId: string; sessionToken: string },
): Promise<void> {
  const prior = await request.get(
    `${INTEGRATION_API_URL}/legal-documents/availability`,
  );
  expect(prior.status()).toBe(200);
  const current = (await prior.json()).documents;
  const databaseUrl = process.env.DATABASE_URL!;
  const restoreDocuments =
    await archiveE2eCheckoutDocumentsForBrowser(databaseUrl);
  try {
    const unavailable = await request.get(
      `${INTEGRATION_API_URL}/legal-documents/availability`,
    );
    expect(unavailable.status()).toBe(200);
    const unavailableDocuments = (await unavailable.json()).documents;
    for (const key of ["terms", "claims", "photoConsent"] as const) {
      expect(unavailableDocuments[key].effective).toBe(false);
    }
    const legalTab = await page.context().newPage();
    try {
      await legalTab.goto("/vop");
      await expect(
        legalTab.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
      ).toBeVisible();
    } finally {
      await legalTab.close();
    }

    const rejected = await request.post(
      `${INTEGRATION_API_URL}/automatic-quote-sessions/${checkoutSession.sessionId}/checkout/payments`,
      {
        headers: {
          Authorization: `Bearer ${checkoutSession.sessionToken}`,
          "Idempotency-Key": `legal-archived-${randomUUID()}`,
        },
        data: {
          email: "browser-144@example.test",
          fullName: "E2E Browser Test",
          billing: {
            name: "E2E Browser Test",
            addressLine1: "Testovací 123",
            city: "Brno",
            postalCode: "60200",
            countryCode: "CZ",
          },
          method: "CARD",
          acceptTerms: true,
          acceptClaimPolicy: true,
          acknowledgeWithdrawalException: true,
          termsRevision: current.terms.revision,
          claimPolicyRevision: current.claims.revision,
          photoPublicationConsent: false,
          photoConsentRevision: null,
        },
      },
    );
    expect(rejected.status()).toBe(503);
    expect(
      await readE2eCheckoutEffectsForBrowser(
        databaseUrl,
        checkoutSession.sessionId,
      ),
    ).toEqual({
      acceptedOrderPriceBindingId: null,
      paymentCount: 0,
      acceptanceCount: 0,
      decisionCount: 0,
      idempotencyCount: 0,
    });
  } finally {
    await restoreDocuments();
  }
}

test.describe("Real API Integration Journey", () => {
  test.skip(
    !integrationTest,
    "Skipped unless INTEGRATION_TEST=true environment variable is present",
  );

  test.beforeEach(async () => {
    if (
      integrationTest &&
      process.env.INTEGRATION_MUTABLE_FIXTURES === "true"
    ) {
      await resetE2eAnonymousAdmissionLimitsForBrowser(
        process.env.DATABASE_URL!,
      );
    }
  });

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
        if (process.env.INTEGRATION_MUTABLE_FIXTURES === "true") {
          await assertArchivedCheckoutFailsBeforeAcceptance(
            page,
            request,
            checkoutSession,
          );
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

  test("accepts two inspected bodies as separate items across compatible parcels", async ({
    page,
    request,
  }) => {
    test.skip(
      !completePayment || process.env.INTEGRATION_MUTABLE_FIXTURES !== "true",
      "Requires the isolated fixture-worker and browser database profile",
    );
    test.setTimeout(360_000);

    await page.goto("/");
    await page
      .locator('input[type="file"]')
      .setInputFiles(TWO_BODY_FIXTURE_PATH);
    const proceed = page.getByRole("button", {
      name: "Nahrát a pokračovat ke konfiguraci",
    });
    await expect(proceed).toBeEnabled({ timeout: 120_000 });
    await proceed.click();
    await expect(page).toHaveURL(/\/objednavka/, { timeout: 120_000 });
    const secondBody = page.getByRole("combobox", {
      name: /Položka pro body-0002 v Soubor 1 · 3MF/,
    });
    await expect(secondBody).toHaveValue("0");
    await page.getByRole("button", { name: "Přidat položku" }).click();
    await secondBody.selectOption({ label: "Položka 2" });
    const firstItem = page.locator("section.item-configuration").filter({
      has: page.getByText("POLOŽKA 1", { exact: true }),
    });
    const secondItem = page.locator("section.item-configuration").filter({
      has: page.getByText("POLOŽKA 2", { exact: true }),
    });
    await firstItem.getByRole("spinbutton", { name: "Jiné" }).fill("30");
    await secondItem
      .getByRole("combobox", { name: "Materiál" })
      .selectOption("PLA");
    await secondItem.getByRole("spinbutton", { name: "Jiné" }).fill("30");
    const configurationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/configuration"),
    );
    await page.getByRole("button", { name: "Uložit a přepočítat" }).click();
    const configured = await configurationResponse;
    expect(configured.status(), await configured.text()).toBe(200);
    expect(configured.request().postDataJSON().items).toMatchObject([
      { ordinal: 0, bodyIds: ["body-0001"], quantity: 30 },
      { ordinal: 1, bodyIds: ["body-0002"], quantity: 30 },
    ]);
    const verifyDelivery = page.getByRole("button", {
      name: "Ověřit dopravu a závaznou cenu",
    });
    await expect(verifyDelivery).toBeEnabled({ timeout: 120_000 });
    await verifyDelivery.click();
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible({ timeout: 120_000 });
    const checkoutSession = await page.evaluate(() => {
      const raw = sessionStorage.getItem("taven:automatic-quote-session:v1");
      return raw
        ? (JSON.parse(raw) as { sessionId: string; sessionToken: string })
        : null;
    });
    if (!checkoutSession) throw new Error("Multi-body session is unavailable");
    const sessionResponse = await request.get(
      `${INTEGRATION_API_URL}/automatic-quote-sessions/${checkoutSession.sessionId}`,
      {
        headers: { Authorization: `Bearer ${checkoutSession.sessionToken}` },
      },
    );
    expect(sessionResponse.status()).toBe(200);
    const session = await sessionResponse.json();
    expect(session.items).toMatchObject([
      {
        bodyIds: ["body-0001"],
        quantity: 30,
        material: "PETG",
        quality: "STANDARD",
      },
      {
        bodyIds: ["body-0002"],
        quantity: 30,
        material: "PLA",
        quality: "STANDARD",
      },
    ]);
    const shipmentComponents = session.bindingQuote.components.filter(
      (component: { kind: string }) => component.kind === "SHIPMENT",
    );
    expect(shipmentComponents.length).toBeGreaterThan(1);
    expect(
      shipmentComponents.map(
        (component: { shipmentPlanOrdinal: number }) =>
          component.shipmentPlanOrdinal,
      ),
    ).toEqual(shipmentComponents.map((_: unknown, index: number) => index + 1));
    await page.getByText("Rozpis ceny").click();
    await expect(
      page.locator(".price-list li").filter({ hasText: "Doprava" }),
    ).toHaveCount(shipmentComponents.length);

    await page.getByLabel("Jméno kontaktní osoby").fill("E2E Parcel Test");
    await page.getByLabel("E-mail").fill("browser-144-parcels@example.test");
    await page
      .getByLabel("Fakturační jméno nebo název")
      .fill("E2E Parcel Test");
    await page.getByLabel("Ulice a číslo").fill("Testovací 123");
    await page.getByLabel("Město").fill("Brno");
    await page.getByLabel("PSČ").fill("60200");
    await page.getByRole("checkbox", { name: /VOP/i }).check();
    await page.getByRole("checkbox", { name: /reklamačním řádem/i }).check();
    await page.getByRole("checkbox", { name: /výjimka/i }).check();
    await page.getByRole("button", { name: /Objednat a zaplatit/i }).click();
    await expect(
      page.getByRole("heading", { name: "TAVEN. sandbox checkout" }),
    ).toBeVisible({ timeout: 120_000 });
    const allocations = await readE2eParcelAllocationsForBrowser(
      process.env.DATABASE_URL!,
      checkoutSession.sessionId,
    );
    expect(allocations.itemBoundsMicrometers).toEqual([
      {
        ordinal: 0,
        bodyIds: ["body-0001"],
        x: "20000",
        y: "20000",
        z: "20000",
      },
      {
        ordinal: 1,
        bodyIds: ["body-0002"],
        x: "20000",
        y: "20000",
        z: "20000",
      },
    ]);
    expect(allocations.destinationCount).toBe(1);
    expect(allocations.parcels.length).toBe(shipmentComponents.length);
    expect(
      allocations.parcels.reduce(
        (total, parcel) => total + parcel.slotCount,
        0,
      ),
    ).toBe(60);
    expect(allocations.parcels.every((parcel) => parcel.slotCount > 0)).toBe(
      true,
    );
    for (const parcel of allocations.parcels) {
      expect(parcel.supportedCategoryIds).toContain(parcel.category);
    }
    await page.getByRole("button", { name: "Capture payment" }).click();
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena." }),
    ).toBeVisible({ timeout: 120_000 });
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
      true,
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
    const retryContextUrl = `${INTEGRATION_API_URL}/automatic-quote-sessions/${checkoutSession.sessionId}/checkout/retry-context`;
    const readRetryContext = async () => {
      const retryContext = await request.get(retryContextUrl, {
        headers: { Authorization: `Bearer ${checkoutSession.sessionToken}` },
      });
      expect(retryContext.status()).toBe(200);
      return retryContext.json();
    };
    const frozenRetry = await readRetryContext();
    expect(frozenRetry).toMatchObject({
      retryAllowed: true,
      acceptedEvidence: {
        termsRevision: "terms-v1",
        claimPolicyRevision: "claim-policy-v1",
        photoPublicationConsent: true,
        photoConsentRevision: "photos-v1",
        terms: { contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        claims: { contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        photoConsent: { contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
    const restoreDocuments =
      process.env.INTEGRATION_MUTABLE_FIXTURES === "true"
        ? await archiveE2eCheckoutDocumentsForBrowser(process.env.DATABASE_URL!)
        : null;
    try {
      if (restoreDocuments) {
        const legal = await request.get(
          `${INTEGRATION_API_URL}/legal-documents/availability`,
        );
        expect(legal.status()).toBe(200);
        const documents = (await legal.json()).documents;
        for (const key of ["terms", "claims", "photoConsent"] as const) {
          expect(documents[key].effective).toBe(false);
        }
        expect(await readRetryContext()).toEqual(frozenRetry);
      }
      await page.getByRole("link", { name: "Zpět ke kalkulaci" }).click();
      await expect(page).toHaveURL(/\/objednavka\?retry=1/);
      await expect(
        page.getByRole("heading", { name: "Dokončení objednávky" }),
      ).toBeVisible({ timeout: 120_000 });
      if (restoreDocuments) {
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "Platba nebyla dokončena." }),
        ).toBeVisible({ timeout: 120_000 });
      }
      await page
        .getByRole("button", { name: "Zvolit nový platební pokus" })
        .click();
      if (restoreDocuments) {
        const historicalTerms = page.getByRole("link", {
          name: "Zobrazit VOP",
        });
        await expect(historicalTerms).toHaveAttribute(
          "href",
          /\/vop\?revision=terms-v1&contentHash=[a-f0-9]{64}/,
        );
        await expect(page.getByRole("checkbox", { name: /VOP/i })).toHaveCount(
          0,
        );
        const frozenEvidence = frozenRetry.acceptedEvidence as {
          terms: { revision: string; contentHash: string };
          claims: { revision: string; contentHash: string };
          photoConsent: { revision: string; contentHash: string };
        };
        for (const { link, path, evidence } of [
          {
            link: historicalTerms,
            path: "/vop",
            evidence: frozenEvidence.terms,
          },
          {
            link: page.getByRole("link", { name: "reklamační řád" }),
            path: "/reklamace",
            evidence: frozenEvidence.claims,
          },
          {
            link: page.getByRole("link", { name: /pravidel fotografování/i }),
            path: "/fotografie-a-duvernost",
            evidence: frozenEvidence.photoConsent,
          },
        ]) {
          const href = await link.getAttribute("href");
          const url = new URL(href!, page.url());
          expect(url.pathname).toBe(path);
          expect(url.searchParams.get("revision")).toBe(evidence.revision);
          expect(url.searchParams.get("contentHash")).toBe(
            evidence.contentHash,
          );
          const historicalPage = await request.get(url.toString());
          expect(historicalPage.status()).toBe(200);
          expect(await historicalPage.text()).toContain("Historické znění");
        }
      }
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
    } finally {
      await restoreDocuments?.();
    }
  });

  test("requires an explicit cancellation before voiding a pending payment", async ({
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
    const readPayment = async () => {
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
    await page.goto(
      `/checkout/payment/cancelled?sessionId=${checkoutSession.sessionId}&paymentId=${paymentId}`,
    );
    await expect(
      page.getByRole("heading", { name: "Čekáme na potvrzení platby." }),
    ).toBeVisible({ timeout: 120_000 });
    expect(["CREATED", "PENDING"]).toContain((await readPayment()).status);
    await page
      .getByRole("button", { name: "Opravdu zrušit platební pokus" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Platební pokus byl zrušen." }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByRole("button", { name: "Začít novou kalkulaci" }),
    ).toBeVisible();
    expect(await readPayment()).toMatchObject({
      paymentId,
      method: "CARD",
      status: "VOIDED",
      provider: "sandbox",
    });
  });
});
