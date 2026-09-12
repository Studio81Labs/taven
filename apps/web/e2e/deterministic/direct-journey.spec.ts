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
});
