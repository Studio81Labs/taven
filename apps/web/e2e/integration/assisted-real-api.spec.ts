import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { resetE2eAnonymousAdmissionLimitsForBrowser } from "../../../backend/test/support/publish-e2e-legal-fixtures";

const apiUrl =
  process.env.INTEGRATION_API_URL ?? "https://api-staging.taven.cz";
const storageUrl = process.env.INTEGRATION_STORAGE_URL;
const enabled =
  process.env.INTEGRATION_TEST === "true" &&
  process.env.INTEGRATION_COMPLETE_ASSISTED === "true";
const cubePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);
const paintedFixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/painted-multimaterial/source",
);

test.describe("Real API assisted request", () => {
  test.skip(!enabled, "Requires explicit opt-in to create an assisted request");

  test.beforeEach(async () => {
    if (enabled && process.env.INTEGRATION_MUTABLE_FIXTURES === "true") {
      await resetE2eAnonymousAdmissionLimitsForBrowser(
        process.env.DATABASE_URL!,
      );
    }
  });

  test("retains one request and photo retention across a failed upload retry", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    if (!storageUrl) {
      throw new Error("INTEGRATION_STORAGE_URL is required for this profile");
    }

    // A browser screenshot is a valid PNG and contains no customer material.
    await page.setContent("<html><body>Assisted fixture photo</body></html>");
    const photo = await page.screenshot({ type: "png" });
    let createCalls = 0;
    let failedFirstPut = false;
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        outgoing.url() === `${apiUrl}/quote-requests`
      ) {
        createCalls += 1;
      }
    });
    await page.route(`${storageUrl}/**`, async (route) => {
      if (route.request().method() === "PUT" && !failedFirstPut) {
        failedFirstPut = true;
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });

    await page.goto("/poptavka?source=no-file");
    await expect(
      page.getByRole("heading", { name: "Popište, co potřebujete vyrobit." }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: /Co potřebujete vyrobit/ })
      .fill(
        "Testovací poptávka na individuální díl podle referenční fotografie.",
      );
    await page.getByLabel("Jméno *").fill("E2E Browser Test");
    await page.getByLabel("E-mail *").fill("assisted-browser@example.test");
    await page.locator('input[type="file"][accept*="image"]').setInputFiles({
      name: "assisted-reference.png",
      mimeType: "image/png",
      buffer: photo,
    });
    await expect(page.getByText("assisted-reference.png")).toBeVisible();
    await page.locator('input[type="checkbox"]').first().check();

    const createdResponse = page.waitForResponse(
      (response) =>
        response.url() === `${apiUrl}/quote-requests` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Odeslat k lidskému posouzení" })
      .click();
    const response = await createdResponse;
    expect(response.status()).toBe(201);
    const created = (await response.json()) as {
      publicReference: string;
      requestId: string;
      requestToken: string;
    };
    await expect(
      page.getByText("PŘÍLOHY ČEKAJÍ", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: `Poptávka ${created.publicReference} je uložená.`,
      }),
    ).toBeVisible();
    expect(failedFirstPut).toBe(true);
    expect(createCalls).toBe(1);

    const detailUrl = `${apiUrl}/quote-requests/${created.requestId}`;
    const headers = { Authorization: `Bearer ${created.requestToken}` };
    const beforeRetry = await request.get(detailUrl, { headers });
    expect(beforeRetry.status()).toBe(200);
    expect(await beforeRetry.json()).toMatchObject({
      requestId: created.requestId,
      publicReference: created.publicReference,
      attachments: [],
    });

    await page
      .getByRole("button", { name: "Zkusit stejný požadavek znovu" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Děkujeme. Podklady předáme k lidskému posouzení.",
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText(`Reference ${created.publicReference}`),
    ).toBeVisible();
    expect(createCalls).toBe(1);

    const afterRetry = await request.get(detailUrl, { headers });
    expect(afterRetry.status()).toBe(200);
    const detail = (await afterRetry.json()) as {
      attachments: Array<{
        deleteAfter: string;
        mediaType: string;
        uploadedAt: string;
      }>;
      attribution: { source: string };
      photoPublicationConsentGranted: boolean;
      publicReference: string;
      requestId: string;
      status: string;
    };
    expect(detail.requestId).toBe(created.requestId);
    expect(detail.publicReference).toBe(created.publicReference);
    expect(detail.status).toBe("NEW");
    expect(detail.attribution.source).toBe("no-file");
    expect(detail.photoPublicationConsentGranted).toBe(false);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]?.mediaType).toBe("image/png");
    expect(Date.parse(detail.attachments[0]!.deleteAfter)).toBeGreaterThan(
      Date.parse(detail.attachments[0]!.uploadedAt),
    );
  });

  test("carries a fit-sensitive quote into one assisted request", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    let createCalls = 0;
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        outgoing.url() === `${apiUrl}/quote-requests`
      ) {
        createCalls += 1;
      }
    });

    await page.goto("/");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni soubor sem").click();
    await (await chooserPromise).setFiles(cubePath);
    const proceed = page.getByRole("button", {
      name: "Nahrát a pokračovat ke konfiguraci",
    });
    await expect(proceed).toBeEnabled({ timeout: 120_000 });
    await proceed.click();
    await expect(page).toHaveURL(/\/objednavka/, { timeout: 120_000 });
    await page
      .getByRole("checkbox", { name: /Díl musí přesně lícovat/ })
      .check();
    await page.getByRole("button", { name: "Uložit a přepočítat" }).click();
    await expect(
      page.getByText("PŘÍMÁ KALKULACE ZASTAVENA", { exact: true }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByText(/Lícovaný díl vyžaduje zkušební kus/),
    ).toBeVisible();

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
    await expect(page.getByText("KONTEXT POPTÁVKY")).toBeVisible();
    const handoff = await page.evaluate(() => {
      const raw = sessionStorage.getItem("taven:assisted-quote-handoff:v1");
      return raw
        ? (JSON.parse(raw) as {
            handoffToken: string;
            reasons: string[];
          })
        : null;
    });
    expect(handoff?.reasons).toContain("FIT_SENSITIVE");
    if (!handoff?.handoffToken) {
      throw new Error("Fit-sensitive handoff capability was not stored");
    }

    await page.getByLabel("Jméno *").fill("E2E Fit Test");
    await page.getByLabel("E-mail *").fill("fit-browser@example.test");
    await page.locator('input[type="checkbox"]').first().check();
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url() === `${apiUrl}/quote-requests` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Odeslat k lidskému posouzení" })
      .click();
    const response = await createdResponse;
    expect(response.status()).toBe(201);
    expect(
      (
        response.request().postDataJSON() as {
          automaticQuoteHandoffToken?: string;
        }
      ).automaticQuoteHandoffToken,
    ).toBe(handoff.handoffToken);
    const created = (await response.json()) as {
      publicReference: string;
      requestId: string;
      requestToken: string;
    };
    await expect(
      page.getByRole("heading", {
        name: "Děkujeme. Podklady předáme k lidskému posouzení.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText(`Reference ${created.publicReference}`),
    ).toBeVisible();
    expect(createCalls).toBe(1);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("taven:assisted-quote-handoff:v1"),
      ),
    ).toBeNull();

    const detailResponse = await request.get(
      `${apiUrl}/quote-requests/${created.requestId}`,
      { headers: { Authorization: `Bearer ${created.requestToken}` } },
    );
    expect(detailResponse.status()).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      requestId: created.requestId,
      publicReference: created.publicReference,
      status: "NEW",
      attribution: { source: "automatic-quote" },
    });
  });

  test("routes a painted 3MF to one assisted request without an automatic session", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const painted3mf = zipSync({
      "3D/3dmodel.model": readFileSync(
        path.join(paintedFixturePath, "3D/3dmodel.model"),
      ),
      "[Content_Types].xml": readFileSync(
        path.join(paintedFixturePath, "[Content_Types].xml"),
      ),
      "_rels/.rels": readFileSync(path.join(paintedFixturePath, "_rels/.rels")),
    });
    let createCalls = 0;
    let automaticSessionCreates = 0;
    page.on("request", (outgoing) => {
      if (outgoing.method() !== "POST") return;
      if (outgoing.url() === `${apiUrl}/quote-requests`) createCalls += 1;
      if (outgoing.url() === `${apiUrl}/automatic-quote-sessions`)
        automaticSessionCreates += 1;
    });

    await page.goto("/");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni soubor sem").click();
    const fileChooser = await chooserPromise;
    await fileChooser.setFiles({
      name: "painted-two-material.3mf",
      mimeType: "model/3mf",
      buffer: Buffer.from(painted3mf),
    });
    await expect(
      page.getByRole("heading", {
        name: "Tento soubor potřebuje ruční posouzení.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText(/Barevný nebo vícemateriálový 3MF/),
    ).toBeVisible();
    expect(automaticSessionCreates).toBe(0);

    await page
      .getByRole("link", { name: "Přejít na individuální poptávku" })
      .click();
    await expect(page).toHaveURL(/\/poptavka\?source=blocked-3mf/);
    await expect(
      page.getByRole("textbox", { name: /Co potřebujete vyrobit/ }),
    ).toHaveValue(/3MF model s více materiály nebo barvami/);
    await page.getByLabel("Jméno *").fill("E2E Painted Test");
    await page.getByLabel("E-mail *").fill("painted-browser@example.test");
    await page.locator('input[type="checkbox"]').first().check();
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url() === `${apiUrl}/quote-requests` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Odeslat k lidskému posouzení" })
      .click();
    const response = await createdResponse;
    expect(response.status()).toBe(201);
    const created = (await response.json()) as {
      publicReference: string;
      requestId: string;
      requestToken: string;
    };
    await expect(
      page.getByRole("heading", {
        name: "Děkujeme. Podklady předáme k lidskému posouzení.",
      }),
    ).toBeVisible();
    expect(createCalls).toBe(1);
    expect(automaticSessionCreates).toBe(0);

    const detailResponse = await request.get(
      `${apiUrl}/quote-requests/${created.requestId}`,
      { headers: { Authorization: `Bearer ${created.requestToken}` } },
    );
    expect(detailResponse.status()).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      requestId: created.requestId,
      publicReference: created.publicReference,
      status: "NEW",
      attribution: { source: "blocked-3mf" },
      attachments: [],
    });
  });
});
