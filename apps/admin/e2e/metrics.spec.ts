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
  await page.route(/\/admin\/metrics(?:\/orders)?\?/, (route) =>
    route.fulfill({
      json: route.request().url().includes("/orders?") ? { items: [] } : report,
    }),
  );
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
  await page.route("**/admin/acquisition-spend*", (route) =>
    route.fulfill({ json: { items: [], scope: "PLATFORM" } }),
  );
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
});
