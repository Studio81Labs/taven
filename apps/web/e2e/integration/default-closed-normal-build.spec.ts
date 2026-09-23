import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const enabled = process.env.NORMAL_BUILD_CLOSED_TEST === "true";
const apiUrl = process.env.INTEGRATION_API_URL ?? "http://127.0.0.1:4175";
const cubePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

test.describe("Normal default-closed build", () => {
  test.skip(!enabled, "Requires the independently launched normal web build");

  test("keeps upload-to-quote and direct checkout closed with draft content", async ({
    page,
    request,
  }) => {
    await request.post(`${apiUrl}/__test/reset`);
    await request.post(`${apiUrl}/__test/state`, {
      data: { legalStatus: "draft" },
    });
    let automaticSessionCreates = 0;
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        outgoing.url() === `${apiUrl}/automatic-quote-sessions`
      ) {
        automaticSessionCreates += 1;
      }
    });

    const homeResponse = await page.goto("/");
    expect(await homeResponse?.text()).toContain("automaticQuoteEnabled:false");
    await expect(
      page.getByText("Kalkulace čeká", { exact: true }),
    ).toBeVisible();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Přetáhni soubor sem").click();
    await (await chooserPromise).setFiles(cubePath);
    await expect(
      page.getByRole("button", { name: "Kalkulace čeká na schválení" }),
    ).toBeDisabled();
    expect(automaticSessionCreates).toBe(0);

    await page.goto("/objednavka");
    await expect(page).toHaveURL(/\/cenik/);
    await expect(
      page.getByText(
        "Automatická kalkulace zatím není veřejně dostupná. Čeká na schválené cenové vstupy.",
      ),
    ).toBeVisible();
    expect(automaticSessionCreates).toBe(0);

    await page.goto("/vop");
    await expect(
      page.getByText("NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI"),
    ).toBeVisible();
  });
});
