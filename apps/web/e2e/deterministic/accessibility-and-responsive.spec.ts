import { test, expect, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cubePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

test.describe("Accessibility and Responsive Viewports", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  const routes = [
    { path: "/", name: "Homepage" },
    { path: "/poptavka", name: "Assisted Quote Request" },
    { path: "/vop", name: "Terms and Conditions (VOP)" },
    { path: "/jak-to-funguje", name: "How It Works" },
    { path: "/cenik", name: "Pricing" },
  ];

  for (const { path, name } of routes) {
    test(`accessibility scan on ${name} (${path}) finds zero critical or serious violations`, async ({
      page,
    }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const accessibilityScanResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const criticalOrSerious = accessibilityScanResults.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );

      expect(
        criticalOrSerious,
        `Found ${criticalOrSerious.length} critical/serious a11y violations on ${path}:\n` +
          JSON.stringify(criticalOrSerious, null, 2),
      ).toEqual([]);
    });
  }

  test("accessibility scan on /objednavka configurator finds zero critical or serious violations", async ({
    page,
    request,
  }) => {
    // Seed quote session in sessionStorage via backend session
    const res = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
      {
        headers: { "Idempotency-Key": "sess-key-a11y" },
      },
    );
    const session = await res.json();
    await page.goto("/");
    await page.evaluate((sess) => {
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
    }, session);

    await page.goto("/objednavka");
    await page.waitForLoadState("networkidle");

    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const criticalOrSerious = accessibilityScanResults.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );

    expect(criticalOrSerious).toEqual([]);
  });

  test("mobile viewport (375x667) has no horizontal scroll overflow on key pages", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    for (const { path } of routes) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      // Verify no horizontal overflow beyond viewport width
      const hasHorizontalScroll = await page.evaluate(() => {
        return (
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth
        );
      });

      expect(
        hasHorizontalScroll,
        `Page ${path} exhibits horizontal scroll overflow on mobile viewport (375px)`,
      ).toBe(false);
    }
  });

  test("keyboard navigation allows tab traversal through form controls on /poptavka", async ({
    page,
  }) => {
    await page.goto("/poptavka");
    await page.waitForLoadState("networkidle");

    const descriptionField = page.getByRole("textbox", {
      name: /Co potřebujete vyrobit/,
    });
    await descriptionField.focus();
    await expect(descriptionField).toBeFocused();

    // Press Tab to navigate to the purpose textarea
    await page.keyboard.press("Tab");
    const purposeField = page.getByRole("textbox", { name: "Účel dílu" });
    await expect(purposeField).toBeFocused();

    // The photo picker follows the description in both visual and keyboard order.
    await page.keyboard.press("Tab");
    const photoPicker = page.locator(
      '.assisted-photo-picker input[type="file"]',
    );
    await expect(photoPicker).toBeFocused();

    // Dimensions follow the optional reference photographs.
    await page.keyboard.press("Tab");
    const widthField = page.getByLabel("Šířka X (mm)");
    await expect(widthField).toBeFocused();

    // Press Tab to navigate to depth dimension input
    await page.keyboard.press("Tab");
    const depthField = page.getByLabel("Hloubka Y (mm)");
    await expect(depthField).toBeFocused();
  });

  test("mobile checkout remains readable and operable by keyboard", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles(cubePath);
    await page
      .getByRole("button", { name: "Nahrát a pokračovat ke konfiguraci" })
      .click();
    await expect(page).toHaveURL(/\/objednavka/);
    await page
      .getByRole("button", { name: "Ověřit dopravu a závaznou cenu" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "02 Kontaktní údaje" }),
    ).toBeVisible();
    await expect(page.getByLabel("Jméno kontaktní osoby")).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      scan.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);

    const fullName = page.getByLabel("Jméno kontaktní osoby");
    const email = page.getByLabel("E-mail");
    const billingName = page.getByLabel("Fakturační jméno nebo název");
    const tabTo = async (target: Locator, maxTabs = 40) => {
      for (let i = 0; i < maxTabs; i += 1) {
        await page.keyboard.press("Tab");
        if (
          await target.evaluate((element) => document.activeElement === element)
        ) {
          return;
        }
      }
      throw new Error(
        `Checkout control was not reached within ${maxTabs} tabs`,
      );
    };
    await tabTo(fullName);
    await expect(fullName).toBeFocused();
    await page.keyboard.type("E2E Keyboard Customer");
    await page.keyboard.press("Tab");
    await expect(email).toBeFocused();
    await page.keyboard.type("keyboard-checkout@example.test");
    await page.keyboard.press("Tab");
    await expect(billingName).toBeFocused();
    await page.keyboard.type("E2E Keyboard Customer");
    const street = page.getByLabel("Ulice a číslo");
    await tabTo(street);
    await expect(street).toBeFocused();
    await page.keyboard.type("Testovací 123");
    await tabTo(page.getByLabel("Doplnění adresy (volitelné)"));
    const city = page.getByLabel("Město");
    await tabTo(city);
    await expect(city).toBeFocused();
    await page.keyboard.type("Brno");
    const postalCode = page.getByLabel("PSČ");
    await tabTo(postalCode);
    await expect(postalCode).toBeFocused();
    await page.keyboard.type("60200");
    await tabTo(page.getByLabel("Země"));

    const card = page.getByRole("radio", { name: "Platební karta" });
    await tabTo(card);
    await expect(card).toBeFocused();
    await expect(card).toBeChecked();
    for (const checkbox of [
      page.getByRole("checkbox", { name: /VOP/i }),
      page.getByRole("checkbox", { name: /reklamačním řádem/i }),
      page.getByRole("checkbox", { name: /výjimka/i }),
    ]) {
      await tabTo(checkbox);
      await expect(checkbox).toBeFocused();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
    }
    const photoConsent = page.getByRole("checkbox", {
      name: /Dobrovolně souhlasím/i,
    });
    await tabTo(photoConsent);
    await expect(photoConsent).toBeFocused();
    await expect(photoConsent).not.toBeChecked();

    const submit = page.getByRole("button", { name: /Objednat a zaplatit/i });
    await expect(submit).toBeEnabled();
    await tabTo(submit);
    await expect(submit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Testovací platební brána" }),
    ).toBeVisible();
  });

  test("checkout design keeps real quote and consent reachable at key widths", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles(cubePath);
    await page
      .getByRole("button", { name: "Nahrát a pokračovat ke konfiguraci" })
      .click();
    await page
      .getByRole("button", { name: "Ověřit dopravu a závaznou cenu" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Shrnutí zakázky / TAV-2026-TEST" }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "02 Kontaktní údaje" }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "03 Způsob platby" }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "04 Potvrzení a souhlasy" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Objednat a zaplatit/i }),
    ).toHaveCount(1);
    const taxBreakdown = page.locator(".checkout-summary__breakdown");
    const netAmount = taxBreakdown.locator(".checkout-summary__tax-start");
    await expect(netAmount.locator("dt")).toHaveText("Cena bez DPH");
    await expect(netAmount.locator("dd")).toHaveText(
      /[\d\s\u00a0]+,\d{2}\s*Kč/,
    );
    const vatAmount = taxBreakdown.locator(
      ".checkout-summary__tax-start + div",
    );
    await expect(vatAmount.locator("dt")).toHaveText("DPH 21 %");
    await expect(vatAmount.locator("dd")).toHaveText(
      /[\d\s\u00a0]+,\d{2}\s*Kč/,
    );

    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      scan.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);

    for (const width of [1440, 768, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        ),
      ).toBe(false);
      await testInfo.attach(`checkout-${width}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    await page.getByRole("button", { name: "Upravit konfiguraci" }).click();
    await expect(
      page.getByRole("button", { name: "Uložit a přepočítat" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Zpět k platbě" }).click();
    await expect(
      page.getByRole("button", { name: /Objednat a zaplatit/i }),
    ).toBeVisible();
  });
});
