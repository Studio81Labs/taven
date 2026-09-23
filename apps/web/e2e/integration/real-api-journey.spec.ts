import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const INTEGRATION_API_URL =
  process.env.INTEGRATION_API_URL || "https://api-staging.taven.cz";
const integrationTest = process.env.INTEGRATION_TEST === "true";
const requireCheckout = process.env.INTEGRATION_REQUIRE_CHECKOUT === "true";
const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

test.describe("Real API Integration Journey", () => {
  test.skip(
    !integrationTest,
    "Skipped unless INTEGRATION_TEST=true environment variable is present",
  );

  test("runs a browser upload through the live API and estimate path", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
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
    if (requireCheckout) {
      await expect(proceed).toBeEnabled();
      await proceed.click();
      await expect(page).toHaveURL(/\/objednavka/, { timeout: 120_000 });
      await expect(
        page.getByRole("heading", { name: "Nastavte výrobu.", level: 2 }),
      ).toBeVisible();
    } else if (await approvalGate.isVisible()) {
      await expect(approvalGate).toBeDisabled();
    }
  });
});
