import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);

test.describe("Rendered configuration and delivery", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
    await page
      .getByRole("button", { name: "Nahrát a pokračovat ke konfiguraci" })
      .click();
    await expect(page).toHaveURL(/\/objednavka/);
  });

  test("sends the selected item quantity and displays its server price", async ({
    page,
  }) => {
    const five = page.getByRole("button", {
      name: "5 ks 1 400,00 Kč celkem",
    });
    await expect(five).toBeVisible();
    await five.click();
    await expect(five).toHaveClass(/selected/);
    await expect(page.getByRole("spinbutton", { name: "Jiné" })).toHaveValue(
      "5",
    );

    const configurationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/configuration"),
    );
    const prepareResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/prepare"),
    );
    await page.getByRole("button", { name: "Uložit a přepočítat" }).click();
    const configured = await configurationResponse;
    expect(configured.status()).toBe(200);
    expect(configured.request().postDataJSON().items[0].quantity).toBe(5);
    expect((await configured.json()).roughEstimate.totalMinor).toBe(140000);
    const prepared = await prepareResponse;
    expect(prepared.status()).toBe(200);
    expect((await prepared.json()).bindingQuote.totalMinor).toBe(148900);
    await expect(page.locator(".checkout-summary__total strong")).toContainText(
      "1 489,00",
    );
  });

  test("offers standard production after the requested express plan fails", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { expressFailureOnce: true },
    });
    await page
      .getByRole("checkbox", { name: "Expresní výroba pro celou objednávku" })
      .check();
    const expressResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/express"),
    );
    const failedPrepareResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/prepare"),
    );
    await page
      .getByRole("button", { name: "Ověřit dopravu a závaznou cenu" })
      .click();
    expect((await (await expressResponse).json()).express.requested).toBe(true);
    const failed = await failedPrepareResponse;
    expect(failed.status()).toBe(200);
    expect(await failed.json()).toMatchObject({
      phase: "HANDOFF_REQUIRED",
      checkoutReady: false,
      bindingQuote: null,
      handoff: { reasons: ["EXPRESS_INELIGIBLE"] },
    });
    await expect(
      page.getByRole("heading", {
        name: "Expresní termín teď nemůžeme bezpečně potvrdit.",
      }),
    ).toBeVisible();

    const standardResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/express"),
    );
    const recoveredPrepareResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/prepare"),
    );
    await page.getByRole("button", { name: "Pokračovat bez expresu" }).click();
    expect((await (await standardResponse).json()).express.requested).toBe(
      false,
    );
    const recovered = await recoveredPrepareResponse;
    expect(recovered.status()).toBe(200);
    expect(await recovered.json()).toMatchObject({
      phase: "CHECKOUT_READY",
      checkoutReady: true,
      handoff: null,
      bindingQuote: { totalMinor: 43900 },
    });
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible();
    await expect(page.locator(".checkout-summary__total strong")).toContainText(
      "439,00",
    );
    const state = await request.get("http://127.0.0.1:4175/__test/state");
    expect((await state.json()).lastAssistedQuote).toBeNull();
  });

  test("invalidates the old binding before requoting a different delivery endpoint", async ({
    page,
  }) => {
    const initialPrepareResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/prepare"),
    );
    await page
      .getByRole("button", { name: "Ověřit dopravu a závaznou cenu" })
      .click();
    const initialPrepared = await (await initialPrepareResponse).json();
    expect(initialPrepared.bindingQuote.totalMinor).toBe(43900);
    await expect(page.locator(".checkout-summary__total strong")).toContainText(
      "439,00",
    );

    await page
      .getByRole("combobox", { name: "Způsob a místo" })
      .selectOption({ label: "Zásilkovna — Druhé výdejní místo" });
    const destinationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/delivery-destination"),
    );
    const requoteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/prepare"),
    );
    await page
      .getByRole("button", { name: "Přepočítat s jiným místem" })
      .click();

    const destination = await destinationResponse;
    expect(destination.status()).toBe(200);
    expect(destination.request().postDataJSON()).toMatchObject({
      providerEndpointId: "packeta-2",
      endpointType: "pickup_point",
    });
    expect(await destination.json()).toMatchObject({
      phase: "ELIGIBILITY_PENDING",
      configurationRevision: initialPrepared.configurationRevision + 1,
      checkoutReady: false,
      bindingQuote: null,
      selectedDeliveryDestination: {
        providerEndpointId: "packeta-2",
        label: "Zásilkovna — Druhé výdejní místo",
      },
    });

    const requoted = await requoteResponse;
    expect(requoted.status()).toBe(200);
    expect(await requoted.json()).toMatchObject({
      phase: "CHECKOUT_READY",
      checkoutReady: true,
      bindingQuote: {
        totalMinor: 46900,
        components: expect.arrayContaining([
          expect.objectContaining({ kind: "DELIVERY", amountMinor: 11900 }),
        ]),
      },
    });
    await expect(page.locator(".checkout-summary__total strong")).toContainText(
      "469,00",
    );
    await expect(
      page.getByRole("heading", { name: "Dokončení objednávky" }),
    ).toBeVisible();
  });
});

