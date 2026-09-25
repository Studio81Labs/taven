import { expect, test } from "@playwright/test";

const orderId = "00000000-0000-0000-0000-000000000034";
const refundId = "00000000-0000-0000-0000-000000000035";
const paymentId = "00000000-0000-0000-0000-000000000036";
const nodeId = "00000000-0000-0000-0000-000000000037";
const eventId = "00000000-0000-0000-0000-000000000038";

function orderDetail(action: string | null) {
  return {
    id: orderId,
    publicReference: "TV-34",
    status: "CANCELLED",
    confirmedAt: "2026-09-25T08:00:00Z",
    blockingCodes: ["COMPENSATION_DUE", "REFUND_FAILED"],
    financial: {
      blockingCodes: ["COMPENSATION_DUE", "REFUND_FAILED"],
      outstandingCompensationMinor: "12000",
      payments: [],
      settlements: [],
    },
    fulfilment: {
      orderId,
      orderStatus: "CANCELLED",
      phase: { id: "phase-1", status: "CANCELLED" },
      jobs: [],
      shipments: [],
      slots: [],
      replacementRequests: [],
      claims: [],
      priceAdjustments: [],
    },
    fulfilmentNextCursors: {},
    items: [],
    legalAcceptances: [],
    shipmentPlans: [],
    slotLineage: [],
    timeline: [],
    actions: action
      ? [
          {
            action,
            targetType: "REFUND",
            targetId: refundId,
            enabled: true,
            blockingCodes: [],
            requiresReason: true,
            requiresConfirmation: true,
          },
        ]
      : [],
  };
}

function refund(status: "PENDING" | "FAILED") {
  return {
    id: refundId,
    paymentId,
    amountMinor: "12000",
    currency: "CZK",
    provider: "comgate",
    providerIntentId: "payment-provider-1",
    providerRefundId: null,
    requestReference: "refund-root-key",
    status,
    reason: "CUSTOMER_CANCELLATION",
    requestedAt: "2026-09-25T08:01:00Z",
    dispatchStatus: "FAILED",
    dispatchClaimedAt: "2026-09-25T08:02:00Z",
    providerResultEventId: status === "FAILED" ? eventId : null,
    selectedResultKind: status === "FAILED" ? "REFUND_FAILED" : null,
    selectedResultSource: status === "FAILED" ? "OPERATOR_ATTESTED" : null,
    replacementRefundIds: [],
    replacesRefundTransactionId: null,
  };
}

