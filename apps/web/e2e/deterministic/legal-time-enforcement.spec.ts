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
    // Verify the immutable server-selected revision, not the bundled fallback.
    await expect(page).toHaveTitle(/Test terms/);
    const heading = page.getByRole("heading", {
      name: "Test terms",
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

  test("SSR serves the rotated exact revision and retains pinned historical text", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalRevisionVersion: 2 },
    });
    const current = await page.goto("/vop");
    expect(await current?.text()).toContain("Test terms v2");
    await expect(
      page.getByRole("heading", { name: "Test terms v2", level: 1 }),
    ).toBeVisible();

    const historical = await page.goto(
      `/vop?revision=terms-test-v1&contentHash=${"a".repeat(64)}`,
    );
    expect(await historical?.text()).toContain("Test terms");
    await expect(page.getByText("HISTORICKÉ · terms-test-v1")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Test terms", level: 1 }),
    ).toBeVisible();

    await page.goto(
      `/vop?revision=terms-test-v1&contentHash=${"9".repeat(64)}`,
    );
    await expect(
      page.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
    ).toBeVisible();
  });

  test("a slow successful availability read still enables the approved journey", async ({
    page,
  }) => {
    await page.route("**/legal-documents/availability", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });

    await page.goto("/");
    await expect(
      page
        .getByRole("navigation", { name: "Hlavní navigace" })
        .getByRole("link", { name: "Nahrát model" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("a slow successful immutable revision read still renders approved text", async ({
    page,
  }) => {
    let revisionRequests = 0;
    await page.route("**/legal-documents/terms/revisions/**", async (route) => {
      revisionRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });

    await page.goto("/");
    await page.getByRole("link", { name: "Obchodní podmínky" }).click();
    await expect(
      page.getByRole("heading", { name: "Test terms", level: 1 }),
    ).toBeVisible({ timeout: 10_000 });
    expect(revisionRequests).toBeGreaterThan(0);
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
      { path: "/vop", title: "Test terms" },
      { path: "/reklamace", title: "Test claims" },
      { path: "/ochrana-soukromi", title: "Test privacy" },
      { path: "/zakazany-obsah", title: "Test prohibitedContent" },
      { path: "/uchovani-dat", title: "Test retention" },
      { path: "/fotografie-a-duvernost", title: "Test photoConsent" },
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
