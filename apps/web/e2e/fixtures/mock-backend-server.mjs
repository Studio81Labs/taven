import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.MOCK_BACKEND_PORT || 4175);

let testState = {
  legalStatus: "approved", // "approved" | "draft" | "error503"
  legalEvaluatedAt: null, // custom ISO string or null for current UTC
  capacityStatus: "available", // "available" | "out_of_capacity"
  expressEligible: true,
  paymentOutcome: "CAPTURED", // "CAPTURED" | "PENDING" | "FAILED" | "CANCELLED"
  recordedObservations: [],
};

const sessions = new Map();

function resetState() {
  testState = {
    legalStatus: "approved",
    legalEvaluatedAt: null,
    capacityStatus: "available",
    expressEligible: true,
    paymentOutcome: "CAPTURED",
    recordedObservations: [],
  };
  sessions.clear();
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "*",
  });
  res.end(JSON.stringify(body));
}

function parseJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function createDefaultSession(sessionId = "session-test-001") {
  return {
    sessionId,
    sessionToken: `token-${sessionId}`,
    orderId: "00000000-0000-0000-0000-000000000001",
    publicReference: "TAV-2026-TEST",
    phase: "DESTINATION_REQUIRED",
    configurationRevision: 1,
    configurationEditable: true,
    checkoutReady: false,
    checkoutEvidenceAccepted: false,
    expiresAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    modelFiles: [
      {
        modelFileId: "file-test-001",
        format: "STL",
        discoveredBodyIds: ["body-1"],
        inspectionStatus: "SUCCEEDED",
      },
    ],
    items: [
      {
        id: "00000000-0000-0000-0000-000000000010",
        modelFileId: "file-test-001",
        ordinal: 0,
        bodyIds: ["body-1"],
        material: "PLA",
        quality: "STANDARD",
        color: "BLACK",
        infillPreset: "STANDARD",
        fitSensitive: false,
        quantity: 1,
        status: "READY",
        printConfigRevisionId: "00000000-0000-0000-0000-000000000001",
        findings: [],
      },
    ],
    configurationOptions: [
      {
        material: "PLA",
        quality: "DRAFT",
        infillPreset: "STANDARD",
        color: "BLACK",
        printConfigRevisionId: "00000000-0000-0000-0000-000000000001",
      },
      {
        material: "PLA",
        quality: "STANDARD",
        infillPreset: "STANDARD",
        color: "BLACK",
        printConfigRevisionId: "00000000-0000-0000-0000-000000000001",
      },
      {
        material: "PLA",
        quality: "FINE",
        infillPreset: "STANDARD",
        color: "BLACK",
        printConfigRevisionId: "00000000-0000-0000-0000-000000000001",
      },
    ],
    quantityComparisons: [
      {
        itemOrdinal: 0,
        quantity: 1,
        currency: "CZK",
        orderTotalMinor: 35000,
      },
      {
        itemOrdinal: 0,
        quantity: 5,
        currency: "CZK",
        orderTotalMinor: 140000,
      },
      {
        itemOrdinal: 0,
        quantity: 20,
        currency: "CZK",
        orderTotalMinor: 480000,
      },
    ],
    deliveryOptions: [
      {
        providerEndpointId: "packeta-1",
        endpointType: "pickup_point",
        label: "Zásilkovna — Výdejní místo",
      },
    ],
    deliverySelector: {
      mode: "CONFIGURED",
      available: true,
      allowedEndpointTypes: ["pickup_point"],
    },
    selectedDeliveryDestination: null,
    express: {
      eligible: true,
      requested: false,
      reasons: [],
    },
    roughEstimate: {
      kind: "ROUGH_ESTIMATE",
      currency: "CZK",
      netAmountMinor: 28926,
      vatAmountMinor: 6074,
      totalMinor: 35000,
      vatRateBasisPoints: 2100,
      taxRegime: "VAT_PAYER",
      components: [
        {
          id: "base-cost",
          kind: "BASE_COST",
          amountMinor: 35000,
          label: "Základní výroba (STANDARD)",
        },
      ],
    },
    bindingQuote: null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  // --- Test control endpoints ---
  if (pathname === "/__test/reset" && method === "POST") {
    resetState();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/__test/state" && method === "POST") {
    const body = await parseJson(req);
    Object.assign(testState, body);
    sendJson(res, 200, { ok: true, state: testState });
    return;
  }

  if (pathname === "/__test/state" && method === "GET") {
    sendJson(res, 200, testState);
    return;
  }

  // --- Mock payment gateway simulator ---
  if (pathname === "/mock-gateway" && method === "GET") {
    const paymentId = url.searchParams.get("paymentId") || "pay-test-123";
    const sessionId = url.searchParams.get("sessionId") || "session-test-001";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Mock Platební Brána</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>Testovací platební brána</h1>
  <p>Payment ID: <code>${paymentId}</code></p>
  <p>Session ID: <code>${sessionId}</code></p>
  <div style="display: flex; gap: 1rem; margin-top: 2rem;">
    <button id="btn-pay-success" onclick="fetch('http://127.0.0.1:4175/__test/state', {method:'POST', body: JSON.stringify({paymentOutcome:'CAPTURED'})}).then(() => { window.location.href='http://127.0.0.1:4174/checkout/payment/success?paymentId=${paymentId}&sessionId=${sessionId}'; })">
      Zaplatit (Úspěch - CAPTURED)
    </button>
    <button id="btn-pay-pending" onclick="fetch('http://127.0.0.1:4175/__test/state', {method:'POST', body: JSON.stringify({paymentOutcome:'PENDING'})}).then(() => { window.location.href='http://127.0.0.1:4174/checkout/payment/pending?paymentId=${paymentId}&sessionId=${sessionId}'; })">
      Čeká na zpracování (PENDING)
    </button>
    <button id="btn-pay-fail" onclick="fetch('http://127.0.0.1:4175/__test/state', {method:'POST', body: JSON.stringify({paymentOutcome:'FAILED'})}).then(() => { window.location.href='http://127.0.0.1:4174/checkout/payment/cancelled?paymentId=${paymentId}&sessionId=${sessionId}'; })">
      Zamítnout (FAILED)
    </button>
    <button id="btn-pay-cancel" onclick="fetch('http://127.0.0.1:4175/__test/state', {method:'POST', body: JSON.stringify({paymentOutcome:'CANCELLED'})}).then(() => { window.location.href='http://127.0.0.1:4174/checkout/payment/cancelled?paymentId=${paymentId}&sessionId=${sessionId}'; })">
      Zrušit platbu
    </button>
  </div>
</body>
</html>`);
    return;
  }

  // --- S3 Presigned Upload Mock ---
  if (pathname === "/mock-upload" && (method === "PUT" || method === "POST")) {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  // --- 1. Legal Document Availability ---
  if (pathname === "/legal-documents/availability" && method === "GET") {
    if (testState.legalStatus === "error503") {
      sendJson(res, 503, {
        statusCode: 503,
        message: "Legal gate unavailable",
      });
      return;
    }
    const status = testState.legalStatus === "approved" ? "approved" : "draft";
    const evaluatedAt = testState.legalEvaluatedAt || new Date().toISOString();
    sendJson(res, 200, {
      schemaVersion: 1,
      policyRevision: "legal-policy-test-fixture-v1",
      evaluatedAt,
      documents: {
        terms: {
          revision: "terms-test-v1",
          status,
          effectiveAt: "2000-01-01T00:00:00.000Z",
          approvalEvidence: "test fixture",
          effective: status === "approved",
        },
        claims: {
          revision: "claims-test-v1",
          status,
          effectiveAt: "2000-01-01T00:00:00.000Z",
          approvalEvidence: "test fixture",
          effective: status === "approved",
        },
        privacy: {
          revision: "privacy-test-v1",
          status,
          effectiveAt: "2000-01-01T00:00:00.000Z",
          approvalEvidence: "test fixture",
          effective: status === "approved",
        },
        prohibitedContent: {
          revision: "prohibited-content-test-v1",
          status,
          effectiveAt: "2000-01-01T00:00:00.000Z",
          approvalEvidence: "test fixture",
          effective: status === "approved",
        },
        retention: {
          revision: "retention-test-v1",
          status,
          effectiveAt: "2000-01-01T00:00:00.000Z",
          approvalEvidence: "test fixture",
          effective: status === "approved",
        },
        photoConsent: {
          revision: "photo-consent-test-v1",
          status,
          effectiveAt: "2000-01-01T00:00:00.000Z",
          approvalEvidence: "test fixture",
          effective: status === "approved",
        },
      },
    });
    return;
  }

  // --- 2. Baseline Provisional Estimate ---
  if (pathname === "/automatic-quote-estimates" && method === "POST") {
    if (testState.capacityStatus === "out_of_capacity") {
      sendJson(res, 503, {
        statusCode: 503,
        message: "Výrobní kapacita je dočasně vyčerpána.",
      });
      return;
    }
    const body = await parseJson(req);
    const quality = body.quality || "STANDARD";
    sendJson(res, 200, {
      priceListRevision: "fixture-price-list-v1",
      price: {
        kind: "ROUGH_ESTIMATE",
        currency: "CZK",
        netAmountMinor: 28926,
        vatAmountMinor: 6074,
        totalMinor: 35000,
        vatRateBasisPoints: 2100,
        taxRegime: "VAT_PAYER",
        components: [
          {
            id: "base-cost",
            kind: "BASE_COST",
            amountMinor: 35000,
            label: `Základní výroba (${quality})`,
          },
        ],
      },
      assumptions: {
        material: body.material || "PLA",
        quality: "STANDARD", // issue #147: Baseline visibly assumes STANDARD
        infillPreset: body.infillPreset || "STANDARD",
        quantity: body.quantity || 1,
        printConfigRevisionId: "00000000-0000-0000-0000-000000000001",
        referenceProfileId: "00000000-0000-0000-0000-000000000002",
        delivery: "NOT_FINALIZED",
      },
    });
    return;
  }

  // --- 3. Storage Upload Model Files ---
  if (pathname === "/storage/uploads/model-files" && method === "POST") {
    sendJson(res, 201, {
      uploadId: "00000000-0000-0000-0000-000000000010",
      assetId: "00000000-0000-0000-0000-000000000011",
      accessToken: "token-file-test-001",
      uploadUrl: "http://127.0.0.1:4175/mock-upload",
      requiredHeaders: {},
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    return;
  }

  // --- 4. Storage Upload Photos (Assisted) ---
  if (pathname === "/storage/uploads/photos" && method === "POST") {
    sendJson(res, 201, {
      uploadId: "00000000-0000-0000-0000-000000000020",
      assetId: "00000000-0000-0000-0000-000000000021",
      accessToken: "token-photo-001",
      uploadUrl: "http://127.0.0.1:4175/mock-upload",
      requiredHeaders: {},
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    return;
  }

  const uploadConfirmMatch = pathname.match(
    /^\/storage\/uploads\/([^/]+)\/confirm$/,
  );
  if (uploadConfirmMatch && method === "POST") {
    sendJson(res, 200, {
      assetId: "00000000-0000-0000-0000-000000000021",
      status: "CONFIRMED",
    });
    return;
  }

  // --- 5. Quote Sessions ---
  if (pathname === "/automatic-quote-sessions" && method === "POST") {
    const sessionId = `session-${Date.now()}`;
    const session = createDefaultSession(sessionId);
    sessions.set(sessionId, session);
    sendJson(res, 200, session);
    return;
  }

  // Session routes regex: /automatic-quote-sessions/:sessionId/...
  const sessionMatch = pathname.match(
    /^\/automatic-quote-sessions\/([^/]+)(.*)$/,
  );
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const subpath = sessionMatch[2] || "";

    let session = sessions.get(sessionId);
    if (!session) {
      session = createDefaultSession(sessionId);
      sessions.set(sessionId, session);
    }

    if (subpath === "" && method === "GET") {
      sendJson(res, 200, session);
      return;
    }

    if (subpath === "/model-files" && method === "POST") {
      sendJson(res, 200, session);
      return;
    }

    if (subpath === "/configuration" && method === "PUT") {
      const body = await parseJson(req);
      session.configurationRevision += 1;
      // Handle quality pricing update
      const items = body.items || [];
      session.items = items.map((it, idx) => {
        const quality = it.quality || "STANDARD";
        return {
          ...session.items[0],
          id: it.id || session.items[0]?.id || `item-${idx}`,
          ordinal: idx,
          quantity: it.quantity || 1,
          quality,
          material: it.material || "PLA",
          infillPreset: it.infillPreset || "STANDARD",
          bodyIds: it.bodyIds || ["body-1"],
        };
      });

      // Price mapping based on quality: DRAFT: 21780, STANDARD: 35000, FINE: 50820
      const firstQuality = session.items[0]?.quality || "STANDARD";
      let priceMinor = 35000;
      if (firstQuality === "DRAFT") priceMinor = 21780;
      else if (firstQuality === "FINE") priceMinor = 50820;

      session.roughEstimate = {
        kind: "ROUGH_ESTIMATE",
        currency: "CZK",
        netAmountMinor: Math.round(priceMinor / 1.21),
        vatAmountMinor: priceMinor - Math.round(priceMinor / 1.21),
        totalMinor: priceMinor,
        vatRateBasisPoints: 2100,
        taxRegime: "VAT_PAYER",
        components: [
          {
            id: "base-cost",
            kind: "BASE_COST",
            amountMinor: priceMinor,
            label: `Výroba (${firstQuality})`,
          },
        ],
      };

      if (session.selectedDeliveryDestination) {
        // Recalculate binding quote
        const deliveryMinor = 8900;
        const expressMinor = session.express.requested ? 15000 : 0;
        const total = priceMinor + deliveryMinor + expressMinor;
        session.bindingQuote = {
          kind: "BINDING",
          currency: "CZK",
          netAmountMinor: Math.round(total / 1.21),
          vatAmountMinor: total - Math.round(total / 1.21),
          totalMinor: total,
          vatRateBasisPoints: 2100,
          taxRegime: "VAT_PAYER",
          components: [
            {
              id: "items",
              kind: "ITEMS",
              amountMinor: priceMinor,
              label: "Výroba položek",
            },
            {
              id: "delivery",
              kind: "DELIVERY",
              amountMinor: deliveryMinor,
              label: "Doprava",
            },
            ...(expressMinor
              ? [
                  {
                    id: "express",
                    kind: "EXPRESS",
                    amountMinor: expressMinor,
                    label: "Expresní příplatek",
                  },
                ]
              : []),
          ],
        };
      }

      sendJson(res, 200, session);
      return;
    }

    if (subpath === "/delivery-destination" && method === "PUT") {
      const body = await parseJson(req);
      session.selectedDeliveryDestination = {
        providerEndpointId:
          body.providerEndpointId ||
          body.destination?.providerEndpointId ||
          "packeta-1",
        endpointType:
          body.endpointType || body.destination?.endpointType || "pickup_point",
        label:
          body.label || body.destination?.label || "Zásilkovna — Výdejní místo",
      };
      sendJson(res, 200, session);
      return;
    }

    if (subpath === "/prepare" && method === "POST") {
      session.phase = "CHECKOUT_READY";
      session.checkoutReady = true;

      const baseMinor = session.roughEstimate?.totalMinor || 35000;
      const deliveryMinor = 8900;
      const expressMinor = session.express?.requested ? 15000 : 0;
      const total = baseMinor + deliveryMinor + expressMinor;

      session.bindingQuote = {
        kind: "BINDING",
        currency: "CZK",
        netAmountMinor: Math.round(total / 1.21),
        vatAmountMinor: total - Math.round(total / 1.21),
        totalMinor: total,
        vatRateBasisPoints: 2100,
        taxRegime: "VAT_PAYER",
        components: [
          {
            id: "items",
            kind: "ITEMS",
            amountMinor: baseMinor,
            label: "Výroba položek",
          },
          {
            id: "delivery",
            kind: "DELIVERY",
            amountMinor: deliveryMinor,
            label: "Doprava",
          },
          ...(expressMinor
            ? [
                {
                  id: "express",
                  kind: "EXPRESS",
                  amountMinor: expressMinor,
                  label: "Expresní příplatek",
                },
              ]
            : []),
        ],
      };

      sendJson(res, 200, session);
      return;
    }

    if (subpath === "/express" && method === "PUT") {
      const body = await parseJson(req);
      session.express.requested = Boolean(body.requested);

      if (session.bindingQuote) {
        const baseMinor = session.roughEstimate?.totalMinor || 35000;
        const deliveryMinor = 8900;
        const expressMinor = session.express.requested ? 15000 : 0;
        const total = baseMinor + deliveryMinor + expressMinor;
        session.bindingQuote.totalMinor = total;
        session.bindingQuote.netAmountMinor = Math.round(total / 1.21);
        session.bindingQuote.vatAmountMinor = total - Math.round(total / 1.21);
      }

      sendJson(res, 200, session);
      return;
    }

    if (subpath === "/risk-decisions" && method === "POST") {
      sendJson(res, 200, session);
      return;
    }

    if (subpath === "/observations" && method === "POST") {
      const body = await parseJson(req);
      testState.recordedObservations.push({
        sessionId,
        ...body,
        receivedAt: new Date().toISOString(),
      });
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      res.end();
      return;
    }

    if (subpath === "/checkout/payments" && method === "POST") {
      const paymentId = `pay-${Date.now()}`;
      const checkoutUrl = `http://127.0.0.1:4175/mock-gateway?paymentId=${paymentId}&sessionId=${sessionId}`;
      sendJson(res, 200, {
        paymentId,
        amountMinor: session.bindingQuote?.totalMinor || 43900,
        currency: "CZK",
        status: "CREATED",
        method: "CARD",
        provider: "sandbox",
        checkoutUrl,
        expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
      });
      return;
    }

    if (subpath === "/checkout/payment" && method === "GET") {
      const paymentId = url.searchParams.get("paymentId") || "pay-test-123";
      sendJson(res, 200, {
        paymentId,
        amountMinor: session.bindingQuote?.totalMinor || 43900,
        currency: "CZK",
        status: testState.paymentOutcome,
        method: "CARD",
        provider: "sandbox",
        checkoutUrl: null,
        expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
      });
      return;
    }
  }

  // --- 6. Checkout Capabilities ---
  if (pathname === "/payments/capabilities" && method === "GET") {
    sendJson(res, 200, {
      available: true,
      provider: "sandbox",
      methods: ["CARD", "BANK_TRANSFER"],
      legalDocuments: {
        termsRevision: "terms-test-v1",
        claimPolicyRevision: "claims-test-v1",
        photoConsentRevision: "photo-consent-test-v1",
      },
    });
    return;
  }

  // --- 7. Assisted Quote Requests ---
  if (pathname === "/quote-requests" && method === "POST") {
    const body = await parseJson(req);
    const requestId = `ast-${Date.now()}`;
    sendJson(res, 200, {
      requestId,
      requestToken: `token-${requestId}`,
      publicReference: "REQ-2026-TEST",
      status: "NEW",
      slaDueAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
    return;
  }

  const assistedMatch = pathname.match(
    /^\/quote-requests\/([^/]+)\/attachments$/,
  );
  if (assistedMatch && method === "POST") {
    sendJson(res, 200, {
      attachmentId: `att-${Date.now()}`,
      status: "ATTACHED",
    });
    return;
  }

  // Fallback 404
  sendJson(res, 404, {
    statusCode: 404,
    message: `Route not found: ${method} ${pathname}`,
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock backend server running at http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
