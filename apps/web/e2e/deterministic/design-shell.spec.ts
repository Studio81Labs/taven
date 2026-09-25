import { expect, test } from "@playwright/test";

test.describe("public and application shells", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("mobile navigation opens, restores focus on Escape, and closes after navigation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const menu = page.getByRole("button", { name: "01–04 MENU" });
    const navigation = page.getByRole("navigation", {
      name: "Hlavní navigace",
    });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(navigation).toBeHidden();

    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(navigation).toBeVisible();
    const firstLink = navigation.getByRole("link", {
      name: /Jak to funguje/,
    });
    await expect(firstLink).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(navigation).toBeHidden();
    await expect(menu).toBeFocused();

    await menu.click();
    await navigation.getByRole("link", { name: /Ceník/ }).click();
    await expect(page).toHaveURL(/\/cenik$/);
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(navigation).toBeHidden();
  });

  test("public and application shells retain skip links, real seller identity, and legal navigation", async ({
    page,
  }) => {
    for (const route of ["/", "/poptavka", "/objednavka"]) {
      await page.goto(route);
      const skip = page.getByRole("link", { name: "Přeskočit na obsah" });
      await skip.focus();
      await expect(skip).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#hlavni-obsah")).toBeFocused();

      const footer = page.locator("footer");
      await expect(footer).toContainText("Studio81 Labs, s.r.o.");
      const identityFont = await footer
        .locator("address")
        .evaluate((element) => getComputedStyle(element).fontFamily);
      expect(identityFont).toContain("IBM Plex Mono");
      await expect(
        footer.getByRole("navigation", { name: "Právní informace" }),
      ).toBeVisible();
    }
    await expect(page.locator(".title-block-footer")).toHaveAttribute(
      "data-compact",
      "true",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".application-shell__mobile-step")).toHaveText(
      "01 SOUBOR / 05",
    );
  });

  test("shells fit narrow and desktop widths without horizontal overflow", async ({
    page,
  }) => {
    for (const width of [320, 375, 390, 768, 960, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      for (const route of ["/", "/vop", "/poptavka", "/objednavka"]) {
        await page.goto(route);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow, `${route} at ${width}px`).toBeLessThanOrEqual(0);
      }
    }
  });
});
