import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("public presentation and legal reading", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("portfolio stays honestly empty without filters or placeholder photos", async ({
    page,
  }) => {
    await page.goto("/ukazky");
    await expect(
      page.getByRole("heading", { name: "Portfolio je zatím prázdné" }),
    ).toBeVisible();
    await expect(page.locator(".portfolio-card")).toHaveCount(0);
    await expect(page.locator(".portfolio-filters")).toHaveCount(0);
    await expect(page.locator("main img")).toHaveCount(0);
  });

  test("numbered design layouts preserve their desktop composition", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const upload = await page.locator(".landing-hero__upload").boundingBox();
    const sidebar = await page.locator(".landing-hero__side").boundingBox();
    expect(upload).not.toBeNull();
    expect(sidebar).not.toBeNull();
    expect(upload!.x + upload!.width).toBeLessThan(sidebar!.x);
    await expect(page.locator(".landing-step-grid > li")).toHaveCount(3);
    await expect(page.locator(".landing-responsibility > li")).toHaveCount(4);

    await page.goto("/jak-to-funguje");
    await expect(page.locator(".process-ledger > li")).toHaveCount(7);
    await page.goto("/cenik");
    await expect(page.locator(".pricing-factors > li")).toHaveCount(7);
    await page.goto("/kontakt");
    await expect(page.locator(".contact-card")).toHaveCount(3);
  });

  test("legal contents navigate to exact rendered sections while draft remains unavailable", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { legalStatus: "draft" },
    });
    await page.goto("/vop");
    const contents = page.getByRole("navigation", { name: "Obsah dokumentu" });
    const firstLink = contents.getByRole("link").first();
    const target = await firstLink.getAttribute("href");
    expect(target).toMatch(/^#legal-section-1$/);
    await firstLink.click();
    await expect(page.locator(target!)).toBeInViewport();
    await expect(
      page.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
    ).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
  });

  test("public routes remain readable and accessible at design viewports", async ({
    page,
  }) => {
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of [
        "/",
        "/jak-to-funguje",
        "/cenik",
        "/kontakt",
        "/ukazky",
        "/vop",
      ]) {
        await page.goto(route);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow, `${route} at ${width}px`).toBeLessThanOrEqual(0);
      }
    }

    for (const route of ["/ukazky", "/kontakt", "/vop"]) {
      await page.goto(route);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(
        result.violations.filter(
          (violation) =>
            violation.impact === "critical" || violation.impact === "serious",
        ),
        route,
      ).toEqual([]);
    }
  });
});
