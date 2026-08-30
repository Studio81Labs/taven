import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { QuotesService } from "../src/modules/quotes/quotes.service";
import { photoOriginalObjectKey } from "../src/modules/storage/storage-keys";
import { PrismaService } from "../src/prisma/prisma.service";

const operatorToken = "test-operator-token-with-at-least-32-characters";
const uploadClientHashKey = "test-only-upload-client-hash-key-32";
process.env.TAVEN_OPERATOR_API_TOKEN = operatorToken;
process.env.TAVEN_QUOTE_CAPABILITY_KEY =
  "test-quote-capability-key-with-at-least-32-characters";
process.env.TAVEN_S3_ENDPOINT = "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION = "us-east-1";
process.env.TAVEN_S3_BUCKET = "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID = "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY = "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE = "true";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY = uploadClientHashKey;

describe("QuoteRequest and tokenized individual offers", () => {
  let app: INestApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let quotes: QuotesService;
  let priceListId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = new URL(await app.getUrl());
    prisma = app.get(PrismaService);
    quotes = app.get(QuotesService);
    const priceList = await prisma.priceList.findFirstOrThrow({
      where: { currency: "CZK" },
      orderBy: { createdAt: "asc" },
    });
    priceListId = priceList.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("submits idempotently, isolates attachments, issues, previews, and accepts once", async () => {
    const createKey = key("create");
    const requestBody = requestInput("accept");
    const created = await createRequest(createKey, requestBody);
    expect(created.response.status).toBe(201);
    expect(created.body.status).toBe("NEW");

    const replay = await createRequest(createKey, requestBody);
    expect(replay.response.status).toBe(201);
    expect(replay.body).toEqual(created.body);

    const changedReplay = await createRequest(createKey, {
      ...requestBody,
      purpose: "Changed input",
    });
    expect(changedReplay.response.status).toBe(409);

    const crossTokenRead = await apiJson(
      `quote-requests/${created.body.requestId}`,
      { headers: bearer(randomBytes(32).toString("base64url")) },
    );
    expect(crossTokenRead.response.status).toBe(401);

    const resumed = await apiJson<{
      requestId: string;
      slaDueAt: string;
      slaBreached: boolean;
    }>(`quote-requests/${created.body.requestId}`, {
      headers: bearer(created.body.requestToken),
    });
    expect(resumed.response.status).toBe(200);
    expect(resumed.body.requestId).toBe(created.body.requestId);
    expect(resumed.body.slaBreached).toBe(false);

    const referencePhotoId = randomUUID();
    await prisma.photoAsset.create({
      data: {
        id: referencePhotoId,
        kind: "QUOTE_REFERENCE",
        scopeKind: "QUOTE_REQUEST",
        scopeId: created.body.requestId,
        storageObjectKey: photoOriginalObjectKey(referencePhotoId),
        contentHash: "b".repeat(64),
        mediaType: "image/jpeg",
        sizeBytes: 128,
        uploadedAt: new Date(),
        retentionDays: 90,
        photoDeleteAfter: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000),
      },
    });

    const deniedAttachment = await apiJson("storage/uploads/photos", {
      method: "POST",
      headers: {
        ...bearer(randomBytes(32).toString("base64url")),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "QUOTE_REFERENCE",
        scopeKind: "QUOTE_REQUEST",
        scopeId: created.body.requestId,
        originalFilename: "private-reference.jpg",
        contentType: "image/jpeg",
        sizeBytes: 128,
        sha256: "a".repeat(64),
      }),
    });
    expect(deniedAttachment.response.status).toBe(401);

    const deniedOperator = await apiJson("admin/quote-requests");
    expect(deniedOperator.response.status).toBe(401);

    const deniedOperatorAttachment = await apiJson(
      `admin/quote-requests/${created.body.requestId}/attachments/${referencePhotoId}/download`,
      { method: "POST" },
    );
    expect(deniedOperatorAttachment.response.status).toBe(401);

    const crossRequestOperatorAttachment = await apiJson(
      `admin/quote-requests/${randomUUID()}/attachments/${referencePhotoId}/download`,
      { method: "POST", headers: bearer(operatorToken) },
    );
    expect(crossRequestOperatorAttachment.response.status).toBe(404);

    const operatorAttachment = await apiJson<{
      downloadUrl: string;
      expiresAt: string;
    }>(
      `admin/quote-requests/${created.body.requestId}/attachments/${referencePhotoId}/download`,
      { method: "POST", headers: bearer(operatorToken) },
    );
    expect(operatorAttachment.response.status).toBe(200);
    expect(new URL(operatorAttachment.body.downloadUrl).protocol).toMatch(
      /^https?:$/,
    );
    expect(
      new Date(operatorAttachment.body.expiresAt).getTime(),
    ).toBeGreaterThan(Date.now());

    const reviewed = await operatorCommand(
      `admin/quote-requests/${created.body.requestId}/review`,
      key("review"),
    );
    expect(reviewed.response.status).toBe(200);
    expect(reviewed.body.status).toBe("IN_REVIEW");

    const offerExpiry = new Date(
      Math.floor((Date.now() + 60 * 60 * 1_000) / 1_000) * 1_000,
    );
    const issueKey = key("issue");
    const issued = await issueOffer(
      created.body.requestId,
      issueKey,
      rfc3339WithOffset(offerExpiry),
    );
    expect(issued.response.status).toBe(201);
    expect(issued.body.version).toBe(1);

    const normalizedReplay = await issueOffer(
      created.body.requestId,
      issueKey,
      offerExpiry,
    );
    expect(normalizedReplay.response.status).toBe(201);
    expect(normalizedReplay.body).toEqual(issued.body);

    const wrongOfferToken = await apiJson(`offers/${issued.body.quoteId}`, {
      headers: bearer(randomBytes(32).toString("base64url")),
    });
    expect(wrongOfferToken.response.status).toBe(401);

    const preview = await apiJson<{
      version: number;
      termsRevision: string;
      contractTotalMinor: number;
      items: Array<Record<string, unknown>>;
      components: Array<Record<string, unknown>>;
      paymentSchedules: Array<Record<string, unknown>>;
    }>(`offers/${issued.body.quoteId}`, {
      headers: bearer(issued.body.offerToken),
    });
    expect(preview.response.status).toBe(200);
    expect(preview.body).toMatchObject({
      version: 1,
      termsRevision: issued.body.termsRevision,
      contractTotalMinor: 110_000,
    });
    expect(preview.body.items).toEqual([
      {
        ordinal: 0,
        kind: "CUSTOM_SERVICE",
        serviceDescription: "Rebuild the damaged mounting bracket",
        sourceModelFileId: null,
        modelGeometryId: null,
        printConfigRevisionId: null,
        primaryReferenceSliceResultId: null,
        tailReferenceSliceResultId: null,
        referencePartsPerPlate: null,
        material: null,
        color: null,
        quantity: 1,
      },
    ]);
    expect(preview.body.components).toEqual([
      {
        kind: "ITEM_PRODUCTION",
        scope: "QUOTE_ITEM",
        quoteItemOrdinal: 0,
        amountMinor: 80_000,
        allocation: null,
      },
      {
        kind: "ITEM_QUANTITY",
        scope: "QUOTE_ITEM",
        quoteItemOrdinal: 0,
        amountMinor: 20_000,
        allocation: null,
      },
      {
        kind: "ITEM_POSTPROCESSING",
        scope: "QUOTE_ITEM",
        quoteItemOrdinal: 0,
        amountMinor: 10_000,
        allocation: null,
      },
    ]);
    expect(preview.body.paymentSchedules).toEqual([
      {
        sequence: 0,
        role: "DEPOSIT",
        grossAmountMinor: 33_000,
        feeRateBasisPoints: 0,
        feeFixedMinor: 0,
      },
      {
        sequence: 1,
        role: "BALANCE",
        grossAmountMinor: 77_000,
        feeRateBasisPoints: 0,
        feeFixedMinor: 0,
      },
    ]);

    const staleAcceptance = await apiJson(
      `offers/${issued.body.quoteId}/accept`,
      {
        method: "POST",
        headers: {
          ...bearer(issued.body.offerToken),
          "content-type": "application/json",
          "idempotency-key": key("stale-accept"),
        },
        body: JSON.stringify({
          version: 2,
          termsRevision: issued.body.termsRevision,
        }),
      },
    );
    expect(staleAcceptance.response.status).toBe(409);

    const acceptKey = key("accept-command");
    const accepted = await acceptOffer(issued.body, acceptKey);
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.status).toBe("DRAFT");
    const acceptReplay = await acceptOffer(issued.body, acceptKey);
    expect(acceptReplay.body).toEqual(accepted.body);
    const freshAcceptance = await acceptOffer(
      issued.body,
      key("fresh-accept-command"),
    );
    expect(freshAcceptance.response.status).toBe(409);
    const unauthorizedReplay = await acceptOffer(
      {
        ...issued.body,
        offerToken: randomBytes(32).toString("base64url"),
      },
      acceptKey,
    );
    expect(unauthorizedReplay.response.status).toBe(401);

    const persisted = await prisma.quote.findUniqueOrThrow({
      where: { id: issued.body.quoteId },
      include: {
        quoteRequest: true,
        priceBinding: {
          include: { priceSnapshot: { include: { paymentSchedules: true } } },
        },
        individualOrderOrigin: {
          include: { order: { include: { items: true } } },
        },
      },
    });
    expect(persisted.quoteRequest.status).toBe("ACCEPTED");
    expect(persisted.priceBinding?.priceSnapshot.paymentSchedules).toHaveLength(
      2,
    );
    expect(
      persisted.priceBinding?.priceSnapshot.paymentSchedules.map(
        (schedule) => schedule.role,
      ),
    ).toEqual(["DEPOSIT", "BALANCE"]);
    expect(persisted.individualOrderOrigin?.order.items).toHaveLength(1);
    expect(persisted.individualOrderOrigin?.order.items[0]).toMatchObject({
      kind: "CUSTOM_SERVICE",
      serviceDescription: "Rebuild the damaged mounting bracket",
      sourceModelFileId: null,
    });
    expect(
      await prisma.payment.count({
        where: { orderId: accepted.body.orderId },
      }),
    ).toBe(0);
    expect(
      await prisma.individualOrderOrigin.count({
        where: { quoteId: issued.body.quoteId },
      }),
    ).toBe(1);
    expect(
      await prisma.photoAsset.findUniqueOrThrow({
        where: { id: referencePhotoId },
        select: { retentionHold: true },
      }),
    ).toEqual({ retentionHold: "ACTIVE_ORDER" });

    const defaultQueue = await apiJson<Array<{ requestId: string }>>(
      "admin/quote-requests",
      { headers: bearer(operatorToken) },
    );
    expect(defaultQueue.response.status).toBe(200);
    expect(defaultQueue.body).not.toContainEqual(
      expect.objectContaining({ requestId: created.body.requestId }),
    );

    const acceptedHistory = await apiJson<
      Array<{ requestId: string; status: string }>
    >("admin/quote-requests?status=ACCEPTED", {
      headers: bearer(operatorToken),
    });
    expect(acceptedHistory.response.status).toBe(200);
    expect(acceptedHistory.body).toContainEqual(
      expect.objectContaining({
        requestId: created.body.requestId,
        status: "ACCEPTED",
      }),
    );
  });

  it("rejects a current offer idempotently and prevents later acceptance", async () => {
    const created = await createRequest(
      key("reject-create"),
      requestInput("reject"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.body.requestId}/review`,
      key("reject-review"),
    );
    const issued = await issueOffer(
      created.body.requestId,
      key("reject-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    const rejectKey = key("reject-command");
    const rejected = await apiJson<{ requestId: string; status: string }>(
      `offers/${issued.body.quoteId}/reject`,
      {
        method: "POST",
        headers: {
          ...bearer(issued.body.offerToken),
          "content-type": "application/json",
          "idempotency-key": rejectKey,
        },
        body: JSON.stringify({
          version: issued.body.version,
          termsRevision: issued.body.termsRevision,
          reason: "Timing no longer works",
        }),
      },
    );
    expect(rejected.response.status).toBe(200);
    expect(rejected.body.status).toBe("REJECTED");

    const postRejectUpload = await apiJson("storage/uploads/photos", {
      method: "POST",
      headers: {
        ...bearer(created.body.requestToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "QUOTE_REFERENCE",
        scopeKind: "QUOTE_REQUEST",
        scopeId: created.body.requestId,
        originalFilename: "late-reference.jpg",
        contentType: "image/jpeg",
        sizeBytes: 128,
        sha256: "e".repeat(64),
      }),
    });
    expect(postRejectUpload.response.status).toBe(401);

    const acceptance = await acceptOffer(
      issued.body,
      key("post-reject-accept"),
    );
    expect(acceptance.response.status).toBe(410);
    expect(
      await prisma.individualOrderOrigin.count({
        where: { quoteId: issued.body.quoteId },
      }),
    ).toBe(0);
  });

  it("expires on access at the immutable deadline", async () => {
    const created = await createRequest(
      key("expiry-create"),
      requestInput("expiry"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.body.requestId}/review`,
      key("expiry-review"),
    );
    const issued = await issueOffer(
      created.body.requestId,
      key("expiry-issue"),
      new Date(Date.now() + 600),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 700));

    const preview = await apiJson(`offers/${issued.body.quoteId}`, {
      headers: bearer(issued.body.offerToken),
    });
    expect(preview.response.status).toBe(410);
    expect(
      await prisma.quoteRequest.findUniqueOrThrow({
        where: { id: created.body.requestId },
      }),
    ).toMatchObject({ status: "EXPIRED" });
  });

  it("rejects unsupported payment-fee components before persistence", async () => {
    const created = await createRequest(
      key("fee-create"),
      requestInput("fee-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.body.requestId}/review`,
      key("fee-review"),
    );
    const response = await issueOffer(
      created.body.requestId,
      key("fee-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      [...defaultComponents(), { kind: "PAYMENT_FEE", amountMinor: 0 }],
    );
    expect(response.response.status).toBe(400);
  });

  it("rejects invalid model references as operator input", async () => {
    const created = await quotes.createRequest(
      requestInput("invalid-model-references"),
      "198.51.100.20",
      key("invalid-model-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("invalid-model-review"),
    );
    const response = await issueOffer(
      created.requestId,
      key("invalid-model-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      [
        {
          kind: "MODEL",
          sourceModelFileId: randomUUID(),
          modelGeometryId: randomUUID(),
          printConfigRevisionId: randomUUID(),
          material: "PLA",
          quantity: 1,
        },
      ],
    );
    expect(response.response.status).toBe(400);
    expect(
      await prisma.quote.count({
        where: { quoteRequestId: created.requestId },
      }),
    ).toBe(0);
  });

  it("bounds quote-reference upload issuance per request capability", async () => {
    const created = await quotes.createRequest(
      requestInput("photo-budget"),
      "198.51.100.21",
      key("photo-budget-create"),
    );
    const capabilityHash = createHash("sha256")
      .update(created.requestToken)
      .digest("hex");
    const subjectHash = createHmac("sha256", uploadClientHashKey)
      .update(`quote-photo-upload\0${capabilityHash}`)
      .digest("hex");
    const now = new Date();
    await prisma.anonymousUploadLimit.create({
      data: {
        subjectHash,
        windowStartedAt: now,
        windowExpiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        issuedCount: 19,
        reservedBytes: 0n,
      },
    });
    const initiate = (suffix: string) =>
      apiJson<{ uploadId?: string }>("storage/uploads/photos", {
        method: "POST",
        headers: {
          ...bearer(created.requestToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "QUOTE_REFERENCE",
          scopeKind: "QUOTE_REQUEST",
          scopeId: created.requestId,
          originalFilename: `reference-${suffix}.jpg`,
          contentType: "image/jpeg",
          sizeBytes: 128,
          sha256: suffix.repeat(64),
        }),
      });
    const results = await Promise.all([initiate("a"), initiate("b")]);
    expect(results.map(({ response }) => response.status).sort()).toEqual([
      201, 429,
    ]);
  });

  it("limits anonymous submissions atomically and ignores spoofed forwarding headers", async () => {
    const subjectHash = createHmac(
      "sha256",
      process.env.TAVEN_QUOTE_CAPABILITY_KEY!,
    )
      .update("anonymous-quote-request\0" + "127.0.0.1")
      .digest("hex");
    const now = new Date();
    await prisma.anonymousQuoteLimit.upsert({
      where: { subjectHash },
      create: {
        subjectHash,
        windowStartedAt: now,
        windowExpiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        issuedCount: 4,
      },
      update: {
        windowStartedAt: now,
        windowExpiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        issuedCount: 4,
      },
    });
    const submit = (forwardedFor: string) =>
      apiJson("quote-requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key("limited-create"),
          "x-forwarded-for": forwardedFor,
        },
        body: JSON.stringify(requestInput(`limited-${forwardedFor}`)),
      });
    const results = await Promise.all([
      submit("203.0.113.44"),
      submit("198.51.100.22"),
    ]);
    expect(results.map(({ response }) => response.status).sort()).toEqual([
      201, 429,
    ]);
  });

  it("does not replay a request capability to a different client", async () => {
    const createKey = key("client-bound-create");
    const body = requestInput("client-bound-create");
    await expect(
      quotes.createRequest(body, "198.51.100.10", createKey),
    ).resolves.toMatchObject({ status: "NEW" });
    await expect(
      quotes.createRequest(body, "198.51.100.11", createKey),
    ).rejects.toMatchObject({ status: 409 });
  });

  function requestInput(scope: string) {
    return {
      description: `A detailed individual quote request for ${scope}`,
      purpose: "Replace a broken household part",
      measurements: { widthMm: 42, heightMm: 18 },
      requestedDate: "2026-10-01",
      contact: {
        name: `Test Customer ${scope}`,
        email: `${scope}-${randomUUID()}@example.test`,
        phone: "+420123456789",
      },
      attribution: { source: "e2e" },
    };
  }

  async function createRequest(
    idempotencyKey: string,
    body: ReturnType<typeof requestInput>,
  ) {
    return apiJson<{
      requestId: string;
      requestToken: string;
      status: string;
    }>("quote-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  }

  async function issueOffer(
    requestId: string,
    idempotencyKey: string,
    expiresAt: Date | string,
    components: Array<{
      kind: string;
      amountMinor: number;
      quoteItemOrdinal?: number;
    }> = defaultComponents(),
    items: Array<Record<string, unknown>> = defaultItems(),
  ) {
    return apiJson<{
      quoteId: string;
      offerToken: string;
      version: number;
      termsRevision: string;
    }>(`admin/quote-requests/${requestId}/offers`, {
      method: "POST",
      headers: {
        ...bearer(operatorToken),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        summary: "Custom modelling and production offer",
        expiresAt:
          typeof expiresAt === "string" ? expiresAt : expiresAt.toISOString(),
        promisedDate: "2026-10-01",
        priceListId,
        contractTotalMinor: 110_000,
        depositMinor: 33_000,
        termsSnapshot: { revisionAcceptedByOffer: true },
        inputSnapshot: { operatorEstimate: "manual-v0" },
        items,
        components,
      }),
    });
  }

  function defaultComponents() {
    return [
      {
        kind: "ITEM_PRODUCTION",
        quoteItemOrdinal: 0,
        amountMinor: 80_000,
      },
      {
        kind: "ITEM_QUANTITY",
        quoteItemOrdinal: 0,
        amountMinor: 20_000,
      },
      {
        kind: "ITEM_POSTPROCESSING",
        quoteItemOrdinal: 0,
        amountMinor: 10_000,
      },
    ];
  }

  function defaultItems(): Array<Record<string, unknown>> {
    return [
      {
        kind: "CUSTOM_SERVICE",
        serviceDescription: "Rebuild the damaged mounting bracket",
      },
    ];
  }

  async function acceptOffer(
    issued: {
      quoteId: string;
      offerToken: string;
      version: number;
      termsRevision: string;
    },
    idempotencyKey: string,
  ) {
    return apiJson<{
      orderId: string;
      publicReference: string;
      status: string;
    }>(`offers/${issued.quoteId}/accept`, {
      method: "POST",
      headers: {
        ...bearer(issued.offerToken),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        version: issued.version,
        termsRevision: issued.termsRevision,
      }),
    });
  }

  async function operatorCommand(path: string, idempotencyKey: string) {
    return apiJson<{ requestId: string; status: string }>(path, {
      method: "POST",
      headers: {
        ...bearer(operatorToken),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: "{}",
    });
  }

  async function apiJson<T = Record<string, unknown>>(
    path: string,
    init?: RequestInit,
  ): Promise<{ response: Response; body: T }> {
    const response = await fetch(new URL(path, baseUrl), init);
    return { response, body: (await response.json()) as T };
  }
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function key(scope: string): string {
  return `${scope}-${randomUUID()}`;
}

function rfc3339WithOffset(value: Date): string {
  return new Date(value.getTime() + 2 * 60 * 60 * 1_000)
    .toISOString()
    .replace(".000Z", "+02:00");
}
