import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const cubePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

test.describe("Assisted Quote Journey", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("direct entrance, form completion with photo, and successful submission", async ({
    page,
    request,
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

    // Verify recorded quote request in mock backend adheres to contract
    const stateRes = await request.get("http://127.0.0.1:4175/__test/state");
    const testState = await stateRes.json();
    expect(testState.lastAssistedQuote).toBeDefined();
    expect(testState.lastAssistedQuote.contact.name).toBe("Jan Novák");
    expect(testState.lastAssistedQuote.contact.email).toBe(
      "jan.novak@example.com",
    );
    expect(
      testState.lastAssistedQuote.description.length,
    ).toBeGreaterThanOrEqual(10);
  });

  test("recovers from an unavailable legal read only after an explicit retry and fresh acknowledgement", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalStatus: "error503" },
    });
    let createCalls = 0;
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        outgoing.url() === "http://127.0.0.1:4175/quote-requests"
      ) {
        createCalls += 1;
      }
    });

    await page.goto("/poptavka?source=no-file");
    const retryLegal = page.getByRole("button", {
      name: "Zkusit načíst dokumenty znovu",
    });
    const privacyAcknowledgement = page
      .locator('input[type="checkbox"]')
      .first();
    const submit = page.getByRole("button", {
      name: "Odeslat k lidskému posouzení",
    });
    await expect(retryLegal).toBeVisible();
    await expect(privacyAcknowledgement).toBeDisabled();
    await page
      .getByRole("textbox", { name: /Co potřebujete vyrobit/ })
      .fill("Potřebuji ručně posoudit barevný model pro individuální výrobu.");
    await page.getByLabel("Jméno *").fill("E2E Retry Test");
    await page.getByLabel("E-mail *").fill("legal-retry@example.test");
    await expect(submit).toBeDisabled();
    expect(createCalls).toBe(0);

    await retryLegal.click();
    await expect(retryLegal).toBeVisible();
    await expect(privacyAcknowledgement).toBeDisabled();
    expect(createCalls).toBe(0);

    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalStatus: "approved" },
    });
    await retryLegal.click();
    await expect(privacyAcknowledgement).toBeEnabled();
    await expect(privacyAcknowledgement).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await privacyAcknowledgement.check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(
      page.getByRole("heading", {
        name: "Děkujeme. Podklady předáme k lidskému posouzení.",
      }),
    ).toBeVisible();
    expect(createCalls).toBe(1);
  });

  test("retries a failed immutable privacy document read without granting acknowledgement", async ({
    page,
  }) => {
    let privacyReads = 0;
    await page.route(
      "**/legal-documents/privacy/revisions/**",
      async (route) => {
        privacyReads += 1;
        if (privacyReads === 1) {
          await route.abort("failed");
        } else {
          await route.continue();
        }
      },
    );

    await page.goto("/poptavka");
    const retryLegal = page.getByRole("button", {
      name: "Zkusit načíst dokumenty znovu",
    });
    const privacyAcknowledgement = page
      .locator('input[type="checkbox"]')
      .first();
    await expect(retryLegal).toBeVisible();
    await expect(privacyAcknowledgement).toBeDisabled();

    await retryLegal.click();
    await expect(privacyAcknowledgement).toBeEnabled();
    await expect(privacyAcknowledgement).not.toBeChecked();
    expect(privacyReads).toBeGreaterThanOrEqual(2);
  });

  test("keeps draft legal documents closed without presenting an outage retry", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalStatus: "draft" },
    });

    await page.goto("/poptavka");
    await expect(
      page.getByText("Formulář lze odeslat až po zveřejnění účinných zásad."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Zkusit načíst dokumenty znovu" }),
    ).not.toBeVisible();
    await expect(page.locator('input[type="checkbox"]').first()).toBeDisabled();
  });

  test("declined print risk carries one request into the assisted form", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { riskScenario: "warning" },
    });
    let createCalls = 0;
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        outgoing.url() === "http://127.0.0.1:4175/quote-requests"
      ) {
        createCalls += 1;
      }
    });

    await page.goto("/");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni sem svůj 3D model").click();
    await (await chooserPromise).setFiles(cubePath);
    const proceed = page.getByRole("button", {
      name: "Nahrát a pokračovat ke konfiguraci",
    });
    await expect(proceed).toBeEnabled();
    await proceed.click();
    await expect(page).toHaveURL(/\/objednavka/);
    await expect(
      page.getByRole("heading", { name: "Potvrďte zjištěná rizika." }),
    ).toBeVisible();
    await expect(
      page.getByText("Testovací riziko tisku vyžaduje potvrzení."),
    ).toBeVisible();

    const declinedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/risk-decisions"),
    );
    await page
      .getByRole("button", {
        name: "Nepřijmout a požádat o individuální nabídku",
      })
      .click();
    expect((await declinedResponse).status()).toBe(200);
    await expect(
      page.getByText("PŘÍMÁ KALKULACE ZASTAVENA", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Riziko jste nepřijali/)).toBeVisible();

    const issuedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/handoff-capabilities"),
    );
    await page
      .getByRole("button", { name: "Pokračovat individuální poptávkou" })
      .click();
    expect((await issuedResponse).status()).toBe(201);
    await expect(page).toHaveURL(/\/poptavka\?source=automatic-quote/);
    await expect(
      page.getByRole("textbox", { name: /Co potřebujete vyrobit/ }),
    ).toHaveValue(/nechci přijmout riziko/);
    const storedHandoff = await page.evaluate(() => {
      const raw = sessionStorage.getItem("taven:assisted-quote-handoff:v1");
      return raw
        ? (JSON.parse(raw) as { handoffToken: string; reasons: string[] })
        : null;
    });
    expect(storedHandoff?.reasons).toContain("RISK_DECLINED");

    await page.getByLabel("Jméno *").fill("E2E Risk Test");
    await page.getByLabel("E-mail *").fill("risk-browser@example.test");
    await page.locator('input[type="checkbox"]').first().check();
    await page
      .getByRole("button", { name: "Odeslat k lidskému posouzení" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Děkujeme. Podklady předáme k lidskému posouzení.",
      }),
    ).toBeVisible();
    expect(createCalls).toBe(1);
    const state = await request.get("http://127.0.0.1:4175/__test/state");
    expect(await state.json()).toMatchObject({
      lastAssistedQuote: {
        attribution: { source: "automatic-quote" },
        automaticQuoteHandoffToken: storedHandoff?.handoffToken,
      },
    });
  });

  test("handoff capability endpoint requires session bearer and idempotency key", async ({
    request,
  }) => {
    const sessRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
      {
        headers: { "Idempotency-Key": "sess-key-handoff-spec" },
      },
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
      {
        headers: { "Idempotency-Key": "sess-key-blocked-handoff-spec" },
      },
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
        headers: { "Idempotency-Key": `key-qr-replay-${Date.now()}` },
        data: {
          automaticQuoteHandoffToken: handoffToken,
          description: "Replay test description long enough",
          contact: {
            name: "Petr Svoboda",
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
  test("quote request creation requires idempotency key, valid contact, min 10-char description, and detects conflicts", async ({
    request,
  }) => {
    const validContact = {
      name: "Petr Svoboda",
      email: "petr.svoboda@example.cz",
    };

    // 1. Missing Idempotency-Key -> 400
    const noKeyRes = await request.post(
      "http://127.0.0.1:4175/quote-requests",
      {
        data: {
          description: "Valid description longer than 10 chars",
          contact: validContact,
        },
      },
    );
    expect(noKeyRes.status()).toBe(400);

    // 2. Too short description (<10 chars) -> 400
    const shortDescRes = await request.post(
      "http://127.0.0.1:4175/quote-requests",
      {
        headers: { "Idempotency-Key": `key-short-${Date.now()}` },
        data: {
          description: "Short",
          contact: validContact,
        },
      },
    );
    expect(shortDescRes.status()).toBe(400);

    // 3. Missing contact name or email -> 400
    const badContactRes = await request.post(
      "http://127.0.0.1:4175/quote-requests",
      {
        headers: { "Idempotency-Key": `key-badcontact-${Date.now()}` },
        data: {
          description: "Valid description longer than 10 chars",
          contact: { name: "", email: "not-an-email" },
        },
      },
    );
    expect(badContactRes.status()).toBe(400);

    // 4. Valid creation -> 201
    const key = `key-valid-${Date.now()}`;
    const validPayload = {
      description: "Valid description longer than 10 chars",
      contact: validContact,
    };
    const validRes = await request.post(
      "http://127.0.0.1:4175/quote-requests",
      {
        headers: { "Idempotency-Key": key },
        data: validPayload,
      },
    );
    expect(validRes.status()).toBe(201);
    const created = await validRes.json();
    expect(created.requestId).toBeDefined();

    // 5. Replay same key and payload -> 201 with identical requestId
    const replayRes = await request.post(
      "http://127.0.0.1:4175/quote-requests",
      {
        headers: { "Idempotency-Key": key },
        data: validPayload,
      },
    );
    expect(replayRes.status()).toBe(201);
    const replayed = await replayRes.json();
    expect(replayed.requestId).toBe(created.requestId);

    // 6. Same key with changed payload -> 409
    const conflictRes = await request.post(
      "http://127.0.0.1:4175/quote-requests",
      {
        headers: { "Idempotency-Key": key },
        data: {
          description: "Different description longer than 10 chars",
          contact: validContact,
        },
      },
    );
    expect(conflictRes.status()).toBe(409);
  });
});
