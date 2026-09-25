import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cubePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:4175/__test/reset");
});

test("keeps the parsed model above accessible configuration controls across responsive layouts", async ({
  page,
}, testInfo) => {
  await page.goto("/objednavka");
  await page
    .locator('input[type="file"][aria-label="Vybrat model STL nebo 3MF"]')
    .setInputFiles(cubePath);
  await page.getByRole("button", { name: "Nahrát a zkontrolovat" }).click();

  await expect(page).toHaveURL(/\/objednavka/);
  const canvas = page.getByRole("img", { name: /Otočný náhled modelu/ });
  await expect(canvas).toBeVisible();
  await expect(
    page.getByText("20 mm × 20 mm × 20 mm", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "NÁLEZY K MODELU" }),
  ).toBeVisible();

  await canvas.evaluate((element) => {
    element.dataset.testMount = "original";
  });
  await canvas.focus();
  await page.keyboard.press("ArrowRight");

  const quality = page.getByRole("group", { name: /Kvalita/ });
  await quality.getByRole("radio", { name: "Jemná" }).check();
  await expect(quality.getByRole("radio", { name: "Jemná" })).toBeChecked();
  await expect(canvas).toHaveAttribute("data-test-mount", "original");

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);

  for (const width of [320, 375, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(canvas).toBeVisible();
    const layout = await page.evaluate(() => {
      const workspace = document.querySelector(".order-workspace--quote");
      const context = document.querySelector(".order-context--configurator");
      if (!workspace || !context) return undefined;
      const left = workspace.getBoundingClientRect();
      const right = context.getBoundingClientRect();
      return {
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        leftX: left.x,
        leftBottom: left.bottom,
        rightX: right.x,
        rightTop: right.top,
      };
    });
    expect(layout, `two-pane layout at ${width}px`).toBeDefined();
    expect(
      layout!.overflow,
      `horizontal overflow at ${width}px`,
    ).toBeLessThanOrEqual(0);
    if (width <= 768) {
      expect(
        layout!.rightTop,
        `model above controls at ${width}px`,
      ).toBeGreaterThanOrEqual(layout!.leftBottom - 1);
    } else {
      expect(
        layout!.rightX,
        `controls beside model at ${width}px`,
      ).toBeGreaterThan(layout!.leftX);
    }
    if ([390, 768, 1440].includes(width)) {
      await testInfo.attach(`configurator-${width}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
  }

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Konfigurace / cena" }),
  ).toBeVisible();
  await expect(canvas).toHaveCount(0);
  await expect(
    page.getByText(/Místní náhled souboru není k dispozici/),
  ).toBeVisible();
});
