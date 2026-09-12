import { test, expect } from "@playwright/test";

test.describe("Legal Time & Availability Enforcement", () => {
  test.beforeEach(async ({ request }) => {
    // Reset mock backend state before each test
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("approved document with past UTC effective instant is active and server-verified", async ({
    page,
  }) => {
    await page.goto("/vop");
    // Verify title and content rendered
    await expect(page).toHaveTitle(/Obchodní podmínky/);
    const heading = page.getByRole("heading", {
      name: "Obchodní podmínky",
      level: 1,
    });
    await expect(heading).toBeVisible();

    // Verify draft warning banner is NOT visible when server verified
    await expect(
      page.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
    ).not.toBeVisible();
    await expect(
      page.getByText("Tato stránka není právní dokument"),
    ).not.toBeVisible();
  });

  test("backend legal gate 503 failure fails closed and displays draft placeholder", async ({
    page,
    request,
  }) => {
    // Simulate backend 503 failure
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalStatus: "error503" },
    });

    await page.goto("/vop");
    await expect(page).toHaveTitle(/Obchodní podmínky/);

    // Draft warning MUST be displayed because verification failed closed
    await expect(
      page.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
    ).toBeVisible();
    await expect(
      page.getByText("Tato stránka není právní dokument"),
    ).toBeVisible();
  });

  test("client clock skew into future cannot activate unapproved documents", async ({
    page,
    request,
  }) => {
    // Simulate backend reporting document as draft
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalStatus: "draft" },
    });

    // Skew browser clock far into the future (year 2035)
    await page.addInitScript(() => {
      const futureTime = new Date("2035-01-01T00:00:00.000Z").getTime();
      Date.now = () => futureTime;
    });

    await page.goto("/vop");
    // Even with future client clock, server reports draft, so it must fail closed
    await expect(
      page.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
    ).toBeVisible();
  });

  test("all required legal document routes render cleanly", async ({
    page,
  }) => {
    const routes = [
      { path: "/vop", title: "Obchodní podmínky" },
      { path: "/reklamace", title: "Reklamační řád" },
      { path: "/ochrana-soukromi", title: "Zásady ochrany soukromí" },
      { path: "/zakazany-obsah", title: "Pravidla pro zakázaný obsah" },
      { path: "/uchovani-dat", title: "Pravidla uchování dat" },
      {
        path: "/fotografie-a-duvernost",
        title: "Fotografie a důvěrnost modelů",
      },
    ];

    for (const route of routes) {
      await page.goto(route.path);
      await expect(
        page.getByRole("heading", { name: route.title, level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
      ).not.toBeVisible();
    }
  });
});
