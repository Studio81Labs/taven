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

  test("handoff capability endpoint requires session bearer and idempotency key", async ({
    request,
  }) => {
    const sessRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
    );
    const session = await sessRes.json();

    // 1. Missing bearer -> 401
    const noAuth = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/handoff-capabilities`,
      { headers: { "Idempotency-Key": "test-key-01" } },
    );
    expect(noAuth.status()).toBe(401);

    // 2. Missing idempotency key -> 400
    const noKey = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/handoff-capabilities`,
      { headers: { Authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(noKey.status()).toBe(400);

    // 3. Valid -> 201 with handoffToken
    const valid = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/handoff-capabilities`,
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Idempotency-Key": "test-key-01",
        },
      },
    );
    expect(valid.status()).toBe(201);
    const data = await valid.json();
    expect(data.handoffToken).toBeDefined();
    expect(typeof data.handoffToken).toBe("string");
    expect(data.handoffToken.length).toBeGreaterThanOrEqual(40);
  });

  test("blocked model handoff context pre-fills note and links reference", async ({
    page,
    request,
  }) => {
    // 1. Create a real automatic-quote session
    const sessRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
    );
    const session = await sessRes.json();

    // 2. Mint a real handoff capability through contract-compatible endpoint
    const handoffRes = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/handoff-capabilities`,
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Idempotency-Key": `handoff-key-${session.sessionId}`,
        },
      },
    );
    expect(handoffRes.status()).toBe(201);
    const handoff = await handoffRes.json();
    const handoffToken = handoff.handoffToken;
    const automaticQuoteSessionId = session.sessionId;

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

    // Verify single-use capability consumption: replaying same token fails closed with 401
    const replayRes = await request.post(
      "http://127.0.0.1:4175/quote-requests",
      {
        data: {
          automaticQuoteHandoffToken: handoffToken,
          description: "Replay test",
          customer: {
            fullName: "Petr Svoboda",
            email: "petr.svoboda@example.com",
          },
        },
      },
    );
    expect(replayRes.status()).toBe(401);
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
