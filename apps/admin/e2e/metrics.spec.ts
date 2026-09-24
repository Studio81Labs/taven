import { expect, test } from "@playwright/test";

const zero = { amountMinor: "0", currency: "CZK" };
const metricRatio = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
});
const cell = (issued = 0, confirmedPaid = 0) => ({
  issued,
  confirmedPaid,
  conversion: metricRatio(confirmedPaid, issued),
});
const bands = (known = false) => ({
  under_25000: cell(),
  "25000_to_49999": cell(known ? 1 : 0),
  "50000_to_99999": cell(),
  "100000_to_199999": cell(),
  "200000_or_more": cell(),
});
const group = (known = false) => ({
  issued: known ? 1 : 0,
  confirmedPaid: 0,
  conversion: metricRatio(0, known ? 1 : 0),
  unavailableGross: 0,
  bands: bands(known),
});

test("shows legacy unknown issuance evidence in its known price band beside the retained v0-1 definition", async ({
  page,
}) => {
  await page.route("**/admin/auth/session", (route) =>
    route.fulfill({
      json: {
        csrfToken: "csrf-test",
        operator: {
          operatorId: "00000000-0000-0000-0000-000000000001",
          role: "ADMIN",
          nodeIds: ["00000000-0000-0000-0000-000000000002"],
          permissions: [
            "metrics:read",
            "operations:read",
            "financial:exception",
          ],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
        },
      },
    }),
  );
  const report = {
    metricDefinition: "v0-1",
    generatedAt: "2026-09-23T12:00:00Z",
    completeness: { status: "warning", flags: ["legacy_preflight_unknown"] },
    sourceCoverage: {
      selectedCurrencyOrders: 1,
      excludedCurrencyOrders: 0,
      businessEvents: {
        historicalBackfill: "not_performed",
        retainedClientObservations: true,
      },
    },
    commercial: {
      funnel: {
        definition: "v0-1",
        uploads: 1,
        automaticBindingPriceQuoteViews: 1,
        checkoutStarts: 1,
        confirmedOrders: 0,
        impressions: "not_collected",
        clicks: "not_collected",
      },
      quoteToPaid: {
        conversion: metricRatio(0, 1),
        automatic: { preflight: { clean: 3, warning: 0, unknown: 0 } },
        priceBandConversion: {
          metricDefinition: "v0-2",
          definition: "binding-scoped immutable preflight at issuance",
          total: group(true),
          automatic: {
            all: group(true),
            preflight: {
              clean: group(),
              warning: group(),
              unknown: group(true),
            },
          },
          individual: {
            all: group(),
            preflight: { clean: group(), warning: group(), unknown: group() },
          },
        },
      },
      automationShare: { value: metricRatio(1, 1) },
      orders: { express: metricRatio(0, 1) },
      handlingAndContributionMargin: {
        finalContributionMargin: {
          value: null,
          explicitCoverage: { completeOrders: 0, incompleteOrders: 1 },
        },
        handlingCost: zero,
        actualCosts: {
          material: zero,
          carrier: zero,
          packaging: zero,
          payment_fee: zero,
          variable_machine: zero,
        },
      },
      acquisitionAndRepeat: {
        acquisitionSpend: zero,
        cac: { numerator: zero, denominator: 0, value: null },
        repeatRate: metricRatio(0, 1),
      },
    },
    operational: {
      firstPassYield: { value: metricRatio(0, 0) },
      queue: { scheduledRemainingSeconds: "0" },
      monthlyTurnover: [],
    },
  };
  const orderQueries: URLSearchParams[] = [];
  let releaseOrderPage: (() => void) | undefined;
  let holdOrderPage = false;
  await page.route(/\/admin\/metrics(?:\/orders)?\?/, async (route) => {
    if (route.request().url().includes("/orders?")) {
      const query = new URL(route.request().url()).searchParams;
      orderQueries.push(query);
      if (query.has("cursor") && holdOrderPage)
        await new Promise<void>((resolve) => {
          releaseOrderPage = resolve;
        });
      return route.fulfill({
        json: {
          items: [],
          nextCursor: query.has("cursor") ? undefined : "next-opaque",
        },
      });
    }
    return route.fulfill({ json: report });
  });
  await page.route("**/admin/warnings*", (route) =>
    route.fulfill({
      json: {
        nodeId: "00000000-0000-0000-0000-000000000002",
        generatedAt: "2026-09-23T12:00:00Z",
        items: [],
        truncated: false,
        coverage: {
          emailDeliveryAttempts: "unavailable",
          reservationConflictHistory: "unavailable",
          inventoryLotsWithoutReceipt: 1,
          selectedMaterialRate: "unavailable",
          sourceScanLimited: false,
        },
      },
    }),
  );
  let releaseSpendPage: (() => void) | undefined;
  let spendPageRequests = 0;
  await page.route("**/admin/acquisition-spend*", async (route) => {
    const paged = new URL(route.request().url()).searchParams.has("cursor");
    if (paged) {
      spendPageRequests += 1;
      await new Promise<void>((resolve) => {
        releaseSpendPage = resolve;
      });
    }
    return route.fulfill({
      json: {
        items: paged
          ? []
          : [
              {
                id: "00000000-0000-0000-0000-000000000021",
                amountMinor: "8500",
                channel: "DIRECT",
                currency: "CZK",
                periodStart: "2025-01-01T00:00:00Z",
                periodEnd: "2025-02-01T00:00:00Z",
                sourceEntityType: "CAMPAIGN",
                sourceKey: "original-spend",
                isCurrent: true,
                recordedAt: "2025-02-02T00:00:00Z",
                reason: null,
                supersedesId: null,
                successorId: null,
              },
            ],
        nextCursor: paged ? undefined : "next-spend",
        scope: "PLATFORM",
      },
    });
  });
  const costOrderId = "00000000-0000-0000-0000-000000000031";
  let releaseCostPage: (() => void) | undefined;
  let costPageRequests = 0;
  await page.route("**/admin/orders/*/actual-costs*", async (route) => {
    const paged = new URL(route.request().url()).searchParams.has("cursor");
    if (paged) {
      costPageRequests += 1;
      await new Promise<void>((resolve) => {
        releaseCostPage = resolve;
      });
    }
    return route.fulfill({
      json: {
        orderId: costOrderId,
        items: paged
          ? []
          : [
              {
                id: "00000000-0000-0000-0000-000000000032",
                orderId: costOrderId,
                amountMinor: "2500",
                category: "CARRIER",
                currency: "CZK",
                occurredAt: "2025-03-02T11:00:00Z",
                source: "MEASURED",
                sourceEntityType: "SHIPMENT",
                sourceEntityId: "00000000-0000-0000-0000-000000000033",
                sourceKey: "original-cost",
                isCurrent: true,
                recordedAt: "2025-03-03T00:00:00Z",
                reason: null,
                supersedesId: null,
                successorId: null,
              },
            ],
        nextCursor: paged ? undefined : "next-cost",
      },
    });
  });
  await page.goto("/metriky");
  await expect(
    page.getByText("v0-1 preflight:", { exact: false }),
  ).toContainText("čisté 3");
  await expect(
    page.getByText("Neznámé automatické vazby:", { exact: false }),
  ).toContainText("0/1");
  const row = page
    .getByRole("table", { name: "Automatické vazby podle preflight" })
    .getByRole("row", { name: /250–499 Kč/ });
  await expect(row.getByRole("cell").nth(2)).toContainText("0/1");
  await expect(
    page.getByText("emailové pokusy unavailable", { exact: false }),
  ).toBeVisible();
  const newCost = page.locator(".operator-card").filter({
    has: page.getByRole("heading", { name: "Skutečné náklady objednávky" }),
  });
  await newCost.getByRole("button", { name: "Zapsat skutečný náklad" }).click();
  const newCostEditor = page
    .locator(".operator-card")
    .filter({ has: page.getByRole("heading", { name: "Skutečný náklad" }) });
  await newCostEditor
    .getByRole("textbox", { name: "ID objednávky" })
    .fill("00000000-0000-0000-0000-000000000099");
  await expect(
    newCostEditor.getByRole("heading", { name: "Skutečný náklad" }),
  ).toBeVisible();
  await newCostEditor.getByRole("button", { name: "Zavřít" }).click();
  await page.getByRole("textbox", { name: "Začátek" }).fill("2026-09-02");
  await page.getByRole("combobox", { name: "Kanál" }).selectOption("paid");
  holdOrderPage = true;
  await page.getByRole("button", { name: "Další objednávky" }).click();
  await expect.poll(() => Boolean(releaseOrderPage)).toBe(true);
  await expect(
    page.getByRole("button", { name: "Další objednávky" }),
  ).toBeDisabled();
  expect(orderQueries).toHaveLength(2);
  expect(orderQueries[1]?.get("from")).toBe(orderQueries[0]?.get("from"));
  expect(orderQueries[1]?.get("channel")).toBeNull();
  releaseOrderPage?.();
  let releaseRefresh: (() => void) | undefined;
  let holdRefresh = true;
  await page.route(/\/admin\/metrics\?/, async (route) => {
    if (holdRefresh) {
      holdRefresh = false;
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
    }
    await route.fulfill({ json: report });
  });
  await page.getByRole("button", { name: "Načíst report" }).click();
  await expect(
    page.getByRole("button", { name: "Použít měsíc" }),
  ).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Začátek" })).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "Konec (bez tohoto dne)" }),
  ).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Kanál" })).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "Měsíční shakedown" }),
  ).toBeDisabled();
  releaseRefresh?.();
  await expect(
    page.getByRole("button", { name: "Použít měsíc" }),
  ).toBeEnabled();
  await page
    .getByRole("textbox", { name: "ID objednávky" })
    .first()
    .fill(costOrderId);
  await page.getByRole("button", { name: "Načíst", exact: true }).click();
  const costs = page
    .getByRole("heading", { name: "Skutečné náklady objednávky" })
    .locator("..");
  await costs.getByRole("button", { name: "Opravit" }).click();
  const evidence = page.locator(".operator-card").filter({
    has: page.getByRole("heading", { name: /Skutečný náklad · oprava/ }),
  });
  await expect(
    evidence.getByRole("textbox", { name: "Částka v haléřích" }),
  ).toHaveValue("2500");
  await expect(
    evidence.getByRole("combobox", { name: "Kategorie" }),
  ).toHaveValue("CARRIER");
  await expect(
    evidence.getByRole("textbox", { name: "ID objednávky" }),
  ).toHaveJSProperty("readOnly", true);
  await expect(
    evidence.getByRole("combobox", { name: "Kategorie" }),
  ).toBeDisabled();
  await expect(evidence.getByRole("combobox", { name: "Zdroj" })).toHaveValue(
    "MEASURED",
  );
  await expect(
    evidence.getByRole("textbox", { name: /Vznik nákladu/ }),
  ).toHaveValue("2025-03-02T11:00:00Z");
  await expect(
    evidence.getByRole("textbox", { name: "Typ zdrojové entity" }),
  ).toHaveValue("SHIPMENT");
  await expect(
    evidence.getByRole("textbox", { name: "ID zdrojové entity" }),
  ).toHaveValue("00000000-0000-0000-0000-000000000033");
  await expect(
    evidence.getByRole("textbox", { name: "Jedinečný klíč zdroje" }),
  ).toBeEmpty();
  await evidence.getByRole("button", { name: "Zavřít" }).click();
  const spend = page
    .getByRole("heading", { name: /Akviziční výdaj · platforma/ })
    .locator("..");
  await spend.getByRole("button", { name: "Opravit" }).click();
  const spendEvidence = page.locator(".operator-card").filter({
    has: page.getByRole("heading", { name: /Akviziční výdaj · oprava/ }),
  });
  await expect(
    spendEvidence.getByRole("textbox", { name: "Částka v haléřích" }),
  ).toHaveValue("8500");
  await expect(
    spendEvidence.getByRole("combobox", { name: "Kanál" }),
  ).toHaveValue("DIRECT");
  await expect(
    spendEvidence.getByRole("combobox", { name: "Kanál" }),
  ).toBeDisabled();
  await expect(
    spendEvidence.getByRole("textbox", { name: /Začátek období/ }),
  ).toHaveValue("2025-01-01T00:00:00Z");
  await expect(
    spendEvidence.getByRole("textbox", { name: /Konec období/ }),
  ).toHaveValue("2025-02-01T00:00:00Z");
  await expect(
    spendEvidence.getByRole("textbox", { name: "Typ zdrojové entity" }),
  ).toHaveValue("CAMPAIGN");
  await expect(
    spendEvidence.getByRole("textbox", { name: "Jedinečný klíč zdroje" }),
  ).toBeEmpty();
  await costs.getByRole("button", { name: "Další náklady" }).click();
  await expect.poll(() => Boolean(releaseCostPage)).toBe(true);
  await expect(
    costs.getByRole("button", { name: "Další náklady" }),
  ).toBeDisabled();
  expect(costPageRequests).toBe(1);
  releaseCostPage?.();
  await expect(
    costs.getByRole("button", { name: "Další náklady" }),
  ).toHaveCount(0);
  await spend.getByRole("button", { name: "Další výdaje" }).click();
  await expect.poll(() => Boolean(releaseSpendPage)).toBe(true);
  await expect(
    spend.getByRole("button", { name: "Další výdaje" }),
  ).toBeDisabled();
  expect(spendPageRequests).toBe(1);
  releaseSpendPage?.();
  await expect(spend.getByRole("button", { name: "Další výdaje" })).toHaveCount(
    0,
  );
  const staleOrderId = "00000000-0000-0000-0000-000000000041";
  const freshOrderId = "00000000-0000-0000-0000-000000000042";
  let releaseStaleCost: (() => void) | undefined;
  await page.route("**/admin/orders/*/actual-costs*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes(staleOrderId)) {
      await new Promise<void>((resolve) => {
        releaseStaleCost = resolve;
      });
      return route.fulfill({
        status: 503,
        json: { message: "old read failed" },
      });
    }
    if (path.includes(freshOrderId))
      return route.fulfill({ json: { orderId: freshOrderId, items: [] } });
    return route.fallback();
  });
  const orderInput = page
    .getByRole("textbox", { name: "ID objednávky" })
    .first();
  await orderInput.fill(staleOrderId);
  await page.getByRole("button", { name: "Načíst", exact: true }).click();
  await expect.poll(() => Boolean(releaseStaleCost)).toBe(true);
  await orderInput.fill(freshOrderId);
  const freshResponse = page.waitForResponse((response) =>
    response.url().includes(freshOrderId),
  );
  await page.getByRole("button", { name: "Načíst", exact: true }).click();
  await freshResponse;
  const staleResponse = page.waitForResponse((response) =>
    response.url().includes(staleOrderId),
  );
  releaseStaleCost?.();
  await staleResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await orderInput.fill(costOrderId);
  await page.getByRole("button", { name: "Načíst", exact: true }).click();
  await expect(costs.getByRole("button", { name: "Opravit" })).toBeVisible();
  let releaseSpendWrite: (() => void) | undefined;
  await page.route("**/admin/acquisition-spend", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise<void>((resolve) => {
      releaseSpendWrite = resolve;
    });
    await route.fulfill({ json: { id: "new-spend" } });
  });
  await spend.getByRole("button", { name: "Opravit" }).click();
  await spendEvidence
    .getByRole("textbox", { name: "Jedinečný klíč zdroje" })
    .fill("new-spend-key");
  await spendEvidence.getByRole("textbox", { name: /Důvod/ }).fill("Oprava");
  await spendEvidence.getByRole("button", { name: "Zapsat doklad" }).click();
  await expect.poll(() => Boolean(releaseSpendWrite)).toBe(true);
  await expect(costs.getByRole("button", { name: "Opravit" })).toBeDisabled();
  await expect(
    costs.getByRole("button", { name: "Zapsat skutečný náklad" }),
  ).toBeDisabled();
  await expect(spend.getByRole("button", { name: "Opravit" })).toBeDisabled();
  await expect(
    spend.getByRole("button", { name: "Zapsat akviziční výdaj" }),
  ).toBeDisabled();
  releaseSpendWrite?.();
  await expect(page.locator(".form-success")).toContainText("Důkaz byl zapsán");
  await expect(
    page.getByRole("button", { name: "Další objednávky" }),
  ).toBeVisible();
  await page.route(/\/admin\/metrics\?/, (route) =>
    route.fulfill({ status: 503, json: { message: "report unavailable" } }),
  );
  await page.getByRole("textbox", { name: "Začátek" }).fill("2026-09-03");
  await page.getByRole("button", { name: "Načíst report" }).click();
  await expect(page.getByRole("alert")).toContainText("Služba není dostupná");
  await expect(page.getByText("v0-1 preflight:", { exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Další objednávky" }),
  ).toHaveCount(0);
});