test("Packeta picker ignores cancelled and stale callbacks, then requotes the selected point", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4175/__test/reset");
  await request.post("http://127.0.0.1:4175/__test/state", {
    data: { packetaSelector: true },
  });
  await page.addInitScript(() => {
    type Point = { id?: unknown } | null;
    const callbacks: Array<(point: Point) => void> = [];
    Object.defineProperty(window, "__packetaCallbacks", { value: callbacks });
    Object.defineProperty(window, "Packeta", {
      value: {
        Widget: {
          pick: (_accountId: string, callback: (point: Point) => void) => {
            callbacks.push(callback);
          },
          close: () => {},
        },
      },
    });
  });

  let destinationRequests = 0;
  page.on("request", (outgoing) => {
    if (
      outgoing.method() === "PUT" &&
      outgoing.url().includes("/delivery-destination")
    ) {
      destinationRequests += 1;
    }
  });
  const selectPoint = async (index: number, id: string | null) => {
    await page.evaluate(
      ({ index, id }) => {
        const callback = (
          window as Window & {
            __packetaCallbacks?: Array<
              (point: { id?: unknown } | null) => void
            >;
          }
        ).__packetaCallbacks?.[index];
        if (!callback) throw new Error(`Missing Packeta callback ${index}`);
        callback(id === null ? null : { id });
      },
      { index, id },
    );
  };
  const picker = page.getByRole("button", { name: "Vybrat výdejní místo" });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
  await page
    .getByRole("button", { name: "Nahrát a pokračovat ke konfiguraci" })
    .click();
  await expect(page).toHaveURL(/\/objednavka/);
  await expect(picker).toBeVisible();
  await picker.click();
  await selectPoint(0, null);
  await expect(picker).toBeFocused();
  await picker.click();
  await selectPoint(0, "packeta-1");

  const firstDestination = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/delivery-destination"),
  );
  await selectPoint(1, "packeta-2");
  expect((await firstDestination).request().postDataJSON()).toMatchObject({
    endpointType: "pickup_point",
    providerEndpointId: "packeta-2",
  });
  await expect(page.locator(".checkout-summary__total strong")).toContainText(
    "469,00",
  );
  await expect(
    page.getByRole("heading", { name: "Dokončení objednávky" }),
  ).toBeVisible();
  expect(destinationRequests).toBe(1);

  await picker.click();
  const secondDestination = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/delivery-destination"),
  );
  await selectPoint(2, "packeta-1");
  const reselection = await secondDestination;
  expect(reselection.request().postDataJSON()).toMatchObject({
    providerEndpointId: "packeta-1",
  });
  expect(await reselection.json()).toMatchObject({
    phase: "ELIGIBILITY_PENDING",
    checkoutReady: false,
    bindingQuote: null,
  });
  await expect(page.locator(".checkout-summary__total strong")).toContainText(
    "439,00",
  );
  expect(destinationRequests).toBe(2);
});
