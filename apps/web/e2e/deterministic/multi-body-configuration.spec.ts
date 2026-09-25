import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

test("assigns inspected bodies to distinct configuration items", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4175/__test/reset");
  await request.post("http://127.0.0.1:4175/__test/state", {
    data: { modelBodyIds: ["body-1", "body-2"] },
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
  await page
    .getByRole("button", { name: "Nahrát a pokračovat ke konfiguraci" })
    .click();
  await expect(page).toHaveURL(/\/objednavka/);

  const secondBody = page.getByRole("combobox", {
    name: "Položka pro body-2 v Soubor 1 · STL",
  });
  await expect(secondBody).toHaveValue("-1");
  await page.getByRole("button", { name: "Přidat položku" }).click();
  await secondBody.selectOption({ label: "Položka 2" });
  await expect(page.getByText("POLOŽKA 2", { exact: true })).toBeVisible();
  const secondItem = page.locator("section.item-configuration").filter({
    has: page.getByText("POLOŽKA 2", { exact: true }),
  });
  await secondItem.getByRole("radio", { name: "Jemná" }).check();
  await secondItem.getByRole("spinbutton", { name: "Jiné" }).fill("2");

  const configurationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/configuration"),
  );
  await page.getByRole("button", { name: "Uložit a přepočítat" }).click();
  const configured = await configurationResponse;
  expect(configured.status()).toBe(200);
  expect(configured.request().postDataJSON().items).toMatchObject([
    {
      ordinal: 0,
      bodyIds: ["body-1"],
      quantity: 1,
      printConfigRevisionId: "00000000-0000-4000-8000-000000000001",
    },
    {
      ordinal: 1,
      bodyIds: ["body-2"],
      quantity: 2,
      printConfigRevisionId: "00000000-0000-4000-8000-000000000004",
    },
  ]);
  const session = await configured.json();
  expect(session.items).toMatchObject([
    { ordinal: 0, bodyIds: ["body-1"], quality: "STANDARD", quantity: 1 },
    { ordinal: 1, bodyIds: ["body-2"], quality: "FINE", quantity: 2 },
  ]);
  expect(session.items[0].id).not.toBe(session.items[1].id);
});
