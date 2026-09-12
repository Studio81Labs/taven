import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";

const PORT = 4175;

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION in mock-backend-server:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION in mock-backend-server:", err);
});

let testState = {
  legalStatus: "approved", // "approved" | "draft" | "error503"
  legalEvaluatedAt: null, // custom ISO string or null for current UTC
  capacityStatus: "available", // "available" | "out_of_capacity"
  expressEligible: true,
  paymentOutcome: "CAPTURED", // "CAPTURED" | "PENDING" | "FAILED"
  recordedObservations: [],
  lastAssistedQuote: null,
  lastCheckoutPayload: null,
};

const sessions = new Map();
const payments = new Map();
const uploads = new Map();
const quoteRequests = new Map();
const handoffCapabilities = new Map();

function isUuid(val) {
  return (
    typeof val === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      val,
    )
  );
}

function generateCapabilityToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function resetState() {
  testState = {
    legalStatus: "approved",
    legalEvaluatedAt: null,
    capacityStatus: "available",
    expressEligible: true,
    paymentOutcome: "CAPTURED",
    recordedObservations: [],
    lastAssistedQuote: null,
    lastCheckoutPayload: null,
  };
  sessions.clear();
  payments.clear();
  uploads.clear();
  quoteRequests.clear();
  handoffCapabilities.clear();
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

function createDefaultSession(
  sessionId = crypto.randomUUID(),
  sessionToken = generateCapabilityToken(),
) {
  return {
    sessionId,
    sessionToken,
    orderId: "00000000-0000-4000-8000-000000000001",
    publicReference: "TAV-2026-TEST",
    phase: "DESTINATION_REQUIRED",
    configurationRevision: 1,
    configurationEditable: true,
    checkoutReady: false,
    checkoutEvidenceAccepted: false,
    expiresAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    modelFiles: [
      {
        modelFileId: "00000000-0000-4000-8000-000000000002",
        format: "STL",
        discoveredBodyIds: ["body-1"],
        inspectionStatus: "SUCCEEDED",
      },
    ],
    items: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        modelFileId: "00000000-0000-4000-8000-000000000002",
        ordinal: 0,
        bodyIds: ["body-1"],
        material: "PLA",
        quality: "STANDARD",
        color: "BLACK",
        infillPreset: "STANDARD",
        fitSensitive: false,
        quantity: 1,
        status: "READY",
        printConfigRevisionId: "00000000-0000-4000-8000-000000000001",
        findings: [],
      },
    ],
    configurationOptions: [
      {
        material: "PLA",
        quality: "DRAFT",
        infillPreset: "STANDARD",
        color: "BLACK",
        printConfigRevisionId: "00000000-0000-4000-8000-000000000001",
      },
      {
        material: "PLA",
        quality: "STANDARD",
        infillPreset: "STANDARD",
        color: "BLACK",
        printConfigRevisionId: "00000000-0000-4000-8000-000000000001",
      },
      {
        material: "PLA",
        quality: "FINE",
        infillPreset: "STANDARD",
        color: "BLACK",
        printConfigRevisionId: "00000000-0000-4000-8000-000000000001",
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
  try {
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Mock Platební Brána</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>Testovací platební brána</h1>
  <p>Payment ID: <code id="payment-id-display"></code></p>
  <p>Session ID: <code id="session-id-display"></code></p>
  <div style="display: flex; gap: 1rem; margin-top: 2rem;">
    <button id="btn-pay-success" type="button">
      Zaplatit (Úspěch - CAPTURED)
    </button>
    <button id="btn-pay-pending" type="button">
      Čeká na zpracování (PENDING)
    </button>
    <button id="btn-pay-fail" type="button">
      Zamítnout (FAILED)
    </button>
    <button id="btn-pay-cancel" type="button">
      Zrušit platbu
    </button>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("paymentId") || "pay-test-123";
    const sessionId = params.get("sessionId") || "session-test-001";
    const paymentEl = document.getElementById("payment-id-display");
    const sessionEl = document.getElementById("session-id-display");
    if (paymentEl) paymentEl.textContent = paymentId;
    if (sessionEl) sessionEl.textContent = sessionId;

    function handleOutcome(outcome, targetPath) {
      fetch("http://127.0.0.1:" + ${PORT} + "/__test/state", {
        method: "POST",
        body: JSON.stringify({ paymentOutcome: outcome }),
      }).then(() => {
        window.location.href =
          "http://127.0.0.1:4174/checkout/payment/" +
          targetPath +
          "?paymentId=" +
          encodeURIComponent(paymentId) +
          "&sessionId=" +
          encodeURIComponent(sessionId);
      });
    }

    document.getElementById("btn-pay-success")?.addEventListener("click", () => {
      handleOutcome("CAPTURED", "success");
    });
    document.getElementById("btn-pay-pending")?.addEventListener("click", () => {
      handleOutcome("PENDING", "pending");
    });
    document.getElementById("btn-pay-fail")?.addEventListener("click", () => {
      handleOutcome("FAILED", "cancelled");
    });
    document.getElementById("btn-pay-cancel")?.addEventListener("click", () => {
      handleOutcome("FAILED", "cancelled");
    });
  </script>
</body>
</html>`);
      return;
    }

    // --- S3 Presigned Upload Mock ---
    if (
      pathname === "/mock-upload" &&
      (method === "PUT" || method === "POST")
    ) {
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
      const status =
        testState.legalStatus === "approved" ? "approved" : "draft";
      const evaluatedAt =
        testState.legalEvaluatedAt || new Date().toISOString();
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

    // --- Payments capabilities ---
    if (pathname === "/payments/capabilities" && method === "GET") {
      if (testState.legalStatus === "error503") {
        sendJson(res, 503, {
          statusCode: 503,
          message: "Payment capabilities unavailable",
        });
        return;
      }
      const isApproved = testState.legalStatus === "approved";
      sendJson(res, 200, {
        available: isApproved,
        provider: "sandbox",
        methods: ["CARD"],
        legalDocuments: isApproved
          ? {
              termsRevision: "terms-test-v1",
              claimPolicyRevision: "claims-test-v1",
              photoConsentRevision: "photo-consent-test-v1",
            }
          : null,
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
          printConfigRevisionId: "00000000-0000-4000-8000-000000000001",
          referenceProfileId: "00000000-0000-4000-8000-000000000002",
          delivery: "NOT_FINALIZED",
        },
      });
      return;
    }

    // --- 3. Storage Upload Model Files ---
    if (pathname === "/storage/uploads/model-files" && method === "POST") {
      const uploadId = crypto.randomUUID();
      const assetId = crypto.randomUUID();
      const accessToken = generateCapabilityToken();
      const intent = {
        uploadId,
        assetId,
        accessToken,
        uploadUrl: `http://127.0.0.1:${PORT}/mock-upload`,
        requiredHeaders: {},
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
      uploads.set(uploadId, {
        ...intent,
        assetKind: "MODEL_FILE",
        confirmed: false,
      });
      sendJson(res, 201, intent);
      return;
    }

    // --- 4. Storage Upload Photos (Assisted) ---
    if (pathname === "/storage/uploads/photos" && method === "POST") {
      const body = await parseJson(req);
      if (body?.scopeKind !== "QUOTE_REQUEST" || !body?.scopeId) {
        sendJson(res, 400, {
          statusCode: 400,
          message:
            "scopeKind must be QUOTE_REQUEST and scopeId must be specified",
        });
        return;
      }
      const quoteRequest = quoteRequests.get(body.scopeId);
      if (!quoteRequest) {
        sendJson(res, 404, {
          statusCode: 404,
          message: "Quote request was not found",
        });
        return;
      }
      const authHeader = req.headers.authorization || "";
      if (authHeader !== `Bearer ${quoteRequest.requestToken}`) {
        sendJson(res, 401, {
          statusCode: 401,
          message: "Capability token is invalid",
        });
        return;
      }

      const uploadId = crypto.randomUUID();
      const assetId = crypto.randomUUID();
      const accessToken = generateCapabilityToken();
      const intent = {
        uploadId,
        assetId,
        accessToken,
        uploadUrl: `http://127.0.0.1:${PORT}/mock-upload`,
        requiredHeaders: {},
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
      uploads.set(uploadId, {
        ...intent,
        assetKind: "PHOTO_ASSET",
        confirmed: false,
      });
      sendJson(res, 201, intent);
      return;
    }

    const uploadConfirmMatch = pathname.match(
      /^\/storage\/uploads\/([^/]+)\/confirm$/,
    );
    if (uploadConfirmMatch && method === "POST") {
      const uploadId = uploadConfirmMatch[1];
      const upload = uploads.get(uploadId);
      if (!upload) {
        sendJson(res, 404, {
          statusCode: 404,
          message: "Upload intent was not found",
        });
        return;
      }
      const authHeader = req.headers.authorization || "";
      if (authHeader !== `Bearer ${upload.accessToken}`) {
        sendJson(res, 401, {
          statusCode: 401,
          message: "Capability token is invalid",
        });
        return;
      }
      upload.confirmed = true;
      sendJson(res, 200, {
        uploadId: upload.uploadId,
        assetId: upload.assetId,
        assetKind: upload.assetKind,
        uploadedAt: new Date().toISOString(),
        deleteAfter: new Date(Date.now() + 86400 * 1000).toISOString(),
      });
      return;
    }

    // --- 5. Quote Sessions ---
    if (pathname === "/automatic-quote-sessions" && method === "POST") {
      const session = createDefaultSession();
      sessions.set(session.sessionId, session);
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

      if (!isUuid(sessionId)) {
        sendJson(res, 400, {
          statusCode: 400,
          message: "sessionId must be a UUID",
        });
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, {
          statusCode: 404,
          message: "Quote session not found",
        });
        return;
      }

      const authHeader = req.headers.authorization || "";
      if (authHeader !== `Bearer ${session.sessionToken}`) {
        sendJson(res, 401, {
          statusCode: 401,
          message: "Capability is invalid",
        });
        return;
      }

      if (subpath === "" && method === "GET") {
        sendJson(res, 200, session);
        return;
      }

      if (subpath === "/handoff-capabilities" && method === "POST") {
        const idempotencyKey = req.headers["idempotency-key"];
        if (
          !idempotencyKey ||
          typeof idempotencyKey !== "string" ||
          idempotencyKey.trim().length === 0
        ) {
          sendJson(res, 400, {
            statusCode: 400,
            message: "Idempotency-Key header is required",
          });
          return;
        }

        const handoffToken = generateCapabilityToken();
        const handoffId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        handoffCapabilities.set(handoffToken, {
          handoffId,
          sessionId,
          handoffToken,
          consumed: false,
          expiresAt,
        });
        sendJson(res, 201, {
          handoffToken,
          expiresAt,
        });
        return;
      }

      if (subpath === "/model-files" && method === "POST") {
        const idempotencyKey = req.headers["idempotency-key"];
        if (
          !idempotencyKey ||
          typeof idempotencyKey !== "string" ||
          idempotencyKey.trim().length === 0
        ) {
          sendJson(res, 400, {
            statusCode: 400,
            message: "Idempotency-Key header is required",
          });
          return;
        }

        const body = await parseJson(req);
        if (!isUuid(body?.modelFileId)) {
          sendJson(res, 400, {
            statusCode: 400,
            message: "modelFileId must be a valid UUID",
          });
          return;
        }
        if (!body?.uploadToken || typeof body.uploadToken !== "string") {
          sendJson(res, 400, {
            statusCode: 400,
            message: "uploadToken is required",
          });
          return;
        }

        let matchingUpload = null;
        for (const upload of uploads.values()) {
          if (
            upload.assetId === body.modelFileId &&
            upload.assetKind === "MODEL_FILE"
          ) {
            matchingUpload = upload;
            break;
          }
        }

        if (!matchingUpload) {
          sendJson(res, 404, {
            statusCode: 404,
            message: "Model file upload was not found",
          });
          return;
        }

        if (!matchingUpload.confirmed) {
          sendJson(res, 400, {
            statusCode: 400,
            message: "Model file upload has not been confirmed",
          });
          return;
        }

        if (matchingUpload.accessToken !== body.uploadToken) {
          sendJson(res, 401, {
            statusCode: 401,
            message: "Upload capability token is invalid",
          });
          return;
        }

        if (session.modelFiles[0]) {
          session.modelFiles[0].modelFileId = body.modelFileId;
        } else {
          session.modelFiles.push({
            modelFileId: body.modelFileId,
            format: "STL",
            discoveredBodyIds: ["body-1"],
            inspectionStatus: "SUCCEEDED",
          });
        }
        if (session.items[0]) {
          session.items[0].modelFileId = body.modelFileId;
        }
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
            body.endpointType ||
            body.destination?.endpointType ||
            "pickup_point",
          label:
            body.label ||
            body.destination?.label ||
            "Zásilkovna — Výdejní místo",
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
          session.bindingQuote.vatAmountMinor =
            total - Math.round(total / 1.21);
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
        if (testState.capacityStatus === "out_of_capacity") {
          sendJson(res, 503, {
            statusCode: 503,
            message: "Platba teď není dostupná.",
          });
          return;
        }

        const body = await parseJson(req);
        testState.lastCheckoutPayload = body;

        const idempotencyKey = req.headers["idempotency-key"];
        if (!idempotencyKey) {
          sendJson(res, 400, {
            statusCode: 400,
            message: "Idempotency-Key header is required",
          });
          return;
        }

        // Validate CreateCheckoutPaymentDto
        const isValid =
          body &&
          typeof body.email === "string" &&
          body.email.includes("@") &&
          typeof body.fullName === "string" &&
          body.fullName.trim().length > 0 &&
          body.billing &&
          typeof body.billing.name === "string" &&
          body.billing.name.trim().length > 0 &&
          typeof body.billing.addressLine1 === "string" &&
          body.billing.addressLine1.trim().length > 0 &&
          typeof body.billing.city === "string" &&
          body.billing.city.trim().length > 0 &&
          typeof body.billing.postalCode === "string" &&
          body.billing.postalCode.trim().length > 0 &&
          typeof body.billing.countryCode === "string" &&
          body.billing.countryCode.length === 2 &&
          (body.method === "CARD" || body.method === "BANK_TRANSFER") &&
          body.acceptTerms === true &&
          body.acceptClaimPolicy === true &&
          body.acknowledgeWithdrawalException === true &&
          typeof body.photoPublicationConsent === "boolean" &&
          body.termsRevision === "terms-test-v1" &&
          body.claimPolicyRevision === "claims-test-v1" &&
          (!body.photoPublicationConsent ||
            body.photoConsentRevision === "photo-consent-test-v1");

        if (!isValid) {
          sendJson(res, 400, {
            statusCode: 400,
            message: "Invalid CreateCheckoutPaymentDto payload",
          });
          return;
        }

        const paymentId = crypto.randomUUID();
        const checkoutUrl = `http://127.0.0.1:${PORT}/mock-gateway?paymentId=${paymentId}&sessionId=${sessionId}`;
        const payment = {
          paymentId,
          sessionId,
          amountMinor: session.bindingQuote?.totalMinor || 43900,
          currency: "CZK",
          status: "CREATED",
          method: body.method || "CARD",
          provider: "sandbox",
          checkoutUrl,
          expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
        };
        payments.set(paymentId, payment);
        sendJson(res, 200, payment);
        return;
      }

      if (subpath === "/checkout/payment" && method === "GET") {
        const paymentId = url.searchParams.get("paymentId");
        if (!paymentId || !isUuid(paymentId)) {
          sendJson(res, 400, {
            statusCode: 400,
            message: "paymentId must be a UUID",
          });
          return;
        }
        const payment = payments.get(paymentId);
        if (!payment || payment.sessionId !== sessionId) {
          sendJson(res, 404, {
            statusCode: 404,
            message: "Checkout payment was not found",
          });
          return;
        }

        const currentOutcome = testState.paymentOutcome || "CAPTURED";
        sendJson(res, 200, {
          paymentId,
          sessionId,
          amountMinor: payment.amountMinor || 43900,
          currency: "CZK",
          status: currentOutcome,
          method: "CARD",
          provider: "sandbox",
          checkoutUrl: payment.checkoutUrl,
          orderPublicReference:
            currentOutcome === "CAPTURED" ? "TAV-2026-TEST" : undefined,
          capturedAt:
            currentOutcome === "CAPTURED"
              ? new Date().toISOString()
              : undefined,
          errorMessage:
            currentOutcome === "FAILED"
              ? "Platba byla zamítnuta vydavatelem karty."
              : undefined,
          expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
        });
        return;
      }

      if (subpath === "/checkout/evidence" && method === "POST") {
        session.checkoutEvidenceAccepted = true;
        sendJson(res, 200, {
          accepted: true,
          evidenceHash:
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        });
        return;
      }
    }

    // --- 6. Quote Requests / Assisted Quotes ---
    if (
      (pathname === "/quote-requests" || pathname === "/assisted-quotes") &&
      method === "POST"
    ) {
      const body = await parseJson(req);
      testState.lastAssistedQuote = body;

      if (body?.automaticQuoteHandoffToken) {
        const capability = handoffCapabilities.get(
          body.automaticQuoteHandoffToken,
        );
        if (
          !capability ||
          capability.consumed ||
          new Date(capability.expiresAt).getTime() <= Date.now()
        ) {
          sendJson(res, 401, {
            statusCode: 401,
            message: "Automatic quote handoff capability is invalid",
          });
          return;
        }
        capability.consumed = true;
      }

      const request = {
        requestId: crypto.randomUUID(),
        publicReference: "REQ-2026-TEST",
        requestToken: generateCapabilityToken(),
        status: "NEW",
        slaDueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        referenceNumber: "REQ-2026-TEST",
        createdAt: new Date().toISOString(),
      };
      quoteRequests.set(request.requestId, request);
      sendJson(res, 201, request);
      return;
    }

    // --- 7. Health check ---
    if (pathname === "/health" && method === "GET") {
      sendJson(res, 200, { status: "OK" });
      return;
    }

    // Default 404
    sendJson(res, 404, {
      statusCode: 404,
      message: `Route ${method} ${pathname} not found on mock backend`,
    });
  } catch (err) {
    console.error("Mock backend error:", err);
    sendJson(res, 500, {
      statusCode: 500,
      message: err?.message || "Internal server error",
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock backend server running on http://127.0.0.1:${PORT}`);
});
