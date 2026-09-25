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
        return route.fulfill({ status: 500, json: { message: "uncertain" } });
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

test("a non-admin operator can measure work but cannot enter manual evidence or financial costs", async ({
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
          role: "OPERATOR",
          nodeIds: [nodeId],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
          permissions: ["operations:read", "operations:write"],
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
  await expect(
    page.getByRole("button", { name: "Spustit měření" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ruční záznam práce/cesty" }),
  ).toHaveCount(0);
  expect(costRequests).toBe(0);
});

test("failed-job preparation survives async refresh and submits the returned candidate", async ({
  page,
}) => {
  const jobId = "00000000-0000-0000-0000-000000000071";
  const requestId = "00000000-0000-0000-0000-000000000072";
  const preparationId = "00000000-0000-0000-0000-000000000073";
  const candidateId = "00000000-0000-0000-0000-000000000074";
  const preparation = {
    preparationId,
    kind: "JOB_REPLACEMENT",
    status: "CANDIDATES_AVAILABLE",
    generation: 1,
    orderId,
    targetId: jobId,
    requestedAt: "2026-09-25T08:00:00Z",
    sourceJobIds: [jobId],
    dispatchCount: 1,
    pendingCount: 0,
    failedCount: 0,
    blockingCodes: [],
    sources: [
      {
        sourceJobId: jobId,
        quantity: 1,
        fulfilmentSlotIds: ["slot-1"],
        selectableCount: 1,
        pendingCount: 0,
        failedCount: 0,
        blockingCodes: [],
      },
    ],
  };
  let prepared = false;
  let finalBody: unknown;
  await installFixtures(
    page,
    () => null,
    () => "PENDING",
    () => ({
      ...orderDetail(null),
      fulfilment: {
        ...orderDetail(null).fulfilment,
        jobs: [{ id: jobId, status: "FAILED" }],
        replacementRequests: [
          { id: requestId, sourceJobId: jobId, status: "OPEN" },
        ],
      },
      actions: [
        {
          action: "PREPARE_REPLACEMENT",
          targetType: "JOB",
          targetId: jobId,
          enabled: false,
          blockingCodes: ["FRESH_RESERVATION_REQUIRED"],
          requiresReason: true,
          requiresConfirmation: false,
        },
      ],
    }),
  );
  await page.route(
    `**/admin/orders/${orderId}/fulfilment/jobs/${jobId}/replacement-preparations**`,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({
          expectedReplacementRequestId: requestId,
          reason: "Selhaný tisk",
        });
        prepared = true;
        return route.fulfill({ json: { preparationId, generation: 1 } });
      }
      if (path.endsWith("/candidates"))
        return route.fulfill({
          json: {
            items: [
              {
                sourceJobId: jobId,
                candidateResourceEstimateId: candidateId,
                machineId: "machine-1",
                machineProfileId: "profile-1",
                machineCalibrationId: "calibration-1",
                inventoryId: "inventory-1",
                printConfigRevisionId: "config-1",
                material: "PLA",
                quantity: 1,
                partsPerPlate: 1,
                requiredMaterialMilligrams: "1000",
                requiredMachineSeconds: "3600",
                calculatedAt: "2026-09-25T08:00:00Z",
                expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
                intervals: [],
                selectable: true,
                blockingCodes: [],
              },
            ],
          },
        });
      if (path.endsWith(preparationId))
        return route.fulfill({ json: preparation });
      return route.fulfill({ json: { items: prepared ? [preparation] : [] } });
    },
  );
  await page.route(
    `**/admin/orders/${orderId}/fulfilment/jobs/${jobId}/replacement`,
    (route) => {
      finalBody = route.request().postDataJSON();
      return route.fulfill({
        json: { orderId, status: "REPLACEMENT_CREATED", result: {} },
      });
    },
  );
  await page.goto(`/objednavky?order=${orderId}`);
  await page
    .getByRole("button", { name: `Připravit náhradu úlohy ${jobId}` })
    .click();
  await page
    .getByRole("textbox", { name: "Důvod přípravy" })
    .fill("Selhaný tisk");
  await page
    .getByRole("button", { name: "Připravit čerstvé kandidáty" })
    .click();
  await expect(
    page.getByText("Příprava 1 · CANDIDATES_AVAILABLE"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Načíst aktuální volby" }).click();
  await page.getByRole("radio", { name: /Stroj machine-1/ }).check();
  await page
    .getByRole("textbox", { name: "Důvod potvrzení" })
    .fill("Schválená náhrada");
  await page
    .getByRole("checkbox", { name: /Potvrzuji aktuální kandidáty/ })
    .check();
  await page.getByRole("button", { name: "Vytvořit náhradní úlohu" }).click();
  await expect
    .poll(() => finalBody)
    .toEqual({
      reason: "Schválená náhrada",
      candidateResourceEstimateId: candidateId,
    });
});

test("printing failure scopes consumption to the selected recovery", async ({
  page,
}) => {
  const targetId = "00000000-0000-0000-0000-000000000091";
  const siblingId = "00000000-0000-0000-0000-000000000092";
  const bodies: Record<string, unknown>[] = [];
  await installFixtures(
    page,
    () => null,
    () => "PENDING",
    () => ({
      ...orderDetail(null),
      fulfilment: {
        ...orderDetail(null).fulfilment,
        jobs: [targetId, siblingId].map((id) => ({
          id,
          status: "PRINTING",
          shipmentPlanId: "plan-1",
          replacesJobId: null,
          shipmentAssignment: null,
        })),
      },
      actions: [
        {
          action: "FAIL_JOB",
          targetType: "JOB",
          targetId,
          enabled: false,
          blockingCodes: ["FAILURE_DETAILS_REQUIRED"],
          requiresReason: true,
          requiresConfirmation: false,
        },
      ],
    }),
  );
  await page.route(
    `**/admin/orders/${orderId}/fulfilment/jobs/${targetId}/failure`,
    (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        json: { orderId, status: "JOB_FAILED", result: {} },
      });
    },
  );
  await page.goto(`/objednavky?order=${orderId}`);
  await page.getByRole("button", { name: "Zaznamenat selhání" }).click();
  await page.getByRole("textbox", { name: "Důvod" }).fill("Selhal stroj");
  await expect(
    page.getByRole("textbox", { name: "Skutečná spotřeba materiálu (mg)" }),
  ).toHaveAttribute("required", "");
  await page
    .getByRole("textbox", { name: "Skutečná spotřeba materiálu (mg)" })
    .fill("1200");
  await expect(
    page.getByRole("textbox", {
      name: `Skutečná spotřeba běžící úlohy ${siblingId} (mg)`,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Potvrdit krok" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({
    recovery: "REPLACE",
    actualMaterialMilligrams: "1200",
  });
  expect(bodies[0]).not.toHaveProperty("printingConsumptions");
  await page.getByRole("button", { name: "Zaznamenat selhání" }).click();
  await page.getByRole("textbox", { name: "Důvod" }).fill("Refundovat balík");
  await page.getByRole("combobox", { name: "Náprava" }).selectOption("REFUND");
  await page
    .getByRole("textbox", { name: "Skutečná spotřeba materiálu (mg)" })
    .fill("1300");
  await page
    .getByRole("textbox", {
      name: `Skutečná spotřeba běžící úlohy ${siblingId} (mg)`,
    })
    .fill("800");
  await expect(
    page.getByRole("textbox", {
      name: `Skutečná spotřeba běžící úlohy ${targetId} (mg)`,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Potvrdit krok" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({
    recovery: "REFUND",
    actualMaterialMilligrams: "1300",
    printingConsumptions: [
      { jobId: siblingId, actualMaterialMilligrams: "800" },
    ],
  });
});

test("claim origin controls incident shipment evidence", async ({ page }) => {
  const shipmentId = "00000000-0000-0000-0000-000000000093";
  const slotId = "00000000-0000-0000-0000-000000000094";
  let body: unknown;
  await installFixtures(
    page,
    () => null,
    () => "PENDING",
    () => ({
      ...orderDetail(null),
      fulfilment: {
        ...orderDetail(null).fulfilment,
        slots: [{ id: slotId, status: "DELIVERED" }],
        shipments: [
          {
            id: shipmentId,
            status: "DELIVERED",
            shipmentPlanId: "plan-1",
            replacesShipmentId: null,
            jobAssignments: [],
            carrierLabelId: "label-1",
          },
        ],
      },
      actions: [
        {
          action: "CREATE_CLAIM",
          targetType: "ORDER",
          targetId: orderId,
          enabled: false,
          blockingCodes: ["CLAIM_DETAILS_REQUIRED"],
          requiresReason: true,
          requiresConfirmation: false,
        },
      ],
    }),
  );
  await page.route(`**/admin/orders/${orderId}/fulfilment/claims`, (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      json: { orderId, status: "CLAIM_CREATED", result: {} },
    });
  });
  await page.goto(`/objednavky?order=${orderId}`);
  await page.getByRole("button", { name: "Otevřít reklamaci" }).click();
  await page.getByRole("textbox", { name: "Důvod" }).fill("Poškození");
  await page.getByRole("checkbox", { name: slotId }).check();
  await page.getByRole("button", { name: "Potvrdit krok" }).click();
  await expect(
    page.getByRole("combobox", { name: "Dotčená zásilka" }),
  ).toHaveAttribute("required", "");
  expect(body).toBeUndefined();
  await page
    .getByRole("combobox", { name: "Dotčená zásilka" })
    .selectOption(shipmentId);
  await page
    .getByRole("combobox", { name: "Původ" })
    .selectOption("POST_DELIVERY_QUALITY");
  await expect(
    page.getByRole("combobox", { name: "Dotčená zásilka" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Potvrdit krok" }).click();
  await expect
    .poll(() => body)
    .toEqual({
      fulfilmentSlotIds: [slotId],
      origin: "POST_DELIVERY_QUALITY",
      reason: "Poškození",
    });
});

test("repeated LOST reprint requires a candidate for every source job", async ({
  page,
}) => {
  const claimId = "00000000-0000-0000-0000-000000000081";
  const predecessorId = "00000000-0000-0000-0000-000000000082";
  const originalId = "00000000-0000-0000-0000-000000000083";
  const sourceIds = [
    "00000000-0000-0000-0000-000000000084",
    "00000000-0000-0000-0000-000000000085",
  ];
  const preparationId = "00000000-0000-0000-0000-000000000086";
  const preparation = {
    preparationId,
    kind: "LOST_CLAIM_REPRINT",
    status: "CANDIDATES_AVAILABLE",
    generation: 2,
    orderId,
    targetId: claimId,
    predecessorShipmentId: predecessorId,
    requestedAt: "2026-09-25T08:00:00Z",
    sourceJobIds: sourceIds,
    dispatchCount: 2,
    pendingCount: 0,
    failedCount: 0,
    blockingCodes: [],
    sources: sourceIds.map((sourceJobId, index) => ({
      sourceJobId,
      quantity: index + 1,
      fulfilmentSlotIds: [`slot-${index}`],
      selectableCount: 1,
      pendingCount: 0,
      failedCount: 0,
      blockingCodes: [],
    })),
  };
  let prepared = false;
  let finalBody: unknown;
  await installFixtures(
    page,
    () => null,
    () => "PENDING",
    () => ({
      ...orderDetail(null),
      fulfilment: {
        ...orderDetail(null).fulfilment,
        claims: [
          {
            id: claimId,
            origin: "SHIPMENT_INCIDENT",
            status: "OPEN",
            reason: "Původní balík se ztratil",
            incidentShipmentId: originalId,
            resolutions: [
              {
                id: "resolution-first-page",
                status: "RESOLVED",
                fulfilmentSlotId: "slot-0",
              },
            ],
            refunds: [],
            reshipmentAuthorizations: [
              { id: "reship-first-page", reshipmentShipmentId: predecessorId },
            ],
          },
        ],
        shipments: [
          {
            id: originalId,
            status: "LOST",
            shipmentPlanId: "plan-1",
            replacesShipmentId: null,
            reprintClaimId: null,
            jobAssignments: [],
            carrierLabelId: null,
          },
          {
            id: predecessorId,
            status: "LOST",
            shipmentPlanId: "plan-1",
            replacesShipmentId: originalId,
            reprintClaimId: claimId,
            jobAssignments: [],
            carrierLabelId: null,
          },
        ],
      },
    }),
  );
  await page.route(
    `**/admin/orders/${orderId}/fulfilment/claims/${claimId}/reprint-preparations**`,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({
          expectedPredecessorShipmentId: predecessorId,
          reason: "Druhá ztracená zásilka",
        });
        prepared = true;
        return route.fulfill({ json: { preparationId, generation: 2 } });
      }
      if (path.endsWith("/candidates")) {
        const sourceJobId = new URL(route.request().url()).searchParams.get(
          "sourceJobId",
        )!;
        return route.fulfill({
          json: {
            items: [
              {
                sourceJobId,
                candidateResourceEstimateId: `candidate-${sourceJobId}`,
                machineId: "machine-1",
                machineProfileId: "profile-1",
                machineCalibrationId: "calibration-1",
                inventoryId: "inventory-1",
                printConfigRevisionId: "config-1",
                material: "PLA",
                quantity: sourceIds.indexOf(sourceJobId) + 1,
                partsPerPlate: 1,
                requiredMaterialMilligrams: "1000",
                requiredMachineSeconds: "3600",
                calculatedAt: "2026-09-25T08:00:00Z",
                expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
                intervals: [],
                selectable: true,
                blockingCodes: [],
              },
            ],
          },
        });
      }
      if (path.endsWith(preparationId))
        return route.fulfill({ json: preparation });
      return route.fulfill({ json: { items: prepared ? [preparation] : [] } });
    },
  );
  await page.route(
    `**/admin/orders/${orderId}/fulfilment/claims/${claimId}/reprint`,
    (route) => {
      finalBody = route.request().postDataJSON();
      return route.fulfill({
        json: { orderId, status: "REPRINT_CREATED", result: {} },
      });
    },
  );
  await page.goto(`/objednavky?order=${orderId}`);
  await expect(
    page.getByText(/resolution-first-page · RESOLVED/),
  ).toBeVisible();
  await expect(page.getByText(/reship-first-page/)).toBeVisible();
  await page
    .getByRole("button", {
      name: `Připravit opakovanou zásilku pro reklamaci ${claimId} · ${predecessorId}`,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Důvod přípravy" })
    .fill("Druhá ztracená zásilka");
  await page
    .getByRole("button", { name: "Připravit čerstvé kandidáty" })
    .click();
  await expect(
    page.getByText("Příprava 2 · CANDIDATES_AVAILABLE"),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Důvod potvrzení" })
    .fill("Celý balík znovu");
  await page
    .getByRole("checkbox", { name: /Potvrzuji aktuální kandidáty/ })
    .check();
  const confirm = page.getByRole("button", {
    name: "Vytvořit celou opakovanou zásilku",
  });
  await expect(confirm).toBeDisabled();
  await page
    .getByRole("button", { name: "Načíst aktuální volby" })
    .nth(0)
    .click();
  await page
    .getByRole("radio", { name: /Stroj machine-1/ })
    .nth(0)
    .check();
  await expect(confirm).toBeDisabled();
  await page
    .getByRole("button", { name: "Načíst aktuální volby" })
    .nth(1)
    .click();
  await page
    .getByRole("radio", { name: /Stroj machine-1/ })
    .nth(1)
    .check();
  await confirm.click();
  await expect
    .poll(() => finalBody)
    .toEqual({
      reason: "Celý balík znovu",
      replacements: sourceIds.map((sourceJobId) => ({
        sourceJobId,
        candidateResourceEstimateId: `candidate-${sourceJobId}`,
      })),
    });
});

test("late artifact response cannot appear under a different selected job", async ({
  page,
}) => {
  const firstId = "00000000-0000-0000-0000-000000000095";
  const secondId = "00000000-0000-0000-0000-000000000096";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await installFixtures(
    page,
    () => null,
    () => "PENDING",
    () => ({
      ...orderDetail(null),
      fulfilment: {
        ...orderDetail(null).fulfilment,
        jobs: [firstId, secondId].map((id) => ({
          id,
          status: "ACCEPTED",
          shipmentPlanId: "plan-1",
          replacesJobId: null,
          shipmentAssignment: null,
        })),
      },
    }),
  );
  await page.route("**/admin/jobs/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    return route.fulfill({
      json: {
        id,
        orderId,
        status: "ACCEPTED",
        shipmentPlanOrdinal: 1,
        estimate: {
          machineId: "machine-1",
          inventoryId: "inventory-1",
          inventoryMountStatus: "MOUNTED",
          requiredMaterialMilligrams: "1000",
          requiredMachineSeconds: "3600",
        },
        deadline: { date: null, provenance: "NO_PROMISED_DATE" },
        slots: [],
        artifacts: {
          sourceModel: { available: true, reason: null },
          preview: { available: false, reason: "NOT_GENERATED" },
          production: { available: false, reason: "NOT_GENERATED" },
        },
        actions: [],
      },
    });
  });
  await page.route(
    `**/admin/jobs/${firstId}/artifacts/SOURCE_MODEL/download`,
    async (route) => {
      await gate;
      await route.fulfill({
        json: {
          downloadUrl: "https://example.com/first-job.stl",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          contentLength: "100",
          contentType: "model/stl",
          sha256: "hash",
        },
      });
    },
  );
  await page.goto(`/objednavky?order=${orderId}`);
  await page.getByRole("button", { name: firstId }).click();
  await expect(
    page.getByRole("heading", { name: `Úloha ${firstId} · ACCEPTED` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stáhnout SOURCE_MODEL" }).click();
  await page.getByRole("button", { name: secondId }).click();
  await expect(
    page.getByRole("heading", { name: `Úloha ${secondId} · ACCEPTED` }),
  ).toBeVisible();
  const lateResponse = page.waitForResponse(
    `**/admin/jobs/${firstId}/artifacts/SOURCE_MODEL/download`,
  );
  release();
  await (await lateResponse).finished();
  await expect(
    page.getByRole("link", { name: "Otevřít SOURCE_MODEL soubor" }),
  ).toHaveCount(0);
});
