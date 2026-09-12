import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("Accessibility and Responsive Viewports", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  const routes = [
    { path: "/", name: "Homepage" },
    { path: "/poptavka", name: "Assisted Quote Request" },
    { path: "/vop", name: "Terms and Conditions (VOP)" },
    { path: "/jak-to-funguje", name: "How It Works" },
    { path: "/cenik", name: "Pricing" },
  ];

  for (const { path, name } of routes) {
    test(`accessibility scan on ${name} (${path}) finds zero critical or serious violations`, async ({
      page,
    }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const accessibilityScanResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const criticalOrSerious = accessibilityScanResults.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );

      expect(
        criticalOrSerious,
        `Found ${criticalOrSerious.length} critical/serious a11y violations on ${path}:\n` +
          JSON.stringify(criticalOrSerious, null, 2),
      ).toEqual([]);
    });
  }

  test("accessibility scan on /objednavka configurator finds zero critical or serious violations", async ({
    page,
  }) => {
    // Seed quote session in sessionStorage
    const sessionId = "session-a11y-001";
    await page.goto("/");
    await page.evaluate((sessId) => {
      window.sessionStorage.setItem(
        "taven:automatic-quote-session:v1",
        JSON.stringify({
          sessionId: sessId,
          sessionToken: `token-${sessId}`,
          filename: "cube.stl",
          publicReference: "TAV-A11Y-001",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      );
    }, sessionId);

    await page.goto("/objednavka");
    await page.waitForLoadState("networkidle");

    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const criticalOrSerious = accessibilityScanResults.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );

    expect(criticalOrSerious).toEqual([]);
  });

  test("mobile viewport (375x667) has no horizontal scroll overflow on key pages", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    for (const { path } of routes) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      // Verify no horizontal overflow beyond viewport width
      const hasHorizontalScroll = await page.evaluate(() => {
        return (
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth
        );
      });

      expect(
        hasHorizontalScroll,
        `Page ${path} exhibits horizontal scroll overflow on mobile viewport (375px)`,
      ).toBe(false);
    }
  });

  test("keyboard navigation allows tab traversal through form controls on /poptavka", async ({
    page,
  }) => {
    await page.goto("/poptavka");
    await page.waitForLoadState("networkidle");

    const descriptionField = page.getByRole("textbox", {
      name: /Co potřebujete vyrobit/,
    });
    await descriptionField.focus();
    await expect(descriptionField).toBeFocused();

    // Press Tab to navigate to the purpose textarea
    await page.keyboard.press("Tab");
    const purposeField = page.getByRole("textbox", { name: "Účel dílu" });
    await expect(purposeField).toBeFocused();

    // Press Tab to navigate to width dimension input
    await page.keyboard.press("Tab");
    const widthField = page.getByLabel("Šířka X (mm)");
    await expect(widthField).toBeFocused();

    // Press Tab to navigate to depth dimension input
    await page.keyboard.press("Tab");
    const depthField = page.getByLabel("Hloubka Y (mm)");
    await expect(depthField).toBeFocused();
  });
});
