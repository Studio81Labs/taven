import { test, expect } from "@playwright/test";

test.describe("Default-Closed Architectural Safeguards", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("unapproved legal documents fail closed by redirecting /objednavka to /cenik with explanation", async ({
    page,
    request,
  }) => {
    // Set legal status to unapproved/draft on backend
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalStatus: "draft" },
    });

    // Attempt direct navigation to configurator /objednavka
    await page.goto("/objednavka");

    // Must be redirected to /cenik by automatic pricing gate middleware
    await expect(page).toHaveURL(/\/cenik/);
    await expect(
      page.getByRole("heading", {
        name: "Cena podle skutečného tisku",
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Automatická kalkulace zatím není veřejně dostupná. Čeká na schválené cenové vstupy.",
      ),
    ).toBeVisible();

    // Navigation item must indicate quote is waiting
    await expect(
      page.getByText("Kalkulace čeká", { exact: true }),
    ).toBeVisible();

    // Legal page /vop must show draft warning banner
    await page.goto("/vop");
    await expect(
      page.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
    ).toBeVisible();
  });

  test("missing session storage on direct payment access redirects safely without exposing data", async ({
    page,
  }) => {
    // Navigate directly to payment success without session storage
    await page.goto(
      "/checkout/payment/success?paymentId=pay-orphan&sessionId=sess-orphan",
    );

    // Must fail closed with error notice and restart option
    await expect(
      page.getByText(
        "Uložená relace objednávky není v tomto prohlížeči dostupná.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Na hlavní stránku" }),
    ).toBeVisible();
  });
});
