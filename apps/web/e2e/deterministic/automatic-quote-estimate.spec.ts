import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

function estimateResponse(totalMinor: number) {
  return {
    priceListRevision: "fixture-price-list-v1",
    price: {
      kind: "ROUGH_ESTIMATE",
      currency: "CZK",
      netAmountMinor: totalMinor,
      vatAmountMinor: 0,
      totalMinor,
      vatRateBasisPoints: 0,
      taxRegime: "NON_VAT_PAYER",
      components: [
        {
          id: "base-cost",
          kind: "ITEM_PRODUCTION",
          amountMinor: totalMinor,
          label: "Test estimate",
        },
      ],
    },
    assumptions: {
      material: "PLA",
      quality: "STANDARD",
      infillPreset: "STANDARD",
      quantity: 1,
      printConfigRevisionId: "00000000-0000-4000-8000-000000000001",
      referenceProfileId: "00000000-0000-4000-8000-000000000002",
      delivery: "NOT_FINALIZED",
    },
  };
}

test.describe("Automatic estimate concurrency", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Nahraj model/i, level: 1 }),
    ).toBeVisible();
  });

  test("keeps the newest replacement estimate after an older response is delayed", async ({
    page,
  }) => {
    let requestCount = 0;
    await page.route("**/automatic-quote-estimates", async (route) => {
      requestCount += 1;
      const requestIndex = requestCount;
      if (requestIndex === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            estimateResponse(requestIndex === 1 ? 11100 : 22200),
          ),
        });
      } catch {
        // The first request is expected to be aborted when its file is replaced.
      }
    });

    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
    await expect.poll(() => requestCount, { timeout: 5_000 }).toBe(1);
    await page.getByRole("button", { name: "Jiný soubor" }).click();
    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);

    await expect(page.getByText(/222.*Kč/)).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => requestCount, { timeout: 5_000 }).toBe(2);
    await expect(page.getByText(/111.*Kč/)).not.toBeVisible();
  });

  test("keeps estimate failures unavailable until an explicit retry", async ({
    page,
  }) => {
    let requestCount = 0;
    await page.route("**/automatic-quote-estimates", async (route) => {
      requestCount += 1;
      if (requestCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ statusCode: 503 }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(estimateResponse(33300)),
      });
    });

    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
    await expect(
      page.getByText("Rychlý odhad teď není k dispozici.", { exact: false }),
    ).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => requestCount).toBe(1);

    await page.getByRole("button", { name: "Zkusit odhad znovu" }).click();
    await expect(page.getByText(/333.*Kč/)).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => requestCount).toBe(2);
  });

  test("keeps selected-quality server pricing ahead of a late STANDARD baseline", async ({
    page,
  }) => {
    let releaseBaseline!: () => void;
    let markStarted!: () => void;
    let markSettled!: () => void;
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const baselineStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const baselineSettled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    let baselineBody: { quality?: string } | undefined;
    await page.route("**/automatic-quote-estimates", async (route) => {
      baselineBody = route.request().postDataJSON();
      markStarted();
      await baselineGate;
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(estimateResponse(99900)),
        });
      } catch {
        // Navigation may abort the provisional request after the quote starts.
      } finally {
        markSettled();
      }
    });

    try {
      await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
      await baselineStarted;
      expect(baselineBody?.quality).toBe("STANDARD");
      await page
        .getByRole("button", {
          name: "Nahrát a pokračovat ke konfiguraci",
        })
        .click();
      await expect(page).toHaveURL(/\/objednavka/);

      const price = page.locator(".price-summary .total-price");
      const qualitySelect = page.getByRole("combobox", { name: "Kvalita" });
      for (const [
        quality,
        revisionId,
        totalMinor,
        bindingMinor,
        visiblePrice,
      ] of [
        [
          "STANDARD",
          "00000000-0000-4000-8000-000000000001",
          35000,
          43900,
          "439,00",
        ],
        [
          "DRAFT",
          "00000000-0000-4000-8000-000000000003",
          21780,
          30680,
          "306,80",
        ],
        [
          "FINE",
          "00000000-0000-4000-8000-000000000004",
          50820,
          59720,
          "597,20",
        ],
      ] as const) {
        await qualitySelect.selectOption(quality);
        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().includes("/configuration") &&
            response.request().method() === "PUT",
        );
        const preparePromise = page.waitForResponse(
          (response) =>
            response.url().includes("/prepare") &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Uložit a přepočítat" }).click();
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        expect(response.request().postDataJSON().items[0]).toMatchObject({
          printConfigRevisionId: revisionId,
        });
        const quote = await response.json();
        expect(quote.items[0]).toMatchObject({
          quality,
          printConfigRevisionId: revisionId,
        });
        expect(quote.roughEstimate.totalMinor).toBe(totalMinor);
        const prepared = await preparePromise;
        expect(prepared.status()).toBe(200);
        expect((await prepared.json()).bindingQuote.totalMinor).toBe(
          bindingMinor,
        );
        await expect(price).toContainText(visiblePrice);
        await expect(qualitySelect).toHaveValue(quality);
      }

      releaseBaseline();
      await baselineSettled;
      await expect(price).toContainText("597,20");
      await expect(page.getByText("999,00 Kč")).not.toBeVisible();
    } finally {
      releaseBaseline();
    }
  });
});
