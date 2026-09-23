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
      await route.fulfill({
        json: {
          machineId,
          revisionId: "revision-1",
          selectionVersion: 1,
          windows: [
            {
              startsAt: "2026-09-23T08:00:00Z",
              endsAt: "2026-09-23T18:00:00Z",
              ordinal: 0,
            },
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
      method === "POST" &&
      path.endsWith(`/machines/${machineId}/availability`)
    ) {
      availabilityPosts += 1;
      availabilityPostPaths.push(path);
      await route.fulfill({
        status: 409,
        json: { message: "reservation conflict" },
      });
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
  await page.getByRole("button", { name: "Nasadit" }).click();
  await expect(page.locator(".form-success")).toContainText(
    "Množství ani rezervace se nezměnily",
  );
  expect(mountBody).toEqual({
    mountStatus: "MOUNTED",
    reason: "Nasazeno pro tisk",
  });
  expect(mountHeaders["x-csrf-token"]).toBe("csrf-test");
  expect(mountHeaders["idempotency-key"]).toBeTruthy();
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
  await page.getByRole("button", { name: "Publikovat dostupnost" }).click();
  await expect(page.getByRole("alert")).toContainText("živou rezervací");
  expect(availabilityPosts).toBe(1);
  expect(availabilityPostPaths).toEqual([
    `/admin/nodes/${nodeId}/machines/${machineId}/availability`,
  ]);
  await expect(page.locator(".form-success")).toHaveCount(0);
});
