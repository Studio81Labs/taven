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
    request,
  }) => {
    const handoffToken = "A".repeat(43);
    const automaticQuoteSessionId = "11111111-1111-4111-8111-111111111111";

    await page.goto("/");
    await page.evaluate(
      ({ token, sessId }) => {
        window.sessionStorage.setItem(
          "taven:assisted-quote-handoff:v1",
          JSON.stringify({
            automaticQuoteSessionId: sessId,
            handoffToken: token,
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            reasons: ["FIT_SENSITIVE"],
            modelFileIds: ["22222222-2222-4222-8222-222222222222"],
            itemSelections: [
              {
                modelFileId: "22222222-2222-4222-8222-222222222222",
                ordinal: 0,
                quantity: 2,
                material: "PLA",
                fitSensitive: true,
                bodyIds: ["body-1"],
              },
            ],
          }),
        );
      },
      { token: handoffToken, sessId: automaticQuoteSessionId },
    );

    await page.goto("/poptavka?source=automatic-quote");

    // Check context banner and note specific to FIT_SENSITIVE reason
    await expect(page.getByText("KONTEXT POPTÁVKY")).toBeVisible();
    await expect(
      page.getByText(
        "Přenesli jsme jen bezpečné volby z kalkulace. Výslednou toleranci prosím upřesněte v popisu.",
      ),
    ).toBeVisible();

    // Description must be pre-filled from handoff context
    const descField = page.getByRole("textbox", {
      name: /Co potřebujete vyrobit/,
    });
    await expect(descField).toHaveValue(
      "Potřebuji individuální nabídku pro lícovaný díl, u kterého je důležitá přesnost rozměrů.",
    );

    // Fill contact details
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

    // Verify capability token was forwarded to the backend
    const stateRes = await request.get("http://127.0.0.1:4175/__test/state");
    const state = await stateRes.json();
    expect(state.lastAssistedQuote?.automaticQuoteHandoffToken).toBe(
      handoffToken,
    );

    // Verify handoff was purged from session storage after success
    const storedHandoff = await page.evaluate(() =>
      window.sessionStorage.getItem("taven:assisted-quote-handoff:v1"),
    );
    expect(storedHandoff).toBeNull();
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