async function installFixtures(
  page: import("@playwright/test").Page,
  action: () => string | null,
  status: () => "PENDING" | "FAILED",
  detail: () => object = () => orderDetail(action()),
) {
  await page.route("**/admin/auth/session", (route) =>
    route.fulfill({
      json: {
        csrfToken: "csrf-test",
        operator: {
          operatorId: "operator-1",
          role: "ADMIN",
          nodeIds: [nodeId],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
          permissions: [
            "operations:read",
            "operations:write",
            "financial:exception",
          ],
        },
      },
    }),
  );
  await page.route("**/admin/orders**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fallback();
    if (path === "/admin/orders")
      return route.fulfill({
        json: {
          items: [
            {
              id: orderId,
              publicReference: "TV-34",
              status: "CANCELLED",
              createdAt: "2026-09-25T08:00:00Z",
            },
          ],
        },
      });
    if (path === `/admin/orders/${orderId}`)
      return route.fulfill({ json: detail() });
    if (path === `/admin/orders/${orderId}/refunds`)
      return route.fulfill({ json: { items: [refund(status())] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.route("**/admin/jobs**", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/admin/handling-sessions**", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
}

test("refund retry uses the selected failure receipt and refreshes after a conflict", async ({
  page,
}) => {
  let posts = 0;
  let sentBody: unknown;
  let sentHeaders: Record<string, string> = {};
  await installFixtures(
    page,
    () => "RETRY_REFUND",
    () => "FAILED",
  );
  await page.route(
    `**/admin/orders/${orderId}/fulfilment/refunds/${refundId}/retry`,
    (route) => {
      posts += 1;
      sentBody = route.request().postDataJSON();
      sentHeaders = route.request().headers();
      return route.fulfill({ status: 409, json: { message: "stale failure" } });
    },
  );
  await page.goto(`/objednavky?order=${orderId}`);
  await expect(page.getByText("Nevyřešené překážky")).toBeVisible();
  await expect(
    page.getByText("Finanční incident vyžaduje ověření."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Jednou zopakovat selhané vrácení" })
    .click();
  await page
    .getByRole("textbox", { name: "Důvod" })
    .fill("Ověřené finální selhání u poskytovatele");
  await page.getByRole("checkbox", { name: /Potvrzuji dopad/ }).check();
  await page.getByRole("button", { name: "Potvrdit krok" }).click();
  await expect(page.getByText(/Údaje se mezitím změnily/)).toBeVisible();
  expect(posts).toBe(1);
  expect(sentBody).toEqual({
    expectedFailureProviderEventId: eventId,
    reason: "Ověřené finální selhání u poskytovatele",
  });
  expect(sentHeaders["idempotency-key"]).toBeTruthy();
  expect(sentHeaders["x-csrf-token"]).toBe("csrf-test");
});

test("uncertain provider attestation retries the frozen command with one key", async ({
  page,
}) => {
  let calls = 0;
  const bodies: unknown[] = [];
  const keys: string[] = [];
  let action: string | null = "RECORD_REFUND_PROVIDER_RESULT";
  let status: "PENDING" | "FAILED" = "PENDING";
  await installFixtures(
    page,
    () => action,
    () => status,
  );
  await page.route(
    `**/admin/orders/${orderId}/fulfilment/refunds/${refundId}/provider-results`,
    (route) => {
      calls += 1;
      bodies.push(route.request().postDataJSON());
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (calls === 1)
        return route.fulfill({ status: 503, json: { message: "uncertain" } });
      action = null;
      status = "FAILED";
      return route.fulfill({
        json: {
          orderId,
          status: "REFUND_PROVIDER_RESULT_RECORDED",
          result: {
            recorded: true,
            refundTransactionId: refundId,
            refundStatus: "FAILED",
            paymentStatus: "CAPTURED",
            providerResultEventId: eventId,
          },
        },
      });
    },
  );
  await page.goto(`/objednavky?order=${orderId}`);
  await page
    .getByRole("button", { name: "Zapsat konečný výsledek poskytovatele" })
    .click();
  await page.getByRole("textbox", { name: "Důvod" }).fill("Ověřeno u podpory");
  await page
    .getByRole("textbox", { name: /Číslo případu nebo reference důkazu/ })
    .fill("support-case-42");
  await page
    .getByRole("textbox", { name: "Čas výsledku včetně pásma" })
    .fill("2026-09-25T10:00:00+02:00");
  await page
    .getByRole("checkbox", { name: /Ověřil\(a\) jsem konečný výsledek/ })
    .check();
  await page.getByRole("checkbox", { name: /Potvrzuji dopad/ }).check();
  await page.getByRole("button", { name: "Potvrdit krok" }).click();
  await expect(
    page.getByText(/Výsledek předchozího zápisu není jistý/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Opakovat stejný požadavek" }).click();
  await expect(
    page.getByText(/Výsledek původního požadavku byl potvrzen/),
  ).toBeVisible();
  expect(calls).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    expectedStatus: "PENDING",
    amountMinor: "12000",
    currency: "CZK",
    providerIntentId: "payment-provider-1",
    requestReference: "refund-root-key",
    finalOutcomeConfirmed: true,
  });
});

test("an open handling timer survives reload and stops with one measured allocation", async ({
  page,
}) => {
  const handlingId = "00000000-0000-0000-0000-000000000039";
  let open = true;
  let stoppedBody: unknown;
  let stoppedKey = "";
  await installFixtures(
    page,
    () => null,
    () => "PENDING",
  );
  await page.route("**/admin/handling-sessions**", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      stoppedBody = route.request().postDataJSON();
      stoppedKey = route.request().headers()["idempotency-key"] ?? "";
      open = false;
      return route.fulfill({ json: { id: handlingId, status: "COMPLETED" } });
    }
    return route.fulfill({
      json: {
        items:
          open && url.searchParams.get("lifecycle") === "OPEN"
            ? [
                {
                  id: handlingId,
                  nodeId,
                  operatorIdentityId: "operator-1",
                  component: "SHIPPING_TRIP",
                  lifecycle: "OPEN",
                  startedAt: "2026-09-25T08:30:00Z",
                  allocations: [],
                },
              ]
            : [],
      },
    });
  });
  await page.goto(`/objednavky?order=${orderId}`);
  await expect(
    page.getByText(`SHIPPING_TRIP · od`, { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Zastavit a přiřadit" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zastavit a přiřadit" }).click();
  await page.getByRole("button", { name: "Potvrdit", exact: true }).click();
  await expect(
    page.getByText(/HANDLING_STOP: výsledek potvrzen/),
  ).toBeVisible();
  expect(stoppedBody).toEqual({
    allocations: [{ orderId, servedUnitCount: "1" }],
  });
  expect(stoppedKey).toBeTruthy();
});

test("packing offers only a shipment from the job's plan", async ({ page }) => {
  const jobId = "00000000-0000-0000-0000-000000000040";
  const matchingShipment = "00000000-0000-0000-0000-000000000041";
  const foreignPlanShipment = "00000000-0000-0000-0000-000000000042";
  let packedBody: unknown;
  let packedKey = "";
  const detail = () => ({
    ...orderDetail(null),
    status: "PRODUCTION",
    blockingCodes: [],
    financial: {
      ...orderDetail(null).financial,
      blockingCodes: [],
      outstandingCompensationMinor: "0",
    },
    fulfilment: {
      ...orderDetail(null).fulfilment,
      orderStatus: "PRODUCTION",
      jobs: [
        {
          id: jobId,
          status: "QC_APPROVED",
          shipmentPlanId: "plan-a",
          replacesJobId: null,
          shipmentAssignment: null,
        },
      ],
      shipments: [
        {
          id: matchingShipment,
          status: "PLANNED",
          shipmentPlanId: "plan-a",
          replacesShipmentId: null,
          jobAssignments: [],
          carrierLabelId: null,
        },
        {
          id: foreignPlanShipment,
          status: "PLANNED",
          shipmentPlanId: "plan-b",
          replacesShipmentId: null,
          jobAssignments: [],
          carrierLabelId: null,
        },
      ],
    },
    actions: [
      {
        action: "PACK_JOB",
        targetType: "JOB",
        targetId: jobId,
        enabled: true,
        blockingCodes: [],
        requiresReason: false,
        requiresConfirmation: false,
      },
    ],
  });
  await installFixtures(
    page,
    () => null,
    () => "PENDING",
    detail,
  );
  await page.route(
    `**/admin/orders/${orderId}/fulfilment/jobs/${jobId}/packing`,
    (route) => {
      packedBody = route.request().postDataJSON();
      packedKey = route.request().headers()["idempotency-key"] ?? "";
      return route.fulfill({
        json: { orderId, status: "JOB_PACKED", result: {} },
      });
    },
  );
  await page.goto(`/objednavky?order=${orderId}`);
  await page.getByRole("button", { name: "Zabalit úlohu" }).click();
  const shipment = page.getByRole("combobox", {
    name: "Zásilka stejného plánu",
  });
  await expect(shipment.locator("option")).toHaveCount(2);
  await expect(
    shipment.locator(`option[value="${matchingShipment}"]`),
  ).toHaveCount(1);
  await expect(
    shipment.locator(`option[value="${foreignPlanShipment}"]`),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Potvrdit krok" }).click();
  expect(packedBody).toEqual({ shipmentId: matchingShipment });
  expect(packedKey).toBeTruthy();
});

test("a read-only operator can inspect an order without financial cost access", async ({
  page,
}) => {
  let costRequests = 0;
  await installFixtures(
    page,
    () => null,
    () => "PENDING",
  );
  await page.route("**/admin/auth/session", (route) =>
    route.fulfill({
      json: {
        csrfToken: "csrf-viewer",
        operator: {
          operatorId: "viewer-1",
          role: "VIEWER",
          nodeIds: [nodeId],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
          permissions: ["operations:read"],
        },
      },
    }),
  );
  await page.route(`**/admin/orders/${orderId}/actual-costs`, (route) => {
    costRequests += 1;
    return route.fulfill({ status: 403, json: { message: "forbidden" } });
  });
  await page.goto(`/objednavky?order=${orderId}`);
  await expect(page.getByRole("heading", { name: /TV-34/ })).toBeVisible();
  await expect(
    page.getByText("Zobrazení nákladů vyžaduje finanční oprávnění."),
  ).toBeVisible();
  expect(costRequests).toBe(0);
});
