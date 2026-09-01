import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import {
  configureHttpBodyParsers,
  HTTP_BODY_LIMIT_BYTES,
} from "../src/http-body.config";
import type { IssueOfferDto } from "../src/modules/quotes/quotes.dto";
import { QuotesService } from "../src/modules/quotes/quotes.service";
import { photoOriginalObjectKey } from "../src/modules/storage/storage-keys";
import { PrismaService } from "../src/prisma/prisma.service";

const operatorToken = "test-operator-token-with-at-least-32-characters";
const uploadClientHashKey = "test-only-upload-client-hash-key-32";
const quoteCapabilityKey =
  "test-quote-capability-key-with-at-least-32-characters";
process.env.TAVEN_OPERATOR_API_TOKEN ??= operatorToken;
process.env.TAVEN_QUOTE_CAPABILITY_KEY ??= quoteCapabilityKey;
process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS ??= "[]";
process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION ??= "us-east-1";
process.env.TAVEN_S3_BUCKET ??= "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID ??= "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??= uploadClientHashKey;

describe("QuoteRequest and tokenized individual offers", () => {
  let app: NestExpressApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let quotes: QuotesService;
  let priceListId: string;
  let defaultOfferItem: Record<string, unknown>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureHttpBodyParsers(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = new URL(await app.getUrl());
    prisma = app.get(PrismaService);
    quotes = app.get(QuotesService);
    const priceList = await prisma.priceList.findFirstOrThrow({
      where: { currency: "CZK" },
      orderBy: { createdAt: "asc" },
    });
    priceListId = priceList.id;
    defaultOfferItem = (
      await createModelOfferItem("default-offer-item", "NONE")
    ).item;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("rejects a null quote-request body as invalid client input", async () => {
    const response = await apiJson("quote-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key("null-body"),
      },
      body: "null",
    });

    expect(response.response.status).toBe(400);
  });

  it("counts astral Unicode text as contract characters", async () => {
    const created = await quotes.createRequest(
      {
        ...requestInput("astral-unicode"),
        description: "😀".repeat(6_000),
        purpose: "😀".repeat(1_500),
        contact: {
          ...requestInput("astral-unicode").contact,
          name: "😀".repeat(150),
        },
      },
      "198.51.100.48",
      key("astral-unicode-create"),
    );
    expect(created.status).toBe("NEW");
  });

  it("rejects email that exceeds its limit after case normalization", async () => {
    const response = await apiJson("quote-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key("case-expanded-email"),
      },
      body: JSON.stringify({
        ...requestInput("case-expanded-email"),
        contact: {
          ...requestInput("case-expanded-email").contact,
          email: `İ${"a".repeat(306)}@example.test`,
        },
      }),
    });

    expect(response.response.status).toBe(400);
  });

  it("rejects JSON inputs beyond the canonicalization depth limit", async () => {
    const response = await apiJson("quote-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key("deep-json"),
      },
      body: JSON.stringify({
        ...requestInput("deep-json"),
        measurements: nestedJson(65),
      }),
    });

    expect(response.response.status).toBe(400);
    expect(response.body).toMatchObject({
      message: "measurements must not exceed 64 levels",
    });
  });

  it("canonicalizes distinct Unicode keys with locale-independent ordering", async () => {
    const idempotencyKey = key("unicode-key-order");
    const clientAddress = "198.51.100.43";
    const input = requestInput("unicode-key-order");
    const first = await quotes.createRequest(
      {
        ...input,
        measurements: {
          é: "composed",
          é: "decomposed",
        },
      },
      clientAddress,
      idempotencyKey,
    );

    const replay = await quotes.createRequest(
      {
        ...input,
        measurements: {
          é: "decomposed",
          é: "composed",
        },
      },
      clientAddress,
      idempotencyKey,
    );
    expect(replay).toEqual(first);
  });

  it("starts a new append-only idempotency generation after expiry", async () => {
    const idempotencyKey = key("expired-generation");
    const clientAddress = "198.51.100.42";
    const input = requestInput("expired-generation");
    const first = await quotes.createRequest(
      input,
      clientAddress,
      idempotencyKey,
    );
    expect(first.status).toBe("NEW");
    const firstRecord = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { namespace: "quote-request.create", idempotencyKey },
      orderBy: { generation: "desc" },
    });
    await prisma.idempotencyRecord.update({
      where: { id: firstRecord.id },
      data: {
        expiresAt: new Date(firstRecord.createdAt.getTime() + 1),
      },
    });

    const second = await quotes.createRequest(
      input,
      clientAddress,
      idempotencyKey,
    );
    expect(second.status).toBe("NEW");
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.requestToken).not.toBe(first.requestToken);
    expect(
      await prisma.idempotencyRecord.findMany({
        where: { namespace: "quote-request.create", idempotencyKey },
        orderBy: { generation: "asc" },
        select: { generation: true, responseBody: true },
      }),
    ).toEqual([
      expect.objectContaining({
        generation: 1,
        responseBody: expect.objectContaining({
          requestId: first.requestId,
          capabilityTokenGeneration: 1,
        }),
      }),
      expect.objectContaining({
        generation: 2,
        responseBody: expect.objectContaining({
          requestId: second.requestId,
          capabilityTokenGeneration: 2,
        }),
      }),
    ]);
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
    const createIdempotency = await prisma.idempotencyRecord.findFirstOrThrow({
      where: {
        namespace: "quote-request.create",
        idempotencyKey: createKey,
      },
      orderBy: { generation: "desc" },
    });
    expect(createIdempotency.responseStatusCode).toBe(201);
    expect(createIdempotency.responseBody).not.toHaveProperty("requestToken");
    expect(JSON.stringify(createIdempotency.responseBody)).not.toContain(
      created.body.requestToken,
    );
    const capabilityKeyId = createHash("sha256")
      .update("taven-quote-capability-key\0")
      .update(quoteCapabilityKey)
      .digest("hex");
    expect(createIdempotency.responseBody).toMatchObject({
      capabilityKeyId,
      capabilityTokenGeneration: 1,
    });
    const persistedRequest = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: created.body.requestId },
      include: { quoteSession: true },
    });
    expect(persistedRequest.quoteSession?.capabilityKeyId).toBe(
      capabilityKeyId,
    );

    const rotatedRequestCapabilityKey =
      "rotated-request-capability-key-with-at-least-32-characters";
    process.env.TAVEN_QUOTE_CAPABILITY_KEY = rotatedRequestCapabilityKey;
    process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS = JSON.stringify([
      quoteCapabilityKey,
    ]);
    try {
      const replayAfterRotation = await createRequest(createKey, requestBody);
      expect(replayAfterRotation.response.status).toBe(201);
      expect(replayAfterRotation.body).toEqual(created.body);
    } finally {
      process.env.TAVEN_QUOTE_CAPABILITY_KEY = quoteCapabilityKey;
      process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS = "[]";
    }

    const changedReplay = await createRequest(createKey, {
      ...requestBody,
      purpose: "Changed input",
    });
    expect(changedReplay.response.status).toBe(409);

    const changedDateReplay = await createRequest(createKey, {
      ...requestBody,
      requestedDate: "2026-10-02",
    });
    expect(changedDateReplay.response.status).toBe(409);

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
    const legalReferencePhotoId = randomUUID();
    const claimReferencePhotoId = randomUUID();
    await prisma.photoAsset.createMany({
      data: [
        {
          id: legalReferencePhotoId,
          kind: "QUOTE_REFERENCE",
          scopeKind: "QUOTE_REQUEST",
          scopeId: created.body.requestId,
          storageObjectKey: photoOriginalObjectKey(legalReferencePhotoId),
          contentHash: "c".repeat(64),
          mediaType: "image/jpeg",
          sizeBytes: 128,
          uploadedAt: new Date(),
          retentionDays: 90,
          retentionHold: "LEGAL",
          photoDeleteAfter: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000),
        },
        {
          id: claimReferencePhotoId,
          kind: "QUOTE_REFERENCE",
          scopeKind: "QUOTE_REQUEST",
          scopeId: created.body.requestId,
          storageObjectKey: photoOriginalObjectKey(claimReferencePhotoId),
          contentHash: "d".repeat(64),
          mediaType: "image/jpeg",
          sizeBytes: 128,
          uploadedAt: new Date(),
          retentionDays: 90,
          retentionHold: "ACTIVE_CLAIM",
          photoDeleteAfter: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000),
        },
      ],
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
      `admin/quote-requests/${created.body.requestId.toUpperCase()}/attachments/${referencePhotoId.toUpperCase()}/download`,
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

    const lateReferencePhotoId = randomUUID();
    const latePhotoUploadedAt = new Date();
    await prisma.photoAsset.create({
      data: {
        id: lateReferencePhotoId,
        kind: "QUOTE_REFERENCE",
        scopeKind: "QUOTE_REQUEST",
        scopeId: created.body.requestId,
        storageObjectKey: photoOriginalObjectKey(lateReferencePhotoId),
        contentHash: "e".repeat(64),
        mediaType: "image/jpeg",
        sizeBytes: 128,
        uploadedAt: latePhotoUploadedAt,
        retentionDays: 90,
        photoDeleteAfter: new Date(
          latePhotoUploadedAt.getTime() + 90 * 24 * 60 * 60 * 1_000,
        ),
      },
    });
    expect(
      await prisma.photoAsset.findUniqueOrThrow({
        where: { id: lateReferencePhotoId },
        select: { photoDeleteAfter: true },
      }),
    ).toEqual({
      photoDeleteAfter: new Date(
        new Date(issued.body.expiresAt).getTime() + 90 * 24 * 60 * 60 * 1_000,
      ),
    });

    const normalizedReplay = await issueOffer(
      created.body.requestId,
      issueKey,
      offerExpiry,
    );
    expect(normalizedReplay.response.status).toBe(201);
    expect(normalizedReplay.body).toEqual(issued.body);
    const issueIdempotency = await prisma.idempotencyRecord.findFirstOrThrow({
      where: {
        namespace: "quote-request.issue-offer",
        idempotencyKey: issueKey,
      },
      orderBy: { generation: "desc" },
    });
    expect(issueIdempotency.responseStatusCode).toBe(201);
    expect(issueIdempotency.responseBody).not.toHaveProperty("offerToken");
    expect(JSON.stringify(issueIdempotency.responseBody)).not.toContain(
      issued.body.offerToken,
    );
    expect(issueIdempotency.responseBody).toMatchObject({
      capabilityKeyId,
    });
    const persistedQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: issued.body.quoteId },
    });
    expect(persistedQuote.capabilityKeyId).toBe(capabilityKeyId);
    const issueOutbox = await prisma.outboxMessage.findUniqueOrThrow({
      where: {
        deduplicationKey: `quote-offer-issued:${issued.body.quoteId}:1`,
      },
    });
    expect(issueOutbox.payload).not.toHaveProperty("offerToken");
    expect(JSON.stringify(issueOutbox.payload)).not.toContain(
      issued.body.offerToken,
    );
    expect(issueOutbox.payload).toMatchObject({
      quoteId: issued.body.quoteId,
      offerTokenDerivation: {
        quoteId: issued.body.quoteId,
        issuanceCommandKey: issueKey,
        capabilityKeyId,
      },
    });
    expect(
      createHmac("sha256", process.env.TAVEN_QUOTE_CAPABILITY_KEY!)
        .update(["quote-offer", issued.body.quoteId, issueKey].join("\0"))
        .digest("base64url"),
    ).toBe(issued.body.offerToken);

    const rotatedCapabilityKey =
      "rotated-test-quote-capability-key-with-at-least-32-characters";
    process.env.TAVEN_QUOTE_CAPABILITY_KEY = rotatedCapabilityKey;
    process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS = JSON.stringify([
      quoteCapabilityKey,
    ]);
    try {
      const replayAfterRotation = await issueOffer(
        created.body.requestId,
        issueKey,
        offerExpiry,
      );
      expect(replayAfterRotation.response.status).toBe(201);
      expect(replayAfterRotation.body).toEqual(issued.body);
    } finally {
      process.env.TAVEN_QUOTE_CAPABILITY_KEY = quoteCapabilityKey;
      process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS = "[]";
    }

    const wrongOfferToken = await apiJson(`offers/${issued.body.quoteId}`, {
      headers: bearer(randomBytes(32).toString("base64url")),
    });
    expect(wrongOfferToken.response.status).toBe(401);

    const preview = await apiJson<{
      version: number;
      termsRevision: string;
      contractTotalMinor: number;
      items: Array<Record<string, unknown>>;
      deliveryDestination: Record<string, unknown>;
      shipmentPlans: Array<Record<string, unknown>>;
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
        ...defaultOfferItem,
        primaryReferenceSliceResultId: null,
        tailReferenceSliceResultId: null,
        referencePartsPerPlate: null,
        color: null,
      },
    ]);
    expect(preview.body.deliveryDestination).toEqual(
      defaultDeliveryDestination(),
    );
    expect(preview.body.shipmentPlans).toEqual(defaultShipmentPlans());
    expect(preview.body.components).toEqual([
      {
        kind: "ITEM_PRODUCTION",
        scope: "QUOTE_ITEM",
        quoteItemOrdinal: 0,
        shipmentPlanOrdinal: null,
        amountMinor: 80_000,
        allocation: null,
      },
      {
        kind: "ITEM_QUANTITY",
        scope: "QUOTE_ITEM",
        quoteItemOrdinal: 0,
        shipmentPlanOrdinal: null,
        amountMinor: 20_000,
        allocation: null,
      },
      {
        kind: "ITEM_POSTPROCESSING",
        scope: "QUOTE_ITEM",
        quoteItemOrdinal: 0,
        shipmentPlanOrdinal: null,
        amountMinor: 10_000,
        allocation: null,
      },
      {
        kind: "SHIPMENT",
        scope: "QUOTE_SHIPMENT_PLAN",
        quoteItemOrdinal: null,
        shipmentPlanOrdinal: 0,
        amountMinor: 0,
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
    await expect(
      prisma.idempotencyRecord.findFirstOrThrow({
        where: {
          namespace: "quote-offer.accept",
          idempotencyKey: acceptKey,
        },
        select: { responseStatusCode: true },
      }),
    ).resolves.toEqual({ responseStatusCode: 200 });
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
          include: {
            order: {
              include: {
                activePriceBinding: true,
                deliveryDestinations: true,
                fulfilmentSlots: true,
                items: true,
                phases: true,
                shipmentPlans: true,
              },
            },
          },
        },
        shipmentPlans: true,
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
      sourceModelFileId: defaultOfferItem.sourceModelFileId,
      modelGeometryId: defaultOfferItem.modelGeometryId,
      printConfigRevisionId: defaultOfferItem.printConfigRevisionId,
      material: defaultOfferItem.material,
    });
    expect(persisted.shipmentPlans).toHaveLength(1);
    expect(
      persisted.individualOrderOrigin?.order.activePriceBinding,
    ).not.toBeNull();
    expect(
      persisted.individualOrderOrigin?.order.deliveryDestinations,
    ).toHaveLength(1);
    expect(persisted.individualOrderOrigin?.order.phases).toHaveLength(1);
    expect(persisted.individualOrderOrigin?.order.fulfilmentSlots).toHaveLength(
      1,
    );
    expect(persisted.individualOrderOrigin?.order.shipmentPlans).toEqual([
      expect.objectContaining({
        quoteShipmentPlanId: persisted.shipmentPlans[0]!.id,
        shippingAmountMinor: BigInt(0),
        packagingAmountMinor: BigInt(0),
        handlingAmountMinor: BigInt(0),
      }),
    ]);
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
    expect(
      await prisma.photoAsset.findUniqueOrThrow({
        where: { id: legalReferencePhotoId },
        select: { retentionHold: true },
      }),
    ).toEqual({ retentionHold: "LEGAL" });
    expect(
      await prisma.photoAsset.findUniqueOrThrow({
        where: { id: claimReferencePhotoId },
        select: { retentionHold: true },
      }),
    ).toEqual({ retentionHold: "ACTIVE_CLAIM" });

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

  it("accepts and canonicalizes uppercase UUIDs allowed by the API contract", async () => {
    const created = await quotes.createRequest(
      requestInput("uppercase-uuid"),
      "198.51.100.45",
      key("uppercase-uuid-create"),
    );
    const uppercaseRequestId = created.requestId.toUpperCase();
    const request = await apiJson<{ requestId: string }>(
      `quote-requests/${uppercaseRequestId}`,
      { headers: bearer(created.requestToken) },
    );
    expect(request.response.status).toBe(200);
    expect(request.body.requestId).toBe(created.requestId);

    const reviewed = await operatorCommand(
      `admin/quote-requests/${uppercaseRequestId}/review`,
      key("uppercase-uuid-review"),
    );
    expect(reviewed.response.status).toBe(200);

    const issueKey = key("uppercase-uuid-issue");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    const uppercaseItem = {
      ...defaultOfferItem,
      sourceModelFileId: String(
        defaultOfferItem.sourceModelFileId,
      ).toUpperCase(),
      modelGeometryId: String(defaultOfferItem.modelGeometryId).toUpperCase(),
      printConfigRevisionId: String(
        defaultOfferItem.printConfigRevisionId,
      ).toUpperCase(),
    };
    const issued = await issueOffer(
      uppercaseRequestId,
      issueKey,
      expiresAt,
      defaultComponents(),
      [uppercaseItem],
      priceListId.toUpperCase(),
    );
    expect(issued.response.status).toBe(201);

    const canonicalReplay = await issueOffer(
      created.requestId,
      issueKey,
      expiresAt,
    );
    expect(canonicalReplay.response.status).toBe(201);
    expect(canonicalReplay.body).toEqual(issued.body);

    const preview = await apiJson<{ quoteId: string }>(
      `offers/${issued.body.quoteId.toUpperCase()}`,
      { headers: bearer(issued.body.offerToken) },
    );
    expect(preview.response.status).toBe(200);
    expect(preview.body.quoteId).toBe(issued.body.quoteId);

    const accepted = await apiJson<{ status: string }>(
      `offers/${issued.body.quoteId.toUpperCase()}/accept`,
      {
        method: "POST",
        headers: {
          ...bearer(issued.body.offerToken),
          "content-type": "application/json",
          "idempotency-key": key("uppercase-uuid-accept"),
        },
        body: JSON.stringify({
          version: issued.body.version,
          termsRevision: issued.body.termsRevision,
        }),
      },
    );
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.status).toBe("DRAFT");
  });

  it("accepts high-volume packing units with batched slot writes", async () => {
    const quantity = 1_000;
    const created = await quotes.createRequest(
      requestInput("batched-acceptance"),
      "198.51.100.44",
      key("batched-acceptance-create"),
    );
    await quotes.beginReview(
      created.requestId,
      key("batched-acceptance-review"),
    );
    const issued = await issueOffer(
      created.requestId,
      key("batched-acceptance-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      [{ ...defaultOfferItem, quantity }],
    );
    expect(issued.response.status).toBe(201);

    const accepted = await acceptOffer(
      issued.body,
      key("batched-acceptance-accept"),
    );
    expect(accepted.response.status).toBe(200);
    await expect(
      prisma.fulfilmentSlot.count({
        where: { orderId: accepted.body.orderId },
      }),
    ).resolves.toBe(quantity);
    await expect(
      prisma.shipmentPlanFulfilmentSlot.count({
        where: { shipmentPlan: { orderId: accepted.body.orderId } },
      }),
    ).resolves.toBe(quantity);
  });

  it("issues a many-item offer with bounded reference lookup batches", async () => {
    const itemCount = 501;
    const created = await quotes.createRequest(
      requestInput("batched-reference-lookups"),
      "198.51.100.46",
      key("batched-reference-lookups-create"),
    );
    await quotes.beginReview(
      created.requestId,
      key("batched-reference-lookups-review"),
    );
    const sourceModelFileId = String(defaultOfferItem.sourceModelFileId);
    const references = Array.from({ length: itemCount }, (_, ordinal) => ({
      ordinal,
      modelGeometryId: randomUUID(),
      printConfigRevisionId: randomUUID(),
    }));
    await prisma.$transaction(async (transaction) => {
      await transaction.revisionIdentity.createMany({
        data: references.map(({ printConfigRevisionId }) => ({
          id: printConfigRevisionId,
          kind: "PRINT_CONFIG",
          digest: createHash("sha256")
            .update(`batched-reference-config:${printConfigRevisionId}`)
            .digest("hex"),
        })),
      });
      await transaction.printConfigRevision.createMany({
        data: references.map(({ printConfigRevisionId }) => ({
          id: printConfigRevisionId,
          quality: "STANDARD",
          infillPercent: 20,
          layerHeightMicrometers: 200,
          settings: {},
        })),
      });
      await transaction.modelGeometry.createMany({
        data: references.map(({ ordinal, modelGeometryId }) => ({
          id: modelGeometryId,
          sourceModelFileId,
          canonicalObjectKey: `quote-tests/geometries/batched-${modelGeometryId}`,
          geometryHash: createHash("sha256")
            .update(`batched-reference-geometry:${ordinal}`)
            .digest("hex"),
          canonicalizerRevision: "quote-e2e-v1",
          volumeCubicMicrometers: 1n,
          boundsXMicrometers: 1n,
          boundsYMicrometers: 1n,
          boundsZMicrometers: 1n,
          triangleCount: 1,
        })),
      });
    });
    const items: Array<Record<string, unknown>> = references.map(
      ({ modelGeometryId, printConfigRevisionId }) => ({
        kind: "MODEL",
        sourceModelFileId,
        modelGeometryId,
        printConfigRevisionId,
        material: "PLA",
        quantity: 1,
      }),
    );
    const components: IssueOfferDto["components"] = references.flatMap(
      ({ ordinal }) => [
        {
          kind: "ITEM_PRODUCTION" as const,
          quoteItemOrdinal: ordinal,
          amountMinor: 1,
        },
        {
          kind: "ITEM_QUANTITY" as const,
          quoteItemOrdinal: ordinal,
          amountMinor: 0,
        },
        {
          kind: "ITEM_POSTPROCESSING" as const,
          quoteItemOrdinal: ordinal,
          amountMinor: 0,
        },
      ],
    );
    const shipmentPlans = [
      {
        category: "STANDARD",
        plannedVolumeCubicMm: itemCount,
        plannedWeightMilligrams: itemCount,
        shippingAmountMinor: 0,
        packagingAmountMinor: 0,
        handlingAmountMinor: 0,
        packingUnits: references.map(({ ordinal }) => ({
          quoteItemOrdinal: ordinal,
          quantityOrdinal: 1,
        })),
      },
    ];
    const variablePayloadBytes = Buffer.byteLength(
      JSON.stringify({ components, items, shipmentPlans }),
    );
    expect(variablePayloadBytes).toBeGreaterThan(100 * 1024);
    expect(variablePayloadBytes).toBeLessThan(HTTP_BODY_LIMIT_BYTES);
    const issued = await issueOffer(
      created.requestId,
      key("batched-reference-lookups-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      components,
      items,
      priceListId,
      {
        contractTotalMinor: itemCount,
        depositMinor: 1,
        shipmentPlans,
      },
    );
    expect(issued.response.status).toBe(201);
    await expect(
      prisma.quoteItem.count({ where: { quoteId: issued.body.quoteId } }),
    ).resolves.toBe(itemCount);
  });

  it("rejects a non-canonical price-list terms revision", async () => {
    const selectedPriceList = await prisma.priceList.create({
      data: {
        revision: `quote-e2e-spaced-terms-${randomUUID()}`,
        termsRevision: "  terms-spaced-v1  ",
        currency: "CZK",
        parameters: {
          balance_payment_days: 7,
          balance_timeout_earned_component_kinds: ["ITEM_PRODUCTION"],
        },
      },
    });
    const created = await quotes.createRequest(
      requestInput("spaced-terms"),
      "198.51.100.49",
      key("spaced-terms-create"),
    );
    await quotes.beginReview(created.requestId, key("spaced-terms-review"));

    const issued = await issueOffer(
      created.requestId,
      key("spaced-terms-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      defaultItems(),
      selectedPriceList.id,
    );
    expect(issued.response.status).toBe(400);
    expect(issued.body).toMatchObject({
      message: "priceListId has a non-canonical terms revision",
    });
    await expect(
      prisma.quote.count({ where: { quoteRequestId: created.requestId } }),
    ).resolves.toBe(0);
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

    let backdatedUpdateCompleted = false;
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.quoteRequest.update({
          where: { id: created.body.requestId },
          data: {
            status: "ACCEPTED",
            acceptedAt: new Date(new Date(issued.body.expiresAt).getTime() - 1),
            currentStateCommandKey: key("backdated-acceptance"),
            currentStateResultId: randomUUID(),
            updatedAt: new Date(),
          },
        });
        backdatedUpdateCompleted = true;
        throw new Error("backdated acceptance unexpectedly succeeded");
      }),
    ).rejects.toBeDefined();
    expect(backdatedUpdateCompleted).toBe(false);

    const acceptKey = key("expiry-accept");
    const acceptance = await acceptOffer(issued.body, acceptKey);
    expect(acceptance.response.status).toBe(410);
    await expect(
      prisma.idempotencyRecord.findFirstOrThrow({
        where: {
          namespace: "quote-offer.accept",
          idempotencyKey: acceptKey,
        },
        select: { responseStatusCode: true },
      }),
    ).resolves.toEqual({ responseStatusCode: 410 });
    const replay = await acceptOffer(issued.body, acceptKey);
    expect(replay.response.status).toBe(410);

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

  it("accepts against one captured database instant near the deadline", async () => {
    const created = await quotes.createRequest(
      requestInput("acceptance-deadline-race"),
      "198.51.100.47",
      key("acceptance-deadline-race-create"),
    );
    await quotes.beginReview(
      created.requestId,
      key("acceptance-deadline-race-review"),
    );
    const issued = await issueOffer(
      created.requestId,
      key("acceptance-deadline-race-issue"),
      new Date(Date.now() + 2_000),
    );
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION taven_test_delay_deadline_order_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM customers
          WHERE id = NEW.customer_id
            AND email LIKE 'acceptance-deadline-race-%@example.test'
        ) THEN
          PERFORM pg_sleep(3);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER taven_test_delay_deadline_order_insert
      BEFORE INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION taven_test_delay_deadline_order_insert()
    `);
    try {
      const accepted = await acceptOffer(
        issued.body,
        key("acceptance-deadline-race-accept"),
      );
      expect(accepted.response.status).toBe(200);
      expect(Date.now()).toBeGreaterThanOrEqual(
        new Date(issued.body.expiresAt).getTime(),
      );
      const persisted = await prisma.quoteRequest.findUniqueOrThrow({
        where: { id: created.requestId },
        select: { acceptedAt: true, status: true },
      });
      expect(persisted.status).toBe("ACCEPTED");
      expect(persisted.acceptedAt!.getTime()).toBeLessThan(
        new Date(issued.body.expiresAt).getTime(),
      );
      await expect(
        prisma.quoteRequest.update({
          where: { id: created.requestId },
          data: {
            acceptedAt: new Date(persisted.acceptedAt!.getTime() - 1_000),
          },
        }),
      ).rejects.toBeDefined();
      await expect(
        prisma.quoteRequest.findUniqueOrThrow({
          where: { id: created.requestId },
          select: { acceptedAt: true },
        }),
      ).resolves.toEqual({ acceptedAt: persisted.acceptedAt });
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS taven_test_delay_deadline_order_insert ON orders
      `);
      await prisma.$executeRawUnsafe(`
        DROP FUNCTION IF EXISTS taven_test_delay_deadline_order_insert()
      `);
    }
  }, 15_000);

  it("persists quoted shipment charges and fees for both planned captures", async () => {
    const created = await createRequest(
      key("fee-create"),
      requestInput("fee-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.body.requestId}/review`,
      key("fee-review"),
    );
    const issued = await issueOffer(
      created.body.requestId,
      key("fee-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      defaultItems(),
      priceListId,
      {
        contractTotalMinor: 121_415,
        shipmentPlans: [
          {
            ...defaultShipmentPlans()[0]!,
            shippingAmountMinor: 8_500,
            packagingAmountMinor: 1_000,
            handlingAmountMinor: 500,
          },
        ],
        paymentPolicy: {
          deposit: {
            feeRateBasisPoints: 100,
            feeFixedMinor: 100,
            providerConfig: { provider: "test", capture: "deposit" },
          },
          balance: {
            feeRateBasisPoints: 100,
            feeFixedMinor: 100,
            providerConfig: { provider: "test", capture: "balance" },
          },
        },
      },
    );
    expect(issued.response.status).toBe(201);

    const snapshot = await prisma.priceSnapshot.findFirstOrThrow({
      where: { quoteBinding: { quoteId: issued.body.quoteId } },
      include: {
        components: { orderBy: { amountMinor: "asc" } },
        paymentSchedules: { orderBy: { sequence: "asc" } },
        quoteShipmentPlans: true,
      },
    });
    expect(snapshot.quoteShipmentPlans).toEqual([
      expect.objectContaining({
        shippingAmountMinor: BigInt(8_500),
        packagingAmountMinor: BigInt(1_000),
        handlingAmountMinor: BigInt(500),
      }),
    ]);
    expect(snapshot.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "SHIPMENT",
          scope: "QUOTE_SHIPMENT_PLAN",
          amountMinor: BigInt(10_000),
        }),
        expect.objectContaining({
          kind: "PAYMENT_FEE",
          scope: "ORDER",
          amountMinor: BigInt(1_415),
        }),
      ]),
    );
    expect(snapshot.paymentSchedules).toEqual([
      expect.objectContaining({
        role: "DEPOSIT",
        grossAmountMinor: BigInt(33_000),
        feeRateBasisPoints: 100,
        feeFixedMinor: BigInt(100),
        providerConfig: { provider: "test", capture: "deposit" },
      }),
      expect.objectContaining({
        role: "BALANCE",
        grossAmountMinor: BigInt(88_415),
        feeRateBasisPoints: 100,
        feeFixedMinor: BigInt(100),
        providerConfig: { provider: "test", capture: "balance" },
      }),
    ]);

    const accepted = await acceptOffer(issued.body, key("fee-accept"));
    expect(accepted.response.status).toBe(200);
    expect(
      await prisma.shipmentPlan.findUniqueOrThrow({
        where: {
          quoteShipmentPlanId: snapshot.quoteShipmentPlans[0]!.id,
        },
        select: {
          orderId: true,
          shippingAmountMinor: true,
          packagingAmountMinor: true,
          handlingAmountMinor: true,
        },
      }),
    ).toEqual({
      orderId: accepted.body.orderId,
      shippingAmountMinor: BigInt(8_500),
      packagingAmountMinor: BigInt(1_000),
      handlingAmountMinor: BigInt(500),
    });
  });

  it("rejects overflowing shipment and capture-fee aggregates as client input", async () => {
    const shipmentRequest = await quotes.createRequest(
      requestInput("shipment-overflow"),
      "198.51.100.40",
      key("shipment-overflow-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${shipmentRequest.requestId}/review`,
      key("shipment-overflow-review"),
    );
    const shipmentOverflow = await issueOffer(
      shipmentRequest.requestId,
      key("shipment-overflow-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      defaultItems(),
      priceListId,
      {
        shipmentPlans: [
          {
            ...defaultShipmentPlans()[0]!,
            shippingAmountMinor: Number.MAX_SAFE_INTEGER,
            packagingAmountMinor: 1,
          },
        ],
      },
    );
    expect(shipmentOverflow.response.status).toBe(400);
    expect(shipmentOverflow.body).toMatchObject({
      message:
        "shipmentPlans[0] charge total must be a non-negative safe integer",
    });

    const feeRequest = await quotes.createRequest(
      requestInput("fee-overflow"),
      "198.51.100.41",
      key("fee-overflow-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${feeRequest.requestId}/review`,
      key("fee-overflow-review"),
    );
    const feeOverflow = await issueOffer(
      feeRequest.requestId,
      key("fee-overflow-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      defaultItems(),
      priceListId,
      {
        paymentPolicy: {
          deposit: {
            feeRateBasisPoints: 0,
            feeFixedMinor: Number.MAX_SAFE_INTEGER,
            providerConfig: { provider: "overflow-test" },
          },
          balance: {
            feeRateBasisPoints: 0,
            feeFixedMinor: 1,
            providerConfig: { provider: "overflow-test" },
          },
        },
      },
    );
    expect(feeOverflow.response.status).toBe(400);
    expect(feeOverflow.body).toMatchObject({
      message: "payment fee total must be a non-negative safe integer",
    });
    expect(
      await prisma.quote.count({
        where: {
          quoteRequestId: {
            in: [shipmentRequest.requestId, feeRequest.requestId],
          },
        },
      }),
    ).toBe(0);
  });

  it("rejects unplannable custom-service items before offer persistence", async () => {
    const created = await createRequest(
      key("custom-service-create"),
      requestInput("custom-service-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.body.requestId}/review`,
      key("custom-service-review"),
    );
    const response = await issueOffer(
      created.body.requestId,
      key("custom-service-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      [
        {
          kind: "CUSTOM_SERVICE",
          serviceDescription: "Rebuild the damaged mounting bracket",
        },
      ],
    );

    expect(response.response.status).toBe(400);
    expect(
      await prisma.quote.count({
        where: { quoteRequestId: created.body.requestId },
      }),
    ).toBe(0);
  });

  it("rejects price lists without a complete split-payment policy", async () => {
    const created = await quotes.createRequest(
      requestInput("invalid-split-policy-create"),
      "198.51.100.25",
      key("invalid-split-policy-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("invalid-split-policy-review"),
    );
    const invalidPolicies = [
      {
        scope: "missing-deadline",
        parameters: {
          balance_timeout_earned_component_kinds: ["ITEM_PRODUCTION"],
        },
      },
      {
        scope: "missing-earned-components",
        parameters: { balance_payment_days: 7 },
      },
    ];
    for (const invalid of invalidPolicies) {
      const priceList = await prisma.priceList.create({
        data: {
          revision: `quote-e2e-${invalid.scope}-${randomUUID()}`,
          termsRevision: "terms-v1",
          currency: "CZK",
          parameters: invalid.parameters,
        },
      });
      const response = await issueOffer(
        created.requestId,
        key(`invalid-split-policy-${invalid.scope}`),
        new Date(Date.now() + 60 * 60 * 1_000),
        defaultComponents(),
        defaultItems(),
        priceList.id,
      );

      expect(response.response.status).toBe(400);
      expect(response.body).toMatchObject({
        message: "priceListId does not support individual split payments",
      });
    }
    expect(
      await prisma.quoteRequest.findUniqueOrThrow({
        where: { id: created.requestId },
        select: { status: true },
      }),
    ).toEqual({ status: "IN_REVIEW" });
    expect(
      await prisma.quote.count({
        where: { quoteRequestId: created.requestId },
      }),
    ).toBe(0);
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
    const unavailableReferences = {
      kind: "MODEL",
      sourceModelFileId: randomUUID(),
      modelGeometryId: randomUUID(),
      printConfigRevisionId: randomUUID(),
      material: "PLA",
    };
    const emptySlice = await issueOffer(
      created.requestId,
      key("empty-slice-id-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      [{ ...defaultOfferItem, primaryReferenceSliceResultId: "" }],
    );
    expect(emptySlice.response.status).toBe(400);
    expect(emptySlice.body).toMatchObject({
      message: "items[0].primaryReferenceSliceResultId must be a UUID",
    });

    const oversized = await issueOffer(
      created.requestId,
      key("oversized-model-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      [{ ...unavailableReferences, quantity: 2_147_483_647 }],
    );
    expect(oversized.response.status).toBe(400);
    expect(oversized.body).toMatchObject({
      message: "items[0].quantity must be a positive safe integer",
    });

    const response = await issueOffer(
      created.requestId,
      key("invalid-model-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      [{ ...unavailableReferences, quantity: 1 }],
    );
    expect(response.response.status).toBe(400);
    expect(
      await prisma.quote.count({
        where: { quoteRequestId: created.requestId },
      }),
    ).toBe(0);
  });

  it("extends quoted model retention and preserves source holds on acceptance", async () => {
    const created = await quotes.createRequest(
      requestInput("model-retention"),
      "198.51.100.23",
      key("model-retention-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("model-retention-review"),
    );
    const activeSource = await createModelOfferItem("active-source", "NONE");
    const legalSource = await createModelOfferItem("legal-source", "LEGAL");
    const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1_000);
    const issued = await issueOffer(
      created.requestId,
      key("model-retention-issue"),
      expiresAt,
      [0, 1].flatMap((quoteItemOrdinal) => [
        { kind: "ITEM_PRODUCTION", quoteItemOrdinal, amountMinor: 40_000 },
        { kind: "ITEM_QUANTITY", quoteItemOrdinal, amountMinor: 5_000 },
        {
          kind: "ITEM_POSTPROCESSING",
          quoteItemOrdinal,
          amountMinor: 10_000,
        },
      ]),
      [activeSource.item, legalSource.item],
    );
    expect(issued.response.status).toBe(201);

    const quotedSources = await prisma.modelFile.findMany({
      where: { id: { in: [activeSource.id, legalSource.id] } },
      orderBy: { id: "asc" },
    });
    for (const source of quotedSources) {
      expect(source.sourceDeleteAfter.getTime()).toBeGreaterThanOrEqual(
        expiresAt.getTime() + source.sourceRetentionDays * 24 * 60 * 60 * 1_000,
      );
    }

    const accepted = await acceptOffer(
      issued.body,
      key("model-retention-accept"),
    );
    expect(accepted.response.status).toBe(200);
    expect(
      await prisma.modelFile.findUniqueOrThrow({
        where: { id: activeSource.id },
        select: { retentionHold: true },
      }),
    ).toEqual({ retentionHold: "ACTIVE_ORDER" });
    expect(
      await prisma.modelFile.findUniqueOrThrow({
        where: { id: legalSource.id },
        select: { retentionHold: true },
      }),
    ).toEqual({ retentionHold: "LEGAL" });
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
      measurements: { widthMm: 42, heightMm: 18 } as Record<string, unknown>,
      requestedDate: "2026-10-01",
      contact: {
        name: `Test Customer ${scope}`,
        email: `${scope}-${randomUUID()}@example.test`,
        phone: "+420123456789",
      },
      attribution: { source: "e2e" },
    };
  }

  async function createModelOfferItem(
    scope: string,
    retentionHold: "NONE" | "LEGAL",
  ) {
    const id = randomUUID();
    const modelGeometryId = randomUUID();
    const printConfigRevisionId = randomUUID();
    const uploadedAt = new Date(Date.now() - 60_000);
    await prisma.$transaction(async (transaction) => {
      await transaction.modelFile.create({
        data: {
          id,
          format: "STL",
          originalFilename: `${scope}.stl`,
          storageObjectKey: `quote-tests/models/${id}`,
          contentHash: createHash("sha256").update(scope).digest("hex"),
          sizeBytes: 1n,
          uploadedAt,
          sourceDeleteAfter: new Date(Date.now() + 60 * 60 * 1_000),
          sourceRetentionDays: 2,
          retentionHold,
        },
      });
      await transaction.modelGeometry.create({
        data: {
          id: modelGeometryId,
          sourceModelFileId: id,
          canonicalObjectKey: `quote-tests/geometries/${modelGeometryId}`,
          geometryHash: createHash("sha256")
            .update(`${scope}:geometry`)
            .digest("hex"),
          canonicalizerRevision: "quote-e2e-v1",
          volumeCubicMicrometers: 1n,
          boundsXMicrometers: 1n,
          boundsYMicrometers: 1n,
          boundsZMicrometers: 1n,
          triangleCount: 1,
        },
      });
      await transaction.revisionIdentity.create({
        data: {
          id: printConfigRevisionId,
          kind: "PRINT_CONFIG",
          digest: createHash("sha256")
            .update(`${scope}:${printConfigRevisionId}:print-config`)
            .digest("hex"),
        },
      });
      await transaction.printConfigRevision.create({
        data: {
          id: printConfigRevisionId,
          quality: "STANDARD",
          infillPercent: 20,
          layerHeightMicrometers: 200,
          settings: {},
        },
      });
    });
    return {
      id,
      item: {
        kind: "MODEL",
        sourceModelFileId: id,
        modelGeometryId,
        printConfigRevisionId,
        material: "PLA",
        quantity: 1,
      },
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
    selectedPriceListId = priceListId,
    options: {
      contractTotalMinor?: number;
      depositMinor?: number;
      deliveryDestination?: ReturnType<typeof defaultDeliveryDestination>;
      shipmentPlans?: ReturnType<typeof defaultShipmentPlans>;
      paymentPolicy?: ReturnType<typeof defaultPaymentPolicy>;
    } = {},
  ) {
    return apiJson<{
      quoteId: string;
      offerToken: string;
      version: number;
      termsRevision: string;
      expiresAt: string;
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
        priceListId: selectedPriceListId,
        contractTotalMinor: options.contractTotalMinor ?? 110_000,
        depositMinor: options.depositMinor ?? 33_000,
        termsSnapshot: { revisionAcceptedByOffer: true },
        inputSnapshot: { operatorEstimate: "manual-v0" },
        deliveryDestination:
          options.deliveryDestination ?? defaultDeliveryDestination(),
        shipmentPlans:
          options.shipmentPlans ?? defaultShipmentPlansForItems(items),
        paymentPolicy: options.paymentPolicy ?? defaultPaymentPolicy(),
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

  function defaultDeliveryDestination() {
    return {
      providerEndpointId: "test-delivery-endpoint",
      endpointType: "DELIVERY",
      addressSnapshot: { country: "CZ", postalCode: "11000" },
      capabilitySnapshot: { carrier: "test", service: "standard" },
    };
  }

  function defaultShipmentPlans() {
    return defaultShipmentPlansForItems(defaultItems());
  }

  function defaultShipmentPlansForItems(items: Array<Record<string, unknown>>) {
    return [
      {
        category: "STANDARD",
        plannedVolumeCubicMm: 1_000,
        plannedWeightMilligrams: 1_000,
        shippingAmountMinor: 0,
        packagingAmountMinor: 0,
        handlingAmountMinor: 0,
        packingUnits: items.flatMap((item, quoteItemOrdinal) =>
          Array.from(
            {
              length:
                typeof item.quantity === "number" &&
                Number.isSafeInteger(item.quantity) &&
                item.quantity > 0 &&
                item.quantity <= 1_000
                  ? item.quantity
                  : 1,
            },
            (_, quantityIndex) => ({
              quoteItemOrdinal,
              quantityOrdinal: quantityIndex + 1,
            }),
          ),
        ),
      },
    ];
  }

  function defaultPaymentPolicy(): {
    deposit: {
      feeRateBasisPoints: number;
      feeFixedMinor: number;
      providerConfig: Record<string, unknown>;
    };
    balance: {
      feeRateBasisPoints: number;
      feeFixedMinor: number;
      providerConfig: Record<string, unknown>;
    };
  } {
    return {
      deposit: {
        feeRateBasisPoints: 0,
        feeFixedMinor: 0,
        providerConfig: { mode: "provider-neutral" },
      },
      balance: {
        feeRateBasisPoints: 0,
        feeFixedMinor: 0,
        providerConfig: { mode: "provider-neutral" },
      },
    };
  }

  function defaultItems(): Array<Record<string, unknown>> {
    return [defaultOfferItem];
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

function nestedJson(depth: number): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (let index = 1; index < depth; index += 1) {
    result = { nested: result };
  }
  return result;
}
