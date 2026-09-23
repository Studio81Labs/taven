import { expect, test, type Page } from "@playwright/test";

const operator = {
  operatorId: "00000000-0000-0000-0000-000000000001",
  role: "OPERATOR",
  nodeIds: ["00000000-0000-0000-0000-000000000002"],
  permissions: [
    "operations:read",
    "operations:write",
    "quotes:write",
    "payments:write",
  ],
  authenticationMethod: "DEVELOPMENT_PASSWORD",
};

async function mockAuth(
  page: Page,
  initial: typeof operator | null,
  logoutFailures = 0,
  initialSessionStatus = 401,
): Promise<{ logoutHeaders: () => string | undefined }> {
  let active = initial;
  let logoutCsrf: string | undefined;
  await page.route("**/admin/auth/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === "/admin/auth/methods") {
      await route.fulfill({ json: { methods: ["EMAIL_PASSWORD"] } });
    } else if (pathname === "/admin/auth/session" && method === "GET") {
      await route.fulfill(
        active
          ? { json: { operator: active, csrfToken: "csrf-for-test" } }
          : { status: initialSessionStatus, json: { message: "Unavailable" } },
      );
    } else if (pathname === "/admin/auth/session" && method === "DELETE") {
      logoutCsrf = route.request().headers()["x-csrf-token"];
      if (logoutFailures > 0) {
        logoutFailures -= 1;
        await route.fulfill({ status: 503, json: { message: "unavailable" } });
        return;
      }
      active = null;
      await route.fulfill({ status: 204, body: "" });
    } else if (pathname === "/admin/auth/login" && method === "POST") {
      active = operator;
      await route.fulfill({
        json: { operator: active, csrfToken: "csrf-for-test" },
      });
    } else {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  return { logoutHeaders: () => logoutCsrf };
}

test("fails closed, signs in, and sends CSRF on logout", async ({ page }) => {
  const auth = await mockAuth(page, null);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Přihlášení operátora" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Hlavní navigace" }),
  ).toHaveCount(0);
  await page.getByLabel("E-mail").fill("operator@example.test");
  await page.getByLabel("Heslo").fill("test-password");
  await page.getByRole("button", { name: "Přihlásit se" }).click();
  await expect(
    page.getByRole("navigation", { name: "Hlavní navigace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(
    page.getByRole("navigation", { name: "Hlavní navigace" }),
  ).toHaveCount(0);
  expect(auth.logoutHeaders()).toBe("csrf-for-test");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
});

test("failed server logout stays visible and can be retried", async ({
  page,
}) => {
  await mockAuth(page, operator, 1);
  await page.goto("/");
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.getByRole("alert")).toContainText("Odhlášení se nezdařilo");
  await expect(
    page.getByRole("navigation", { name: "Hlavní navigace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(
    page.getByRole("heading", { name: "Přihlášení operátora" }),
  ).toBeVisible();
});

test("node-free administrator cannot see operational routes", async ({
  page,
}) => {
  await mockAuth(page, {
    ...operator,
    role: "ADMIN",
    nodeIds: [],
    permissions: ["legal:read", "legal:write", "audit:read"],
  });
  await page.goto("/objednavky");
  await expect(
    page.getByRole("heading", { name: "Provozní uzel není dostupný" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Hlavní navigace" }),
  ).toHaveCount(0);
});

test("revoked node grant returns to a safe login state", async ({ page }) => {
  await mockAuth(page, null, 0, 403);
  await page.goto("/objednavky");
  await expect(
    page.getByRole("heading", { name: "Přihlášení operátora" }),
  ).toBeVisible();
  await expect(
    page.getByText("Účet nemá platný provozní přístup.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Hlavní navigace" }),
  ).toHaveCount(0);
});
