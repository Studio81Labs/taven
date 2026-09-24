import { expect, test } from "@playwright/test";

test("mounts a spool without changing stock and keeps a reservation conflict visible", async ({
  page,
}) => {
  const nodeId = "00000000-0000-0000-0000-000000000002";
  const machineId = "00000000-0000-0000-0000-000000000003";
  const otherMachineId = "00000000-0000-0000-0000-000000000005";
  const inventoryId = "00000000-0000-0000-0000-000000000004";
  let mountStatus = "UNMOUNTED";
  let mountBody: unknown;
  let mountHeaders: Record<string, string> = {};
  let availabilityPosts = 0;
  const availabilityPostPaths: string[] = [];
  let releaseAvailabilityPost: (() => void) | undefined;
  let holdNextAvailability = false;
  let releaseStaleAvailability: (() => void) | undefined;
  let failNextAvailabilityRead = false;
  let availabilityVersion = 1;
  let twoWindowAvailability = false;
  let holdRangeRead = false;
  let releaseRangeRead: (() => void) | undefined;
  await page.route("**/admin/auth/session", (route) =>
    route.fulfill({
      json: {
        csrfToken: "csrf-test",
        operator: {
          operatorId: "00000000-0000-0000-0000-000000000001",
          role: "ADMIN",
          nodeIds: [nodeId],
          permissions: ["operations:read", "catalog:write"],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
        },
      },
    }),
  );
  await page.route("**/admin/catalog/machine-capabilities*", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/admin/nodes/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET" && path.endsWith("/machines")) {
      await route.fulfill({
        json: {
          items: [
            {
              id: machineId,
              nodeId,
              machineCapabilityId: "cap",
              code: "M1",
              displayName: "Stroj 1",
              installedNozzleMicrometers: 400,
              status: "ACTIVE",
            },
            {
              id: otherMachineId,
              nodeId,
              machineCapabilityId: "cap",
              code: "M2",
              displayName: "Stroj 2",
              installedNozzleMicrometers: 400,
              status: "ACTIVE",
            },
          ],
        },
      });
    } else if (method === "GET" && path.endsWith("/inventories")) {
      await route.fulfill({
        json: {
          items: [
            {
              id: inventoryId,
              machineId,
              sku: "PLA-red",
              material: "PLA",
              color: "red",
              status: "AVAILABLE",
              mountStatus,
              receiptCoverage: "RECORDED",
              remainingMilligrams: "600000",
              reservedMilligrams: "200000",
              availableMilligrams: "400000",
            },
          ],
        },
      });
    } else if (method === "GET" && path.endsWith("/calibrations")) {
      await route.fulfill({ json: { items: [] } });
    } else if (
      method === "GET" &&
      path.endsWith(`/inventories/${inventoryId}`)
    ) {
      await route.fulfill({
        json: {
          id: inventoryId,
          machineId,
          nodeId,
          sku: "PLA-red",
          material: "PLA",
          color: "red",
          status: "AVAILABLE",
          mountStatus,
          receiptCoverage: "RECORDED",
          remainingMilligrams: "600000",
          reservedMilligrams: "200000",
          availableMilligrams: "400000",
          vendor: "Vendor",
          currency: "CZK",
          priceMinorUnitsNumerator: "2",
          priceMinorUnitsDenominator: "1000",
          receipts: [],
        },
      });
    } else if (
      method === "POST" &&
      path.endsWith(`/inventories/${inventoryId}/mount`)
    ) {
      mountBody = request.postDataJSON();
      mountHeaders = request.headers();
      mountStatus = "MOUNTED";
      await route.fulfill({ json: { id: inventoryId, status: "AVAILABLE" } });
    } else if (
      method === "GET" &&
      path.endsWith(`/machines/${machineId}/availability`)
    ) {
      if (holdNextAvailability) {
        holdNextAvailability = false;
        await new Promise<void>((resolve) => {
          releaseStaleAvailability = resolve;
        });
        return route.fulfill({
          status: 503,
          json: { message: "obsolete availability failed" },
        });
      }
      if (failNextAvailabilityRead) {
        failNextAvailabilityRead = false;
        return route.fulfill({
          status: 503,
          json: { message: "availability read failed" },
        });
      }
      if (holdRangeRead) {
        holdRangeRead = false;
        await new Promise<void>((resolve) => {
          releaseRangeRead = resolve;
        });
      }
      await route.fulfill({
        json: {
          machineId,
          revisionId: `revision-${availabilityVersion}`,
          selectionVersion: availabilityVersion,
          windows: [
            {
              startsAt: "2026-09-23T08:00:00Z",
              endsAt: "2026-09-23T18:00:00Z",
              ordinal: 0,
            },
            ...(twoWindowAvailability
              ? [
                  {
                    startsAt: "2026-09-24T08:00:00Z",
                    endsAt: "2026-09-24T18:00:00Z",
                    ordinal: 1,
                  },
                ]
              : []),
          ],
          occupiedIntervals: [
            {
              id: "reservation-1",
              machineId,
              startsAt: "2026-09-23T10:00:00Z",
              endsAt: "2026-09-23T11:00:00Z",
              expiresAt: "2026-09-23T11:00:00Z",
              status: "CONFIRMED",
            },
          ],
        },
      });
    } else if (
      method === "GET" &&
      path.endsWith(`/machines/${otherMachineId}/availability`)
    ) {
      await route.fulfill({
        json: {
          machineId: otherMachineId,
          revisionId: "revision-2",
          selectionVersion: 2,
          windows: [],
          occupiedIntervals: [],
        },
      });
    } else if (
      method === "POST" &&
      path.endsWith(`/machines/${machineId}/availability`)
    ) {
      availabilityPosts += 1;
      availabilityPostPaths.push(path);
      if (availabilityPosts === 1) {
        await new Promise<void>((resolve) => {
          releaseAvailabilityPost = resolve;
        });
        await route.fulfill({
          status: 409,
          json: { message: "reservation conflict" },
        });
      } else if (availabilityPosts === 2) {
        availabilityVersion = 2;
        failNextAvailabilityRead = true;
        await route.fulfill({ json: { machineId, selectionVersion: 2 } });
      } else {
        failNextAvailabilityRead = true;
        await route.fulfill({
          status: 409,
          json: { message: "stale publication" },
        });
      }
    } else {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("/zdroje");
  await expect(
    page.getByText(
      "Zbývá 600000 mg · rezervováno 200000 mg · dostupné 400000 mg",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Detail a rychlé změny" }).click();
  await page.getByLabel("Důvod změny").fill("Nasazeno pro tisk");
  await expect(page.getByRole("button", { name: "Sundat" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Dostupné" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Vyčerpané" })).toBeEnabled();
  await page.getByRole("button", { name: "Dostupnost" }).first().click();
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  const draftStart = page.getByRole("textbox", { name: "Začátek" });
  await draftStart.fill("2026-09-23T10:00:00+02:00");
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  await draftStart.fill("2026-09-23T09:00:00+02:00");
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Nasadit" }).click();
  await expect(draftStart).toHaveValue("2026-09-23T09:00:00+02:00");
  await expect(page.locator(".form-success")).toContainText(
    "Množství ani rezervace se nezměnily",
  );
  expect(mountBody).toEqual({
    mountStatus: "MOUNTED",
    reason: "Nasazeno pro tisk",
  });
  expect(mountHeaders["x-csrf-token"]).toBe("csrf-test");
  expect(mountHeaders["idempotency-key"]).toBeTruthy();
  await expect(page.getByRole("button", { name: "Nasadit" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sundat" })).toBeEnabled();
  await expect(
    page.getByText(
      "Dostupné 400000 mg · rezervované 200000 mg · zbývající 600000 mg",
      { exact: false },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dostupnost" }).first().click();
  await expect(page.getByText("reservation-1", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Přijmout novou šarži" }).click();
  await page
    .getByRole("combobox", { name: "Stroj" })
    .selectOption(otherMachineId);
  const conflictedStart = page.getByRole("textbox", { name: "Začátek" });
  await conflictedStart.fill("2026-09-23T09:00:00+02:00");
  await page.getByRole("button", { name: "Publikovat dostupnost" }).click();
  await expect.poll(() => Boolean(releaseAvailabilityPost)).toBe(true);
  await expect(conflictedStart).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Přidat okno" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Odebrat" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Načíst" })).toBeDisabled();
  releaseAvailabilityPost?.();
  await expect(page.getByRole("alert")).toContainText("živou rezervací");
  await expect(conflictedStart).toHaveValue("2026-09-23T09:00:00+02:00");
  expect(availabilityPosts).toBe(1);
  expect(availabilityPostPaths).toEqual([
    `/admin/nodes/${nodeId}/machines/${machineId}/availability`,
  ]);
  await expect(page.locator(".form-success")).toHaveCount(0);
  holdNextAvailability = true;
  await page.getByRole("button", { name: "Dostupnost" }).first().click();
  await expect.poll(() => Boolean(releaseStaleAvailability)).toBe(true);
  await page.getByRole("button", { name: "Dostupnost" }).nth(1).click();
  await expect(
    page.getByText("Verze výběru 2", { exact: false }),
  ).toBeVisible();
  const staleAvailabilityResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/machines/${machineId}/availability`) &&
      response.status() === 503,
  );
  releaseStaleAvailability?.();
  await staleAvailabilityResponse;
  await expect(page.getByRole("alert")).not.toContainText(
    "obsolete availability failed",
  );
  await page.getByRole("button", { name: "Dostupnost" }).first().click();
  await expect(
    page.getByText("Verze výběru 1", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Začátek" })
    .fill("2026-09-23T09:00:00+02:00");
  await page.getByRole("button", { name: "Publikovat dostupnost" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Zápis byl potvrzen, ale obnovení dostupnosti selhalo",
  );
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  expect(availabilityPosts).toBe(2);
  await page.getByRole("button", { name: "Načíst" }).click();
  await expect(
    page.getByText("Verze výběru 2", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Začátek" })
    .fill("2026-09-23T09:00:00+02:00");
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Publikovat dostupnost" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Obnovení dostupnosti selhalo",
  );
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  expect(availabilityPosts).toBe(3);
  await page.getByRole("button", { name: "Načíst" }).click();
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  holdRangeRead = true;
  await page.getByRole("button", { name: "Načíst" }).click();
  await expect.poll(() => Boolean(releaseRangeRead)).toBe(true);
  await page
    .getByRole("textbox", { name: "Od", exact: true })
    .fill("2026-09-24T00:00:00+02:00");
  const staleRangeResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/machines/${machineId}/availability`) &&
      response.status() === 200,
  );
  releaseRangeRead?.();
  await staleRangeResponse;
  await expect(
    page.getByText("Načtěte dostupnost pro zvolený rozsah."),
  ).toBeVisible();
  await expect(page.getByText("reservation-1", { exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Načíst" }).click();
  await expect(page.getByText("reservation-1", { exact: false })).toBeVisible();
  twoWindowAvailability = true;
  await page.getByRole("button", { name: "Dostupnost" }).first().click();
  await expect(page.getByRole("button", { name: "Odebrat" })).toHaveCount(2);
  await page.getByRole("button", { name: "Odebrat" }).first().click();
  await page.getByRole("button", { name: "Přidat okno" }).click();
  await page
    .getByRole("textbox", { name: "Začátek" })
    .nth(1)
    .fill("2026-09-23T10:00:00+02:00");
  await page
    .getByRole("textbox", { name: "Konec" })
    .nth(1)
    .fill("2026-09-23T20:00:00+02:00");
  await expect(
    page.getByRole("button", { name: "Publikovat dostupnost" }),
  ).toBeDisabled();
  expect(availabilityPosts).toBe(3);
});

test("a confirmed receipt closes its form when the following read fails", async ({
  page,
}) => {
  const nodeId = "00000000-0000-0000-0000-000000000002";
  const machineId = "00000000-0000-0000-0000-000000000003";
  let failReads = false;
  let receiptPosts = 0;
  let machineStatusPosts = 0;
  let machineStatus = "ACTIVE";
  let calibrationState = "DRAFT";
  let releaseReceipt: (() => void) | undefined;
  await page.route("**/admin/auth/session", (route) =>
    route.fulfill({
      json: {
        csrfToken: "csrf-test",
        operator: {
          operatorId: "00000000-0000-0000-0000-000000000001",
          role: "ADMIN",
          nodeIds: [nodeId],
          permissions: ["operations:read", "catalog:write"],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
        },
      },
    }),
  );
  await page.route("**/admin/catalog/machine-capabilities*", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/admin/nodes/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      route.request().method() === "POST" &&
      path.endsWith("/inventory-receipts")
    ) {
      receiptPosts += 1;
      await new Promise<void>((resolve) => {
        releaseReceipt = resolve;
      });
      failReads = true;
      await route.fulfill({ json: { id: "new-receipt" } });
    } else if (
      route.request().method() === "POST" &&
      path.endsWith(`/machines/${machineId}/status`)
    ) {
      machineStatusPosts += 1;
      machineStatus = "MAINTENANCE";
      failReads = true;
      await route.fulfill({ json: { id: machineId, status: machineStatus } });
    } else if (failReads) {
      await route.fulfill({ status: 503, json: { message: "read outage" } });
    } else if (path.endsWith("/machines")) {
      await route.fulfill({
        json: {
          items: [
            {
              id: machineId,
              nodeId,
              machineCapabilityId: "cap",
              code: "M1",
              displayName: "Stroj 1",
              installedNozzleMicrometers: 400,
              status: machineStatus,
            },
          ],
        },
      });
    } else if (path.endsWith("/calibrations")) {
      await route.fulfill({
        json: {
          items: [
            {
              id: "calibration-1",
              machineId,
              state: calibrationState,
              flowRatioPartsPerMillion: 1_000_000,
            },
          ],
        },
      });
    } else {
      await route.fulfill({ json: { items: [] } });
    }
  });
  await page.goto("/zdroje");
  await page.getByRole("button", { name: "Přijmout novou šarži" }).click();
  await page.getByRole("combobox", { name: "Stroj" }).selectOption(machineId);
  await page.getByRole("textbox", { name: "SKU" }).fill("PLA-new");
  await page.getByRole("textbox", { name: "Dodavatel" }).fill("Vendor");
  await page
    .getByRole("textbox", { name: /Nakoupeno/ })
    .fill("2026-09-23T10:00:00+02:00");
  await page
    .getByRole("textbox", { name: "Přijaté množství mg" })
    .fill("1000000");
  await page
    .getByRole("textbox", { name: /Jednotková cena čitatel/ })
    .fill("2");
  await page.getByRole("button", { name: "Zapsat", exact: true }).click();
  await expect.poll(() => Boolean(releaseReceipt)).toBe(true);
  await expect(
    page.getByRole("button", { name: "Registrovat stroj" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Nová kalibrace" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Přijmout novou šarži" }),
  ).toBeDisabled();
  releaseReceipt?.();
  await expect(page.locator(".form-success")).toContainText("Nová šarže");
  await expect(page.getByRole("alert")).toContainText(
    "Zápis byl potvrzen, ale obnovení přehledu selhalo",
  );
  await expect(
    page.getByRole("button", { name: "Zapsat", exact: true }),
  ).toHaveCount(0);
  expect(receiptPosts).toBe(1);
  failReads = false;
  await page.getByRole("button", { name: "Obnovit zdroje" }).click();
  await page.getByRole("textbox", { name: "Důvod změny" }).fill("Servis");
  await expect(page.getByRole("button", { name: "Aktivní" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Aktivovat" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Vyřadit" })).toBeDisabled();
  const maintenance = page.getByRole("button", { name: "Údržba" });
  await maintenance.click();
  await expect(page.getByRole("alert")).toContainText(
    "Zápis byl potvrzen, ale obnovení přehledu selhalo",
  );
  await expect(maintenance).toBeDisabled();
  expect(machineStatusPosts).toBe(1);
  failReads = false;
  calibrationState = "ACTIVE";
  await page.getByRole("button", { name: "Obnovit zdroje" }).click();
  await expect(maintenance).toBeDisabled();
  await expect(page.getByRole("button", { name: "Aktivní" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Vypnout" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Aktivovat" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Vyřadit" })).toBeEnabled();
});

test("a confirmed adjustment cannot be repeated until inventory detail refreshes", async ({
  page,
}) => {
  const nodeId = "00000000-0000-0000-0000-000000000002";
  const inventoryId = "00000000-0000-0000-0000-000000000004";
  const otherInventoryId = "00000000-0000-0000-0000-000000000005";
  let failReads = false;
  let adjustmentPosts = 0;
  let releaseAdjustment: (() => void) | undefined;
  let releaseOtherDetail: (() => void) | undefined;
  let delayOtherDetail = true;
  let holdNextOtherDetail = false;
  let releaseStaleOtherDetail: (() => void) | undefined;
  let holdFreshOtherDetail = false;
  let releaseFreshOtherDetail: (() => void) | undefined;
  let holdNextFirstDetail = false;
  let releaseStaleInventory: (() => void) | undefined;
  await page.route("**/admin/auth/session", (route) =>
    route.fulfill({
      json: {
        csrfToken: "csrf-test",
        operator: {
          operatorId: "00000000-0000-0000-0000-000000000001",
          role: "ADMIN",
          nodeIds: [nodeId],
          permissions: ["operations:read", "catalog:write"],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
        },
      },
    }),
  );
  await page.route("**/admin/catalog/machine-capabilities*", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/admin/nodes/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST" && path.endsWith("/adjustments")) {
      adjustmentPosts += 1;
      await new Promise<void>((resolve) => {
        releaseAdjustment = resolve;
      });
      if (adjustmentPosts === 1) failReads = true;
      return route.fulfill({ json: { id: inventoryId } });
    }
    if (path.endsWith(`/inventories/${otherInventoryId}`)) {
      const stale = holdNextOtherDetail;
      if (stale) {
        holdNextOtherDetail = false;
        await new Promise<void>((resolve) => {
          releaseStaleOtherDetail = resolve;
        });
      } else if (holdFreshOtherDetail && adjustmentPosts === 2) {
        holdFreshOtherDetail = false;
        await new Promise<void>((resolve) => {
          releaseFreshOtherDetail = resolve;
        });
      }
      if (delayOtherDetail) {
        delayOtherDetail = false;
        await new Promise<void>((resolve) => {
          releaseOtherDetail = resolve;
        });
      }
      return route.fulfill({
        json: {
          id: otherInventoryId,
          nodeId,
          machineId: "machine",
          sku: "PETG-blue",
          vendor: adjustmentPosts === 2 && !stale ? "Updated vendor" : "Vendor",
          currency: "CZK",
          priceMinorUnitsNumerator: "2",
          priceMinorUnitsDenominator: "1000",
          receipts: [],
        },
      });
    }
    if (failReads)
      return route.fulfill({ status: 503, json: { message: "read outage" } });
    if (path.endsWith(`/inventories/${inventoryId}`)) {
      if (holdNextFirstDetail) {
        holdNextFirstDetail = false;
        await new Promise<void>((resolve) => {
          releaseStaleInventory = resolve;
        });
        return route.fulfill({
          status: 503,
          json: { message: "obsolete inventory failed" },
        });
      }
      return route.fulfill({
        json: {
          id: inventoryId,
          nodeId,
          machineId: "machine",
          sku: "PLA-red",
          vendor: "Vendor",
          currency: "CZK",
          priceMinorUnitsNumerator: "2",
          priceMinorUnitsDenominator: "1000",
          receipts: [],
        },
      });
    }
    if (path.endsWith("/inventories"))
      return route.fulfill({
        json: {
          items: [
            {
              id: inventoryId,
              nodeId,
              machineId: "machine",
              sku: "PLA-red",
              material: "PLA",
              status: "AVAILABLE",
              mountStatus: "MOUNTED",
              receiptCoverage: "RECORDED",
              remainingMilligrams: "500000",
              reservedMilligrams: "0",
              availableMilligrams: "500000",
            },
            {
              id: otherInventoryId,
              nodeId,
              machineId: "machine",
              sku: "PETG-blue",
              material: "PETG",
              status: "AVAILABLE",
              mountStatus: "MOUNTED",
              receiptCoverage: "RECORDED",
              remainingMilligrams: "500000",
              reservedMilligrams: "0",
              availableMilligrams: "500000",
            },
          ],
        },
      });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/zdroje");
  await page
    .getByRole("button", { name: "Detail a rychlé změny" })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Důvod změny" })
    .fill("korekce stavu");
  await page.getByRole("textbox", { name: /Změna množství/ }).fill("1000");
  const adjust = page.getByRole("button", { name: "Upravit množství" });
  await adjust.click();
  await expect.poll(() => Boolean(releaseAdjustment)).toBe(true);
  await page
    .getByRole("button", { name: "Detail a rychlé změny" })
    .nth(1)
    .click();
  await expect.poll(() => Boolean(releaseOtherDetail)).toBe(true);
  releaseAdjustment?.();
  await expect(page.getByRole("alert")).toContainText(
    "Zápis byl potvrzen, ale obnovení přehledu selhalo",
  );
  releaseOtherDetail?.();
  await expect(adjust).toHaveCount(0);
  expect(adjustmentPosts).toBe(1);
  failReads = false;
  await page.getByRole("button", { name: "Obnovit zdroje" }).click();
  await expect(
    page.getByRole("heading", { name: "Šarže PETG-blue" }),
  ).toBeVisible();
  await expect(adjust).toBeEnabled();
  releaseAdjustment = undefined;
  holdNextOtherDetail = true;
  holdFreshOtherDetail = true;
  await adjust.click();
  await expect.poll(() => Boolean(releaseAdjustment)).toBe(true);
  await page
    .getByRole("button", { name: "Detail a rychlé změny" })
    .nth(1)
    .click();
  await expect.poll(() => Boolean(releaseStaleOtherDetail)).toBe(true);
  releaseAdjustment?.();
  await expect.poll(() => Boolean(releaseFreshOtherDetail)).toBe(true);
  await expect(adjust).toHaveCount(0);
  releaseFreshOtherDetail?.();
  await expect(adjust).toBeEnabled();
  const staleOtherResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/inventories/${otherInventoryId}`) &&
      response.status() === 200,
  );
  releaseStaleOtherDetail?.();
  await staleOtherResponse;
  await expect(
    page.getByText("Updated vendor", { exact: false }),
  ).toBeVisible();
  expect(adjustmentPosts).toBe(2);
  holdNextFirstDetail = true;
  await page
    .getByRole("button", { name: "Detail a rychlé změny" })
    .first()
    .click();
  await expect.poll(() => Boolean(releaseStaleInventory)).toBe(true);
  await page
    .getByRole("button", { name: "Detail a rychlé změny" })
    .nth(1)
    .click();
  await expect(
    page.getByRole("heading", { name: "Šarže PETG-blue" }),
  ).toBeVisible();
  const staleInventoryResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/inventories/${inventoryId}`) &&
      response.status() === 503,
  );
  releaseStaleInventory?.();
  await staleInventoryResponse;
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("receipt correction copies only the current evidence and waits for refresh", async ({
  page,
}) => {
  const nodeId = "00000000-0000-0000-0000-000000000002";
  const inventoryId = "00000000-0000-0000-0000-000000000004";
  const legacyInventoryId = "00000000-0000-0000-0000-000000000005";
  const firstId = "00000000-0000-0000-0000-000000000011";
  const secondId = "00000000-0000-0000-0000-000000000012";
  await page.route("**/admin/auth/session", (route) =>
    route.fulfill({
      json: {
        csrfToken: "csrf-test",
        operator: {
          operatorId: "00000000-0000-0000-0000-000000000001",
          role: "ADMIN",
          nodeIds: [nodeId],
          permissions: ["operations:read", "catalog:write"],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
        },
      },
    }),
  );
  await page.route("**/admin/catalog/machine-capabilities*", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/admin/nodes/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/inventories/${legacyInventoryId}`))
      return route.fulfill({
        json: {
          id: legacyInventoryId,
          nodeId,
          machineId: "machine",
          sku: "PETG-blue",
          vendor: "Legacy vendor",
          currency: "CZK",
          priceMinorUnitsNumerator: "9",
          priceMinorUnitsDenominator: "1000",
          receiptCoverage: "UNKNOWN",
          receipts: [],
        },
      });
    if (path.endsWith(`/inventories/${inventoryId}`))
      return route.fulfill({
        json: {
          id: inventoryId,
          nodeId,
          machineId: "machine",
          sku: "PLA-red",
          vendor: "Current vendor",
          currency: "CZK",
          priceMinorUnitsNumerator: "9",
          priceMinorUnitsDenominator: "1000",
          receipts: [
            {
              id: firstId,
              kind: "INITIAL",
              vendor: "First vendor",
              currency: "CZK",
              purchasedAt: "2025-04-03T10:00:00Z",
              receivedMilligrams: "400000",
              priceMinorUnitsNumerator: "2",
              priceMinorUnitsDenominator: "1000",
              createdAt: "2025-04-03T10:00:00Z",
            },
            {
              id: secondId,
              kind: "CORRECTION",
              supersedesReceiptId: firstId,
              vendor: "Second vendor",
              currency: "CZK",
              purchasedAt: "2025-04-04T10:00:00Z",
              receivedMilligrams: "500000",
              priceMinorUnitsNumerator: "3",
              priceMinorUnitsDenominator: "1000",
              createdAt: "2025-04-04T10:00:00Z",
            },
          ],
        },
      });
    if (path.endsWith("/inventories"))
      return route.fulfill({
        json: {
          items: [
            {
              id: inventoryId,
              nodeId,
              machineId: "machine",
              sku: "PLA-red",
              material: "PLA",
              status: "AVAILABLE",
              mountStatus: "MOUNTED",
              receiptCoverage: "RECORDED",
              remainingMilligrams: "500000",
              reservedMilligrams: "0",
              availableMilligrams: "500000",
            },
            {
              id: legacyInventoryId,
              nodeId,
              machineId: "machine",
              sku: "PETG-blue",
              material: "PETG",
              status: "AVAILABLE",
              mountStatus: "UNMOUNTED",
              receiptCoverage: "UNKNOWN",
              remainingMilligrams: "500000",
              reservedMilligrams: "0",
              availableMilligrams: "500000",
            },
          ],
        },
      });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/zdroje");
  await page
    .getByRole("button", { name: "Detail a rychlé změny" })
    .first()
    .click();
  await page.getByRole("button", { name: "Opravit doklad" }).click();
  await expect(page.getByRole("textbox", { name: "Dodavatel" })).toHaveValue(
    "Second vendor",
  );
  await expect(page.getByRole("textbox", { name: /Nakoupeno/ })).toHaveValue(
    "2025-04-04T10:00:00Z",
  );
  await expect(
    page.getByRole("textbox", { name: "Přijaté množství mg" }),
  ).toHaveValue("500000");
  await expect(page.getByText(`Nahrazený doklad ${secondId}`)).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Nahrazený doklad" }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "Důvod změny" }).fill("oprava");
  let releaseRead: (() => void) | undefined;
  await page.route(`**/admin/nodes/${nodeId}/machines*`, async (route) => {
    await new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await route.fulfill({ json: { items: [] } });
  });
  await page.getByRole("button", { name: "Obnovit zdroje" }).click();
  await expect.poll(() => Boolean(releaseRead)).toBe(true);
  await expect(
    page.getByRole("button", { name: "Zapsat", exact: true }),
  ).toBeDisabled();
  releaseRead?.();
  await expect(page.getByRole("textbox", { name: "Dodavatel" })).toHaveValue(
    "Second vendor",
  );
  await expect(
    page.getByRole("button", { name: "Zapsat", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Přijmout novou šarži" }).click();
  await expect(page.getByRole("combobox", { name: "Stroj" })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Dodavatel" })).toBeEmpty();
  await expect(page.getByRole("textbox", { name: /Nakoupeno/ })).toBeEmpty();
  await expect(
    page.getByRole("textbox", { name: "Přijaté množství mg" }),
  ).toBeEmpty();
  await expect(
    page.getByRole("textbox", { name: /Jednotková cena čitatel/ }),
  ).toBeEmpty();
  await page.getByRole("button", { name: "Zavřít" }).click();
  await page
    .getByRole("button", { name: "Detail a rychlé změny" })
    .nth(1)
    .click();
  await page.getByRole("button", { name: "Doplnit počáteční doklad" }).click();
  await expect(page.getByRole("textbox", { name: /Nakoupeno/ })).toBeEmpty();
  await expect(
    page.getByRole("textbox", { name: "Přijaté množství mg" }),
  ).toBeEmpty();
});
