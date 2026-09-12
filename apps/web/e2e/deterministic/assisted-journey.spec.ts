import { test, expect } from "@playwright/test";

test.describe("Assisted Quote Journey", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("direct entrance, form completion with photo, and successful submission", async ({
    page,
  }) => {
    await page.goto("/poptavka");

    // Check page title and heading
    await expect(
      page.getByRole("heading", {
        name: "Popište, co potřebujete vyrobit.",
        level: 1,
      }),
    ).toBeVisible();

    // Fill in required fields
    await page
      .getByRole("textbox", { name: /Co potřebujete vyrobit/ })
      .fill(
        "Potřebuji vyrobit náhradní krytku na míru, rozměry cca 80x40 mm, materiál odolný vůči UV.",
      );
    await page.getByLabel("Jméno *").fill("Jan Novák");
    await page.getByLabel("E-mail *").fill("jan.novak@example.com");

    // Optional phone & dimensions
    await page.getByLabel("Telefon").fill("+420777123456");
    await page.getByLabel("Šířka X (mm)").fill("80");
    await page.getByLabel("Hloubka Y (mm)").fill("40");

    // Attach reference photo
    const buffer = Buffer.from("fake-png-content-data");
    await page.locator('input[type="file"][accept*="image"]').setInputFiles({
      name: "reference-part.png",
      mimeType: "image/png",
      buffer,
    });

    // Verify photo appears in list
    await expect(page.getByText("reference-part.png")).toBeVisible();

    // Check privacy consent
    await page.locator('input[type="checkbox"]').first().check();

    // Submit form
    const submitButton = page.getByRole("button", {
      name: "Odeslat k lidskému posouzení",
    });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // Verify success confirmation
    await expect(
      page.getByRole("heading", {
        name: "Děkujeme. Podklady předáme k lidskému posouzení.",
      }),
    ).toBeVisible();
    await expect(page.getByText("Reference REQ-2026-TEST")).toBeVisible();
    await expect(page.getByText("POPTÁVKA ULOŽENA")).toBeVisible();
  });

  test("blocked model handoff context pre-fills note and links reference", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => {
      window.sessionStorage.setItem(
        "taven:assisted-quote-handoff:v1",
        JSON.stringify({
          handoffToken: "token-handoff-xyz",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          filename: "huge-gearbox.stl",
          reason: "MODEL_TOO_LARGE",
        }),
      );
    });

    await page.goto("/poptavka?source=automatic-quote");

    // Check context banner appears
    await expect(page.getByText("KONTEXT POPTÁVKY")).toBeVisible();

    // Fill remaining required fields
    await page
      .getByRole("textbox", { name: /Co potřebujete vyrobit/ })
      .fill(
        "Potřebuji individuální nabídku pro velký model převodovky, který překračuje tiskový prostor.",
      );
    await page.getByLabel("Jméno *").fill("Petr Svoboda");
    await page.getByLabel("E-mail *").fill("petr.svoboda@example.com");

    // Consent
    await page.locator('input[type="checkbox"]').first().check();

    // Submit
    const submitButton = page.getByRole("button", {
      name: "Odeslat k lidskému posouzení",
    });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // Verify confirmation
    await expect(page.getByText("POPTÁVKA ULOŽENA")).toBeVisible();
    await expect(page.getByText("Reference REQ-2026-TEST")).toBeVisible();
  });

  test("client-side validation prevents submission without mandatory fields", async ({
    page,
  }) => {
    await page.goto("/poptavka");

    const submitButton = page.getByRole("button", {
      name: "Odeslat k lidskému posouzení",
    });
    // Button must be disabled until required fields are filled
    await expect(submitButton).toBeDisabled();

    // Filling only description is not enough
    await page
      .getByRole("textbox", { name: /Co potřebujete vyrobit/ })
      .fill("Pouze krátký popis bez kontaktu.");
    await expect(submitButton).toBeDisabled();
  });
});
