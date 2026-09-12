import { test, expect } from "@playwright/test";

async function createSeededSessionAndPayment(request: any) {
  const sessRes = await request.post(
    "http://127.0.0.1:4175/automatic-quote-sessions",
    {
      headers: { "Idempotency-Key": `sess-seed-${crypto.randomUUID()}` },
    },
  );
  const session = await sessRes.json();
  await request.post(
    `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/prepare`,
    {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    },
  );
  const payRes = await request.post(
    `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payments`,
    {
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        "Idempotency-Key": `key-${session.sessionId}-seed`,
      },
      data: {
        email: "jan.zakaznik@example.cz",
        fullName: "Jan Zákazník",
        billing: {
          name: "Jan Zákazník",
          addressLine1: "Hlavní 123",
          city: "Brno",
          postalCode: "60200",
          countryCode: "CZ",
        },
        method: "CARD",
        acceptTerms: true,
        acceptClaimPolicy: true,
        acknowledgeWithdrawalException: true,
        termsRevision: "terms-test-v1",
        claimPolicyRevision: "claims-test-v1",
        photoPublicationConsent: false,
        photoConsentRevision: null,
      },
    },
  );
  const payment = await payRes.json();
  return { session, payment };
}

test.describe("Payment Outcomes & Session Protection", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4175/__test/reset");
  });

  test("direct navigation to payment return without stored session fails closed", async ({
    page,
  }) => {
    await page.goto(
      "/checkout/payment/success?paymentId=00000000-0000-4000-8000-000000000123&sessionId=00000000-0000-4000-8000-000000000456",
    );
    // Error must be displayed
    await expect(
      page.getByText(
        "Uložená relace objednávky není v tomto prohlížeči dostupná.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();
  });

  test("direct navigation with mismatched session ID in storage fails closed", async ({
    page,
    request,
  }) => {
    const { session, payment } = await createSeededSessionAndPayment(request);

    // Populate storage with foreign session ID
    await page.goto("/");
    await page.evaluate(
      ({ pay }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: "00000000-0000-4000-8000-foreign00001",
            sessionToken: "foreign-token-abc",
            filename: "cube.stl",
            publicReference: "TAV-FOREIGN-1",
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: "00000000-0000-4000-8000-foreign00001",
            command: {
              paymentId: pay.paymentId,
              idempotencyKey: `key-${pay.paymentId}-fake`,
              requestFingerprint: "fingerprint-fake",
            },
          }),
        );
      },
      { pay: payment },
    );

    await page.goto(
      `/checkout/payment/success?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );
    // Must display verification failure, not confirmed success
    await expect(
      page.getByText("Návrat neodpovídá uložené relaci objednávky."),
    ).toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();
  });

  test("direct navigation with mismatched payment ID in storage fails closed", async ({
    page,
    request,
  }) => {
    const { session, payment } = await createSeededSessionAndPayment(request);

    // Populate storage with foreign payment ID
    await page.goto("/");
    await page.evaluate(
      ({ sess }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            sessionToken: sess.sessionToken,
            filename: "cube.stl",
            publicReference: sess.publicReference,
            expiresAt: sess.expiresAt,
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            command: {
              paymentId: "00000000-0000-4000-8000-foreign00002",
              idempotencyKey: "key-foreign-002",
              requestFingerprint: "fingerprint-fake-2",
            },
          }),
        );
      },
      { sess: session },
    );

    await page.goto(
      `/checkout/payment/success?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );
    // Must display verification failure, not confirmed success
    await expect(
      page.getByText("Návrat neodpovídá uloženému platebnímu pokusu."),
    ).toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();
  });

  test("direct navigation with expired session token fails closed", async ({
    page,
    request,
  }) => {
    const { session, payment } = await createSeededSessionAndPayment(request);

    // Invalidate session in backend
    await request.post("http://127.0.0.1:4175/__test/reset");

    await page.goto("/");
    await page.evaluate(
      ({ sess, pay }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            sessionToken: sess.sessionToken,
            filename: "cube.stl",
            publicReference: sess.publicReference,
            expiresAt: sess.expiresAt,
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            command: {
              paymentId: pay.paymentId,
              idempotencyKey: `key-${pay.paymentId}-valid`,
              requestFingerprint: "fingerprint-valid",
            },
          }),
        );
      },
      { sess: session, pay: payment },
    );

    await page.goto(
      `/checkout/payment/success?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );
    // Must display verification failure, not confirmed success
    await expect(
      page.getByText("Ověřený stav platby se nepodařilo načíst."),
    ).toBeVisible();
    await expect(page.getByText("Platba byla potvrzena.")).not.toBeVisible();
  });

  test("backend session endpoints require valid capability bearer token", async ({
    request,
  }) => {
    const res = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
      {
        headers: { "Idempotency-Key": `sess-auth-${crypto.randomUUID()}` },
      },
    );
    const session = await res.json();

    const noAuth = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}`,
    );
    expect(noAuth.status()).toBe(401);

    const badAuth = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}`,
      { headers: { Authorization: "Bearer wrong-token-123" } },
    );
    expect(badAuth.status()).toBe(401);

    const goodAuth = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}`,
      { headers: { Authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(goodAuth.status()).toBe(200);
  });

  test("backend rejects non-UUID or unknown payment IDs and fails closed", async ({
    request,
  }) => {
    const res = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
      {
        headers: { "Idempotency-Key": `sess-payid-${crypto.randomUUID()}` },
      },
    );
    const session = await res.json();

    // Non-UUID payment rejected with 400
    const nonUuidRes = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payment?paymentId=not-a-uuid`,
      { headers: { Authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(nonUuidRes.status()).toBe(400);

    // Unknown UUID payment rejected with 404
    const unknownRes = await request.get(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payment?paymentId=00000000-0000-4000-8000-000000000999`,
      { headers: { Authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(unknownRes.status()).toBe(404);
  });

  test("upload confirmation enforces bearer authentication and matches issued intent", async ({
    request,
  }) => {
    const intentRes = await request.post(
      "http://127.0.0.1:4175/storage/uploads/model-files",
    );
    const intent = await intentRes.json();
    expect(intent.uploadId).toBeDefined();
    expect(intent.assetId).toBeDefined();
    expect(intent.accessToken).toBeDefined();

    // 1. Missing or invalid bearer token -> 401
    const unauthRes = await request.post(
      `http://127.0.0.1:4175/storage/uploads/${intent.uploadId}/confirm`,
      {
        headers: { Authorization: "Bearer bad-token" },
      },
    );
    expect(unauthRes.status()).toBe(401);

    // 2. Unknown upload ID -> 404
    const notFoundRes = await request.post(
      "http://127.0.0.1:4175/storage/uploads/00000000-0000-4000-8000-000000000099/confirm",
      {
        headers: { Authorization: `Bearer ${intent.accessToken}` },
      },
    );
    expect(notFoundRes.status()).toBe(404);

    // 3. Confirm before transfer completes -> 409
    const preTransferRes = await request.post(
      `http://127.0.0.1:4175/storage/uploads/${intent.uploadId}/confirm`,
      {
        headers: { Authorization: `Bearer ${intent.accessToken}` },
      },
    );
    expect(preTransferRes.status()).toBe(409);

    // Perform PUT transfer
    const putRes = await request.put(intent.uploadUrl, {
      data: Buffer.from("stl content"),
    });
    expect(putRes.status()).toBe(200);

    // 4. Valid confirmation -> 200 with matching assetId
    const confirmRes = await request.post(
      `http://127.0.0.1:4175/storage/uploads/${intent.uploadId}/confirm`,
      {
        headers: { Authorization: `Bearer ${intent.accessToken}` },
      },
    );
    expect(confirmRes.status()).toBe(200);
    const confirmData = await confirmRes.json();
    expect(confirmData.uploadId).toBe(intent.uploadId);
    expect(confirmData.assetId).toBe(intent.assetId);
    expect(confirmData.assetKind).toBe("MODEL_FILE");
  });

  test("model file attachment requires idempotency key, confirmed upload, and matching upload token", async ({
    request,
  }) => {
    // Create session
    const sessRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
      {
        headers: { "Idempotency-Key": `sess-model-${crypto.randomUUID()}` },
      },
    );
    const session = await sessRes.json();

    // Create upload intent
    const intentRes = await request.post(
      "http://127.0.0.1:4175/storage/uploads/model-files",
    );
    const intent = await intentRes.json();

    // 1. Missing Idempotency-Key header -> 400
    const noKeyRes = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/model-files`,
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
        },
        data: {
          modelFileId: intent.assetId,
          uploadToken: intent.accessToken,
        },
      },
    );
    expect(noKeyRes.status()).toBe(400);

    // 2. Unconfirmed upload -> 400
    const unconfirmedRes = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/model-files`,
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Idempotency-Key": "test-attach-key-1",
        },
        data: {
          modelFileId: intent.assetId,
          uploadToken: intent.accessToken,
        },
      },
    );
    expect(unconfirmedRes.status()).toBe(400);

    // Transfer and confirm upload
    const putRes = await request.put(intent.uploadUrl, {
      data: Buffer.from("test-model-content"),
    });
    expect(putRes.status()).toBe(200);

    const confirmRes = await request.post(
      `http://127.0.0.1:4175/storage/uploads/${intent.uploadId}/confirm`,
      {
        headers: { Authorization: `Bearer ${intent.accessToken}` },
      },
    );
    expect(confirmRes.status()).toBe(200);

    // 3. Mismatched upload token -> 401
    const badTokenRes = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/model-files`,
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Idempotency-Key": "test-attach-key-2",
        },
        data: {
          modelFileId: intent.assetId,
          uploadToken: "wrong-upload-token",
        },
      },
    );
    expect(badTokenRes.status()).toBe(401);

    // 4. Valid confirmed attachment -> 200 with updated session
    const validAttachRes = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/model-files`,
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Idempotency-Key": "test-attach-key-3",
        },
        data: {
          modelFileId: intent.assetId,
          uploadToken: intent.accessToken,
        },
      },
    );
    expect(validAttachRes.status()).toBe(200);
    const updated = await validAttachRes.json();
    expect(updated.modelFiles[0].modelFileId).toBe(intent.assetId);
  });

  test("photo upload intent enforces quote request scope and bearer capability", async ({
    request,
  }) => {
    // 1. Missing scope -> 400
    const noScopeRes = await request.post(
      "http://127.0.0.1:4175/storage/uploads/photos",
      {
        data: {
          contentType: "image/png",
          kind: "QUOTE_REFERENCE",
          originalFilename: "ref.png",
          sizeBytes: 1024,
          sha256: "abc",
        },
      },
    );
    expect(noScopeRes.status()).toBe(400);

    // 2. Unknown quote request -> 404
    const unknownScopeRes = await request.post(
      "http://127.0.0.1:4175/storage/uploads/photos",
      {
        headers: { Authorization: "Bearer some-token" },
        data: {
          scopeId: "00000000-0000-4000-8000-000000000999",
          scopeKind: "QUOTE_REQUEST",
          contentType: "image/png",
          kind: "QUOTE_REFERENCE",
          originalFilename: "ref.png",
          sizeBytes: 1024,
          sha256: "abc",
        },
      },
    );
    expect(unknownScopeRes.status()).toBe(404);

    // Create quote request
    const qrRes = await request.post("http://127.0.0.1:4175/quote-requests", {
      headers: { "Idempotency-Key": `key-photo-qr-${Date.now()}` },
      data: {
        description: "Test request with long description",
        contact: { name: "Jan Novák", email: "jan@example.cz" },
      },
    });
    expect(qrRes.status()).toBe(201);
    const qr = await qrRes.json();

    // 3. Bad authorization bearer token -> 401
    const badAuthRes = await request.post(
      "http://127.0.0.1:4175/storage/uploads/photos",
      {
        headers: { Authorization: "Bearer bad-token" },
        data: {
          scopeId: qr.requestId,
          scopeKind: "QUOTE_REQUEST",
          contentType: "image/png",
          kind: "QUOTE_REFERENCE",
          originalFilename: "ref.png",
          sizeBytes: 1024,
          sha256: "abc",
        },
      },
    );
    expect(badAuthRes.status()).toBe(401);

    // 4. Valid photo upload intent -> 201
    const validPhotoRes = await request.post(
      "http://127.0.0.1:4175/storage/uploads/photos",
      {
        headers: { Authorization: `Bearer ${qr.requestToken}` },
        data: {
          scopeId: qr.requestId,
          scopeKind: "QUOTE_REQUEST",
          contentType: "image/png",
          kind: "QUOTE_REFERENCE",
          originalFilename: "ref.png",
          sizeBytes: 1024,
          sha256: "abc",
        },
      },
    );
    expect(validPhotoRes.status()).toBe(201);
    const photoIntent = await validPhotoRes.json();
    expect(photoIntent.uploadId).toBeDefined();
    expect(photoIntent.accessToken).toBeDefined();
  });

  test("checkout payment enforces payload validation and legal document revisions", async ({
    request,
  }) => {
    const sessRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
    );
    const session = await sessRes.json();
    await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/prepare`,
      {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      },
    );

    // Missing Idempotency-Key header -> 400
    const noIdempRes = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payments`,
      {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        data: {
          email: "jan.zakaznik@example.cz",
          fullName: "Jan Zákazník",
          billing: {
            name: "Jan Zákazník",
            addressLine1: "Hlavní 123",
            city: "Brno",
            postalCode: "60200",
            countryCode: "CZ",
          },
          method: "CARD",
          acceptTerms: true,
          acceptClaimPolicy: true,
          acknowledgeWithdrawalException: true,
          termsRevision: "terms-test-v1",
          claimPolicyRevision: "claims-test-v1",
          photoPublicationConsent: false,
        },
      },
    );
    expect(noIdempRes.status()).toBe(400);

    // Incomplete payload (acceptTerms is false) -> 400
    const unacceptedTermsRes = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payments`,
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Idempotency-Key": "key-terms-invalid",
        },
        data: {
          email: "jan.zakaznik@example.cz",
          fullName: "Jan Zákazník",
          billing: {
            name: "Jan Zákazník",
            addressLine1: "Hlavní 123",
            city: "Brno",
            postalCode: "60200",
            countryCode: "CZ",
          },
          method: "CARD",
          acceptTerms: false,
          acceptClaimPolicy: true,
          acknowledgeWithdrawalException: true,
          termsRevision: "terms-test-v1",
          claimPolicyRevision: "claims-test-v1",
          photoPublicationConsent: false,
        },
      },
    );
    expect(unacceptedTermsRes.status()).toBe(400);

    // Stale termsRevision -> 400
    const staleRevisionRes = await request.post(
      `http://127.0.0.1:4175/automatic-quote-sessions/${session.sessionId}/checkout/payments`,
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Idempotency-Key": "key-revision-stale",
        },
        data: {
          email: "jan.zakaznik@example.cz",
          fullName: "Jan Zákazník",
          billing: {
            name: "Jan Zákazník",
            addressLine1: "Hlavní 123",
            city: "Brno",
            postalCode: "60200",
            countryCode: "CZ",
          },
          method: "CARD",
          acceptTerms: true,
          acceptClaimPolicy: true,
          acknowledgeWithdrawalException: true,
          termsRevision: "stale-terms-old",
          claimPolicyRevision: "claims-test-v1",
          photoPublicationConsent: false,
        },
      },
    );
    expect(staleRevisionRes.status()).toBe(400);
  });

  test("captured payment displays order reference and confirmed receipt", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "CAPTURED" },
    });

    const { session, payment } = await createSeededSessionAndPayment(request);

    await page.goto("/");
    await page.evaluate(
      ({ sess, pay }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            sessionToken: sess.sessionToken,
            filename: "cube.stl",
            publicReference: sess.publicReference,
            expiresAt: sess.expiresAt,
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            command: {
              paymentId: pay.paymentId,
              idempotencyKey: `key-${pay.paymentId}-valid`,
              requestFingerprint: "fingerprint-captured",
            },
          }),
        );
      },
      { sess: session, pay: payment },
    );

    await page.goto(
      `/checkout/payment/success?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );

    // Verify confirmed payment presentation
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena.", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Objednávku jsme přijali a připravujeme ji k výrobě."),
    ).toBeVisible();
    await expect(page.getByText("Reference TAV-2026-TEST")).toBeVisible();
  });

  test("pending payment displays processing state and polling", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "PENDING" },
    });

    const { session, payment } = await createSeededSessionAndPayment(request);

    await page.goto("/");
    await page.evaluate(
      ({ sess, pay }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            sessionToken: sess.sessionToken,
            filename: "cube.stl",
            publicReference: sess.publicReference,
            expiresAt: sess.expiresAt,
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            command: {
              paymentId: pay.paymentId,
              idempotencyKey: `key-${pay.paymentId}-valid`,
              requestFingerprint: "fingerprint-pending",
            },
          }),
        );
      },
      { sess: session, pay: payment },
    );

    await page.goto(
      `/checkout/payment/pending?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );

    // Verify pending presentation
    await expect(
      page.getByRole("heading", {
        name: "Čekáme na potvrzení platby.",
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Poskytovatel zatím nepotvrdil konečný výsledek. Stránka stav průběžně obnovuje.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Načíst aktuální stav" }),
    ).toBeVisible();

    // Transition backend payment status to CAPTURED
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "CAPTURED" },
    });

    // Verify automatic polling picks up the transition without user clicking refresh
    await expect(
      page.getByRole("heading", { name: "Platba byla potvrzena.", level: 1 }),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("PLATBA PŘIJATA")).toBeVisible();
    await expect(
      page.getByText("Objednávku jsme přijali a připravujeme ji k výrobě."),
    ).toBeVisible();
  });

  test("failed or cancelled payment provides clear feedback and restart option", async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4175/__test/state", {
      data: { paymentOutcome: "FAILED" },
    });

    const { session, payment } = await createSeededSessionAndPayment(request);

    await page.goto("/");
    await page.evaluate(
      ({ sess, pay }) => {
        window.sessionStorage.setItem(
          "taven:automatic-quote-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            sessionToken: sess.sessionToken,
            filename: "cube.stl",
            publicReference: sess.publicReference,
            expiresAt: sess.expiresAt,
          }),
        );
        window.sessionStorage.setItem(
          "taven:checkout-session:v1",
          JSON.stringify({
            sessionId: sess.sessionId,
            command: {
              paymentId: pay.paymentId,
              idempotencyKey: `key-${pay.paymentId}-valid`,
              requestFingerprint: "fingerprint-failed",
            },
          }),
        );
      },
      { sess: session, pay: payment },
    );

    await page.goto(
      `/checkout/payment/cancelled?paymentId=${payment.paymentId}&sessionId=${session.sessionId}`,
    );

    // Verify failure presentation
    await expect(
      page.getByRole("heading", {
        name: "Platba nebyla dokončena.",
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Objednávka nebyla předána do výroby. Vraťte se ke kalkulaci a vytvořte nový platební pokus.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Zpět ke kalkulaci" }),
    ).toBeVisible();
  });
  test("automatic-quote session creation requires idempotency key and rejects conflicting payloads", async ({
    request,
  }) => {
    // 1. Missing Idempotency-Key -> 400
    const noKeyRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
    );
    expect(noKeyRes.status()).toBe(400);

    // 2. Initial creation with Idempotency-Key -> 200
    const key = `sess-idem-${crypto.randomUUID()}`;
    const createRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
      {
        headers: { "Idempotency-Key": key },
        data: { attribution: { source: "web-upload" } },
      },
    );
    expect(createRes.status()).toBe(200);
    const session = await createRes.json();
    expect(session.sessionId).toBeDefined();

    // 3. Replay same key and payload -> 200 with matching session
    const replayRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
      {
        headers: { "Idempotency-Key": key },
        data: { attribution: { source: "web-upload" } },
      },
    );
    expect(replayRes.status()).toBe(200);
    const replayed = await replayRes.json();
    expect(replayed.sessionId).toBe(session.sessionId);

    // 4. Replay same key with conflicting payload -> 409
    const conflictRes = await request.post(
      "http://127.0.0.1:4175/automatic-quote-sessions",
      {
        headers: { "Idempotency-Key": key },
        data: { attribution: { source: "different-source" } },
      },
    );
    expect(conflictRes.status()).toBe(409);
  });
});
