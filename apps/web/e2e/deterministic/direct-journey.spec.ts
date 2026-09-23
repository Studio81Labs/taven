import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

test.describe("Direct Customer Journey (End-to-End)", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("keeps destination reselection available after a commercial conflict", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni soubor sem").click();
    await (await fileChooserPromise).setFiles(FIXTURE_PATH);
    await page
      .getByRole("button", { name: "Nahrát a pokračovat ke konfiguraci" })
      .click();
    await expect(page).toHaveURL(/\/objednavka/);
    const verifyDelivery = page.getByRole("button", {
      name: "Ověřit dopravu a závaznou cenu",
    });
    await expect(verifyDelivery).toBeVisible();
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { prepareCommercialConflictOnce: true },
    });
    await verifyDelivery.click();
    await expect(page.getByText(/Cena nebo doprava se změnila/)).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Způsob a místo" }),
    ).toBeVisible();
    const reselect = page.getByRole("button", { name: "Znovu ověřit místo" });
    await expect(reselect).toBeEnabled();
    await reselect.click();
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible();
  });

  test("full direct customer journey: model upload -> estimate -> configurator -> checkout -> payment -> confirmation", async ({
    page,
  }) => {
    // 1. Visit homepage
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Nahraj model/i, level: 1 }),
    ).toBeVisible();

    // 2. Select STL model via file chooser
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni soubor sem").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(FIXTURE_PATH);

    // 3. Verify baseline estimate card displays STANDARD quality assumption (Issue #147)
    await expect(page.getByText("Nezávazný rychlý odhad")).toBeVisible();
    await expect(page.getByText(/standardní kvalitu/i)).toBeVisible();

    // 4. Click proceed to configurator
    const uploadProceedBtn = page.getByRole("button", {
      name: "Nahrát a pokračovat ke konfiguraci",
    });
    await expect(uploadProceedBtn).toBeEnabled();
    await uploadProceedBtn.click();

    // 5. Arrive at /objednavka
    await expect(page).toHaveURL(/\/objednavka/);
    await expect(
      page.getByRole("heading", { name: "Nastavte výrobu.", level: 2 }),
    ).toBeVisible();

    // 6. Verify configurable qualities (Rychlá = DRAFT, Standardní = STANDARD, Jemná = FINE)
    const qualitySelect = page.getByRole("combobox", { name: "Kvalita" });
    await expect(qualitySelect).toBeVisible();
    await expect(qualitySelect.locator('option[value="DRAFT"]')).toHaveText(
      "Rychlá",
    );
    await expect(qualitySelect.locator('option[value="STANDARD"]')).toHaveText(
      "Standardní",
    );
    await expect(qualitySelect.locator('option[value="FINE"]')).toHaveText(
      "Jemná",
    );

    // 7. Select delivery destination and verify binding price
    const verifyDeliveryBtn = page.getByRole("button", {
      name: "Ověřit dopravu a závaznou cenu",
    });
    await expect(verifyDeliveryBtn).toBeVisible();
    await verifyDeliveryBtn.click();

    // 8. Advances to CHECKOUT_READY phase
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Kontakt a fakturační údaje" }),
    ).toBeVisible();

    // 9. Fill checkout form
    await page.getByLabel("Jméno kontaktní osoby").fill("Jan Zákazník");
    await page.getByLabel("E-mail").fill("jan.zakaznik@example.cz");
    await page.getByLabel("Fakturační jméno nebo název").fill("Jan Zákazník");
    await page.getByLabel("Ulice a číslo").fill("Hlavní 123");
    await page.getByLabel("Město").fill("Brno");
    await page.getByLabel("PSČ").fill("60200");

    // 10. Confirm legal documents and exceptions
    await page.getByRole("checkbox", { name: /VOP/i }).check();
    await page.getByRole("checkbox", { name: /reklamačním řádem/i }).check();
    await page.getByRole("checkbox", { name: /výjimka/i }).check();

    // 11. Submit checkout and initiate payment
    const payButton = page.getByRole("button", {
      name: /Objednat a zaplatit/i,
    });
    await expect(payButton).toBeEnabled();
    await payButton.click();

    // 12. Mock payment gateway simulator should load
    await expect(
      page.getByRole("heading", { name: "Testovací platební brána" }),
    ).toBeVisible();

    // 13. Complete payment in mock gateway
    const paySuccessBtn = page.locator("#btn-pay-success");
    await paySuccessBtn.click();

    // 14. Return to payment success verification page
    await expect(page).toHaveURL(/\/checkout\/payment\/success/);
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena.", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("PLATBA PŘIJATA")).toBeVisible();
    await expect(
      page.getByText("Objednávku jsme přijali a připravujeme ji k výrobě."),
    ).toBeVisible();
  });

  test("requires fresh consent after the server rotates legal revisions before checkout", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni soubor sem").click();
    await (await fileChooserPromise).setFiles(FIXTURE_PATH);
    await page
      .getByRole("button", { name: "Nahrát a pokračovat ke konfiguraci" })
      .click();
    await page
      .getByRole("button", { name: "Ověřit dopravu a závaznou cenu" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible();

    await page.getByLabel("Jméno kontaktní osoby").fill("Jan Zákazník");
    await page.getByLabel("E-mail").fill("jan.zakaznik@example.cz");
    await page.getByLabel("Fakturační jméno nebo název").fill("Jan Zákazník");
    await page.getByLabel("Ulice a číslo").fill("Hlavní 123");
    await page.getByLabel("Město").fill("Brno");
    await page.getByLabel("PSČ").fill("60200");
    const terms = page.getByRole("checkbox", { name: /VOP/i });
    const claims = page.getByRole("checkbox", { name: /reklamačním řádem/i });
    const withdrawal = page.getByRole("checkbox", { name: /výjimka/i });
    const photoConsent = page.getByRole("checkbox", {
      name: /Dobrovolně souhlasím s pořízením/i,
    });
    await terms.check();
    await claims.check();
    await withdrawal.check();
    await photoConsent.check();

    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalRevisionVersion: 2 },
    });
    await page.getByRole("button", { name: /Objednat a zaplatit/i }).click();
    await expect(
      page.getByRole("heading", { name: "Objednávku zatím nelze zaplatit." }),
    ).toBeVisible();
    const state = await request.get("http://127.0.0.1:4175/__test/state");
    expect((await state.json()).lastCheckoutPayload).toBeNull();

    await page.reload();
    await expect(page.getByText("terms-test-v2")).toBeVisible();
    await expect(terms).not.toBeChecked();
    await expect(claims).not.toBeChecked();
    await expect(withdrawal).not.toBeChecked();
    await expect(photoConsent).not.toBeChecked();

    const replacementHash = "9".repeat(64);
    await expect(
      page.getByRole("link", { name: "VOP", exact: true }),
    ).toHaveAttribute(
      "href",
      `/vop?revision=terms-test-v2&contentHash=${replacementHash}`,
    );
    await expect(
      page.getByRole("link", { name: "reklamačním řádem" }),
    ).toHaveAttribute(
      "href",
      `/reklamace?revision=claims-test-v2&contentHash=${replacementHash}`,
    );
    await expect(
      page.getByRole("link", { name: "pravidel fotografování" }),
    ).toHaveAttribute(
      "href",
      `/fotografie-a-duvernost?revision=photo-consent-test-v2&contentHash=${replacementHash}`,
    );

    await terms.check();
    await claims.check();
    await withdrawal.check();
    await photoConsent.check();
    const pay = page.getByRole("button", { name: /Objednat a zaplatit/i });
    await expect(pay).toBeEnabled();
    await pay.click();
    await expect(
      page.getByRole("heading", { name: "Testovací platební brána" }),
    ).toBeVisible();
    const accepted = await request.get("http://127.0.0.1:4175/__test/state");
    expect((await accepted.json()).lastCheckoutPayload).toMatchObject({
      acceptTerms: true,
      acceptClaimPolicy: true,
      acknowledgeWithdrawalException: true,
      termsRevision: "terms-test-v2",
      claimPolicyRevision: "claims-test-v2",
      photoPublicationConsent: true,
      photoConsentRevision: "photo-consent-test-v2",
    });
    await page.locator("#btn-pay-success").click();
    await expect(page).toHaveURL(/\/checkout\/payment\/success/);
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena.", level: 1 }),
    ).toBeVisible();
  });

  test("backend capacity failure (503) during checkout presents clear error feedback and allows retry", async ({
    page,
    request,
  }) => {
    // 1. Visit homepage and upload model
    await page.goto("/");
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni soubor sem").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(FIXTURE_PATH);

    // 2. Proceed to configurator
    const uploadProceedBtn = page.getByRole("button", {
      name: "Nahrát a pokračovat ke konfiguraci",
    });
    await expect(uploadProceedBtn).toBeEnabled();
    await uploadProceedBtn.click();

    // 3. Select delivery destination and advance to CHECKOUT_READY
    const verifyDeliveryBtn = page.getByRole("button", {
      name: "Ověřit dopravu a závaznou cenu",
    });
    await expect(verifyDeliveryBtn).toBeVisible();
    await verifyDeliveryBtn.click();

    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible();

    // 4. Fill checkout form
    await page.getByLabel("Jméno kontaktní osoby").fill("Jan Zákazník");
    await page.getByLabel("E-mail").fill("jan.zakaznik@example.cz");
    await page.getByLabel("Fakturační jméno nebo název").fill("Jan Zákazník");
    await page.getByLabel("Ulice a číslo").fill("Hlavní 123");
    await page.getByLabel("Město").fill("Brno");
    await page.getByLabel("PSČ").fill("60200");

    await page.getByRole("checkbox", { name: /VOP/i }).check();
    await page.getByRole("checkbox", { name: /reklamačním řádem/i }).check();
    await page.getByRole("checkbox", { name: /výjimka/i }).check();

    // 5. Simulate out-of-capacity condition on backend
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { capacityStatus: "out_of_capacity" },
    });

    // 6. Submit checkout and assert 503 capacity feedback
    const payButton = page.getByRole("button", {
      name: /Objednat a zaplatit/i,
    });
    await expect(payButton).toBeEnabled();
    await payButton.click();

    await expect(page.getByRole("alert")).toContainText(
      "Platba teď není dostupná. Údaje zůstaly uložené a pokus můžete bezpečně zopakovat.",
    );
    await expect(payButton).toBeEnabled();

    // 7. Restore capacity and verify payment can be retried successfully
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { capacityStatus: "available" },
    });
    await payButton.click();
    await expect(
      page.getByRole("heading", { name: "Testovací platební brána" }),
    ).toBeVisible();
  });

  test("rapid checkout activation starts only one payment command", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
    await page
      .getByRole("button", { name: "Nahrát a pokračovat ke konfiguraci" })
      .click();
    await page
      .getByRole("button", { name: "Ověřit dopravu a závaznou cenu" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible();

    await page.getByLabel("Jméno kontaktní osoby").fill("Jan Zákazník");
    await page.getByLabel("E-mail").fill("jan.zakaznik@example.cz");
    await page.getByLabel("Fakturační jméno nebo název").fill("Jan Zákazník");
    await page.getByLabel("Ulice a číslo").fill("Hlavní 123");
    await page.getByLabel("Město").fill("Brno");
    await page.getByLabel("PSČ").fill("60200");
    await page.getByRole("checkbox", { name: /VOP/i }).check();
    await page.getByRole("checkbox", { name: /reklamačním řádem/i }).check();
    await page.getByRole("checkbox", { name: /výjimka/i }).check();

    let paymentCommands = 0;
    await page.route("**/checkout/payments", async (route) => {
      paymentCommands += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    const payButton = page.getByRole("button", {
      name: /Objednat a zaplatit/i,
    });
    await expect(payButton).toBeEnabled();
    await payButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(
      page.getByRole("heading", { name: "Testovací platební brána" }),
    ).toBeVisible();
    expect(paymentCommands).toBe(1);
  });
});
