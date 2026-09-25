import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import type { OperatorContext } from "../src/modules/admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../src/modules/admin-access/operator-permissions";
import {
  configureHttpBodyParsers,
  HTTP_BODY_LIMIT_BYTES,
} from "../src/http-body.config";
import type { IssueOfferDto } from "../src/modules/quotes/quotes.dto";
import { computeLegalRevisionContentHash } from "../src/modules/legal-documents/legal-documents.service";
import { QuotesService } from "../src/modules/quotes/quotes.service";
import { LegalDocumentsService } from "../src/modules/legal-documents/legal-documents.service";
import {
  databaseNow,
  LegalApprovalsService,
} from "../src/modules/legal-approvals/legal-approvals.service";
import { photoOriginalObjectKey } from "../src/modules/storage/storage-keys";
import { PrismaService } from "../src/prisma/prisma.service";
import { e2eLegalRevisionCodes } from "./support/publish-e2e-legal-fixtures";
import type {
  CandidateEstimateJob,
  CandidateEstimateResult,
} from "@taven/slicer-contracts" with { "resolution-mode": "import" };
import { CandidateEstimateService } from "../src/modules/resources/candidate-estimate.service";
import { AutomaticQuotesService } from "../src/modules/automatic-quotes/automatic-quotes.service";
import { EligibilityPlanService } from "../src/modules/resources/eligibility-plan.service";
import { ResourceConflictError } from "../src/modules/resources/resource-errors";
import { ResourceReservationService } from "../src/modules/resources/resource-reservation.service";

const uploadClientHashKey = "test-only-upload-client-hash-key-32";
const quoteCapabilityKey =
  "test-quote-capability-key-with-at-least-32-characters";
process.env.TAVEN_ENVIRONMENT ??= "development";
process.env.TAVEN_QUOTE_CAPABILITY_KEY ??= quoteCapabilityKey;
process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS ??= "[]";
process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION ??= "us-east-1";
process.env.TAVEN_S3_BUCKET ??= "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID ??= "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??= uploadClientHashKey;
process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED ??= "true";
process.env.TAVEN_QUOTE_PHOTO_UPLOADS_ENABLED ??= "true";
process.env.TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED ??= "true";
process.env.TAVEN_PAYMENT_PROVIDER ??= "sandbox";
const initialTermsRevision = process.env.TAVEN_TERMS_REVISION;

describe("QuoteRequest and tokenized individual offers", () => {
  let app: NestExpressApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let quotes: QuotesService;
  let candidates: CandidateEstimateService;
  let eligibilityPlans: EligibilityPlanService;
  let legalDocuments: LegalDocumentsService;
  let priceListId: string;
  let selectionVersion: number;
  let termsSnapshot: Record<string, unknown>;
  let claimsSnapshot: Record<string, unknown>;
  let defaultOfferItem: Record<string, unknown>;
  let operatorCookie: string;
  let operatorCsrfToken: string;
  let operator: OperatorContext;

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
    candidates = app.get(CandidateEstimateService);
    eligibilityPlans = app.get(EligibilityPlanService);
    legalDocuments = app.get(LegalDocumentsService);
    const node = await prisma.node.findFirstOrThrow({
      where: { active: true },
    });
    const identity = await prisma.operatorIdentity.create({
      data: {
        email: `quotes-e2e-${randomUUID()}@example.test`,
        role: "ADMIN",
        nodeGrants: { create: { nodeId: node.id } },
      },
    });
    const token = randomBytes(32).toString("base64url");
    const csrfKey = createHash("sha256")
      .update("openapi:TAVEN_ADMIN_CSRF_KEY")
      .digest();
    operatorCsrfToken = createHmac("sha256", csrfKey)
      .update(token)
      .digest("base64url");
    await prisma.operatorSession.create({
      data: {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        csrfHash: createHash("sha256").update(operatorCsrfToken).digest("hex"),
        operatorId: identity.id,
        authenticationMethod: "DEVELOPMENT_PASSWORD",
        credentialVersion: 1,
        absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    });
    operator = {
      operatorId: identity.id,
      role: "ADMIN",
      permissions: Object.values(OPERATOR_PERMISSIONS),
      nodeIds: [node.id],
      authenticationMethod: "DEVELOPMENT_PASSWORD",
      sessionId: randomUUID(),
    };
    operatorCookie = `taven_admin=${token}`;
    const currentPolicy =
      await prisma.commercialPolicySelection.findUniqueOrThrow({
        where: { currency: "CZK" },
        include: { priceList: true },
      });
    const createPolicy = await fetch(
      new URL("admin/catalog/price-lists", baseUrl),
      {
        method: "POST",
        headers: {
          cookie: operatorCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": operatorCsrfToken,
          "content-type": "application/json",
          "idempotency-key": key("quote-suite-policy-create"),
        },
        body: JSON.stringify({
          currency: "CZK",
          revision: `quote-suite-${randomUUID()}`,
          termsRevision: currentPolicy.priceList.termsRevision,
          parameters: {
            ...(currentPolicy.priceList.parameters as Record<string, unknown>),
            balance_payment_days: 7,
            balance_timeout_earned_component_kinds: [
              "ITEM_PRODUCTION",
              "ITEM_QUANTITY",
              "ITEM_POSTPROCESSING",
            ],
          },
        }),
      },
    );
    expect(createPolicy.status).toBe(200);
    const createdPolicy = (await createPolicy.json()) as { id: string };
    const activatePolicy = await fetch(
      new URL(
        `admin/catalog/price-lists/${createdPolicy.id}/activate`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          cookie: operatorCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": operatorCsrfToken,
          "content-type": "application/json",
          "idempotency-key": key("quote-suite-policy-activate"),
        },
        body: JSON.stringify({
          expectedSelectionVersion: currentPolicy.selectionVersion,
          reason: "Quote suite combined policy",
        }),
      },
    );
    expect(activatePolicy.status).toBe(200);
    const activatedPolicy = (await activatePolicy.json()) as {
      selectionVersion: number;
    };
    priceListId = createdPolicy.id;
    selectionVersion = activatedPolicy.selectionVersion;
    const termsRevision = await prisma.legalDocumentRevision.findFirstOrThrow({
      where: { revisionCode: e2eLegalRevisionCodes.terms },
      select: {
        contentVersion: true,
        title: true,
        summary: true,
        sections: true,
        contentHash: true,
      },
    });
    termsSnapshot = {
      contentVersion: termsRevision.contentVersion,
      title: termsRevision.title,
      summary: termsRevision.summary,
      sections: termsRevision.sections,
      contentHash: termsRevision.contentHash,
    };
    const claimsRevision = await prisma.legalDocumentRevision.findFirstOrThrow({
      where: { revisionCode: e2eLegalRevisionCodes.claims },
      select: {
        contentVersion: true,
        title: true,
        summary: true,
        sections: true,
        contentHash: true,
      },
    });
    claimsSnapshot = {
      contentVersion: claimsRevision.contentVersion,
      title: claimsRevision.title,
      summary: claimsRevision.summary,
      sections: claimsRevision.sections,
      contentHash: claimsRevision.contentHash,
    };
    defaultOfferItem = (
      await createModelOfferItem("default-offer-item", "NONE")
    ).item;
  });

  afterAll(async () => {
    await app?.close();
    if (initialTermsRevision === undefined) {
      delete process.env.TAVEN_TERMS_REVISION;
    } else {
      process.env.TAVEN_TERMS_REVISION = initialTermsRevision;
    }
  });

  it("fails closed before issuing or accepting a binding offer", async () => {
    const created = await quotes.createRequest(
      requestInput("launch-gate"),
      "198.51.100.38",
      key("launch-gate-create"),
    );
    const reviewed = await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("launch-gate-review"),
    );
    expect(reviewed.response.status).toBe(200);

    const configured = process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED;
    process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED = "false";
    try {
      const refused = await issueOffer(
        created.requestId,
        key("launch-gate-refused-issue"),
        new Date(Date.now() + 60 * 60 * 1_000),
      );
      expect(refused.response.status).toBe(503);
      expect(refused.body).toMatchObject({
        code: "LAUNCH_APPROVAL_REQUIRED",
      });
      expect(
        await prisma.quote.count({
          where: { quoteRequestId: created.requestId },
        }),
      ).toBe(0);
    } finally {
      process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED = configured ?? "true";
    }

    const issued = await issueOffer(
      created.requestId,
      key("launch-gate-enabled-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    expect(issued.response.status, JSON.stringify(issued.body)).toBe(201);

    for (const { name, acknowledgement } of [
      { name: "omitted", acknowledgement: undefined },
      { name: "false", acknowledgement: false },
      { name: "null", acknowledgement: null },
      { name: "string", acknowledgement: "true" },
      { name: "number", acknowledgement: 1 },
    ]) {
      const commandKey = key(`launch-gate-withdrawal-${name}`);
      const rejected = await apiJson(`offers/${issued.body.quoteId}/accept`, {
        method: "POST",
        headers: {
          ...bearer(issued.body.offerToken),
          "content-type": "application/json",
          "idempotency-key": commandKey,
        },
        body: JSON.stringify({
          version: issued.body.version,
          termsRevision: issued.body.termsRevision,
          ...(acknowledgement === undefined
            ? {}
            : { acknowledgeWithdrawalException: acknowledgement }),
        }),
      });
      expect(rejected.response.status).toBe(400);
      expect(
        await prisma.idempotencyRecord.count({
          where: {
            namespace: "quote-offer.accept",
            idempotencyKey: commandKey,
          },
        }),
      ).toBe(0);
    }
    expect(
      await prisma.individualOrderOrigin.count({
        where: { quoteId: issued.body.quoteId },
      }),
    ).toBe(0);

    const configuredTermsRevision = process.env.TAVEN_TERMS_REVISION;
    process.env.TAVEN_TERMS_REVISION = `${issued.body.termsRevision}-next`;
    try {
      const accepted = await apiJson(`offers/${issued.body.quoteId}/accept`, {
        method: "POST",
        headers: {
          ...bearer(issued.body.offerToken),
          "content-type": "application/json",
          "idempotency-key": key("launch-gate-stale-terms-accept"),
        },
        body: JSON.stringify({
          version: issued.body.version,
          termsRevision: issued.body.termsRevision,
          acknowledgeWithdrawalException: true,
        }),
      });
      expect(accepted.response.status).toBe(200);
    } finally {
      if (configuredTermsRevision === undefined) {
        delete process.env.TAVEN_TERMS_REVISION;
      } else {
        process.env.TAVEN_TERMS_REVISION = configuredTermsRevision;
      }
    }

    process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED = "false";
    try {
      const refused = await acceptOffer(
        issued.body,
        key("launch-gate-refused-accept"),
      );
      expect(refused.response.status).toBe(503);
      expect(refused.body).toMatchObject({
        code: "LAUNCH_APPROVAL_REQUIRED",
      });
      expect(
        await prisma.individualOrderOrigin.count({
          where: { quoteId: issued.body.quoteId },
        }),
      ).toBe(1);
    } finally {
      process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED = configured ?? "true";
    }
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

  it("declines a new request once without an offer and preserves its evidence", async () => {
    const created = await quotes.createRequest(
      requestInput("decline"),
      "198.51.100.175",
      key("decline-create"),
    );
    const requestId = created.requestId;
    const attachmentId = randomUUID();
    await prisma.photoAsset.create({
      data: {
        id: attachmentId,
        kind: "QUOTE_REFERENCE",
        scopeKind: "QUOTE_REQUEST",
        scopeId: requestId,
        storageObjectKey: photoOriginalObjectKey(attachmentId),
        contentHash: "e".repeat(64),
        mediaType: "image/jpeg",
        sizeBytes: 128,
        uploadedAt: new Date(),
        retentionDays: 90,
        photoDeleteAfter: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000),
      },
    });
    const path = `admin/quote-requests/${requestId}/decline`;
    const commandKey = key("decline-command");
    const body = {
      expectedStatus: "NEW" as const,
      reason: "Requested material is unavailable",
      reasonCode: "UNFULFILLABLE",
    };
    await expect(
      quotes.declineRequest(
        { ...operator, permissions: [] },
        requestId,
        body,
        key("decline-no-permission"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      quotes.declineRequest(
        { ...operator, nodeIds: [] },
        requestId,
        body,
        key("decline-no-node"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      prisma.quoteRequest.update({
        where: { id: requestId },
        data: {
          status: "REJECTED",
          rejectedAt: new Date(),
          slaRespondedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    const denied = await apiJson(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": commandKey,
      },
      body: JSON.stringify(body),
    });
    expect(denied.response.status).toBe(401);
    const malformed = await apiJson(path, {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "content-type": "application/json",
        "idempotency-key": key("decline-malformed"),
      },
      body: JSON.stringify({ ...body, reasonCode: "bad code" }),
    });
    expect(malformed.response.status).toBe(400);
    const missing = await apiJson(
      `admin/quote-requests/${randomUUID()}/decline`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": key("decline-missing"),
        },
        body: JSON.stringify(body),
      },
    );
    expect(missing.response.status).toBe(404);
    const declined = await apiJson<{ requestId: string; status: string }>(
      path,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": commandKey,
        },
        body: JSON.stringify(body),
      },
    );
    expect(declined.response.status).toBe(200);
    expect(declined.body).toEqual({ requestId, status: "REJECTED" });
    const replay = await apiJson(path, {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "content-type": "application/json",
        "idempotency-key": commandKey,
      },
      body: JSON.stringify(body),
    });
    expect(replay.response.status).toBe(200);
    const changed = await apiJson(path, {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "content-type": "application/json",
        "idempotency-key": commandKey,
      },
      body: JSON.stringify({ ...body, reasonCode: "OTHER" }),
    });
    expect(changed.response.status).toBe(409);

    const [request, audit, legal, attachments, quoteCount, orderCount] =
      await Promise.all([
        prisma.quoteRequest.findUniqueOrThrow({ where: { id: requestId } }),
        prisma.auditEvent.findMany({
          where: {
            quoteRequestId: requestId,
            eventType: "quote_request.declined",
          },
        }),
        prisma.legalAcceptance.findMany({
          where: { quoteRequestId: requestId },
        }),
        prisma.photoAsset.findUniqueOrThrow({ where: { id: attachmentId } }),
        prisma.quote.count({ where: { quoteRequestId: requestId } }),
        prisma.individualOrderOrigin.count({
          where: { quote: { quoteRequestId: requestId } },
        }),
      ]);
    expect(request.currentQuoteId).toBeNull();
    expect(request.rejectedAt).toEqual(request.slaRespondedAt);
    expect(request.rejectionReason).toBe(body.reason);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      reasonCode: body.reasonCode,
      reason: body.reason,
      payload: { operation: "decline", status: "REJECTED" },
    });
    const auditRead = await apiJson<{
      items: Array<{ reason: string; reasonCode: string; payload: unknown }>;
    }>(
      `admin/audit-events?quoteRequestId=${requestId}&eventType=quote_request.declined`,
      {
        headers: operatorHeaders(false),
      },
    );
    expect(auditRead.response.status).toBe(200);
    expect(auditRead.body.items).toEqual([
      expect.objectContaining({
        reason: body.reason,
        reasonCode: body.reasonCode,
        payload: { operation: "decline", status: "REJECTED" },
      }),
    ]);
    expect(legal.length).toBeGreaterThan(0);
    expect(attachments.scopeId).toBe(requestId);
    expect(quoteCount).toBe(0);
    expect(orderCount).toBe(0);
    expect(
      (
        await operatorCommand(
          `admin/quote-requests/${requestId}/review`,
          key("decline-review"),
        )
      ).response.status,
    ).toBe(409);
    await expect(
      prisma.quoteRequest.update({
        where: { id: requestId },
        data: { rejectionReason: "Changed after decline" },
      }),
    ).rejects.toThrow();
  });

  it("serializes review against a stale pre-offer decline", async () => {
    const created = await quotes.createRequest(
      requestInput("decline-race"),
      "198.51.100.176",
      key("decline-race-create"),
    );
    const requestId = created.requestId;
    const outcomes = await Promise.allSettled([
      quotes.beginReview(operator, requestId, key("decline-race-review")),
      quotes.declineRequest(
        operator,
        requestId,
        {
          expectedStatus: "NEW",
          reason: "Cannot produce this part",
          reasonCode: "UNFULFILLABLE",
        },
        key("decline-race-decline"),
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    expect((loser as PromiseRejectedResult).reason.getStatus()).toBe(409);
    const request = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(request.status).toBe(
      outcomes[0]?.status === "fulfilled" ? "IN_REVIEW" : "REJECTED",
    );
  });

  it("accepts a decline reason up to 1000 Unicode code points", async () => {
    const created = await quotes.createRequest(
      requestInput("decline-unicode"),
      "198.51.100.178",
      key("decline-unicode-create"),
    );
    const reason = "🙂".repeat(501);
    const declined = await quotes.declineRequest(
      operator,
      created.requestId,
      { expectedStatus: "NEW", reason, reasonCode: "UNFULFILLABLE" },
      key("decline-unicode-command"),
    );
    expect(declined.status).toBe("REJECTED");
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: {
        quoteRequestId: created.requestId,
        eventType: "quote_request.declined",
      },
    });
    expect(audit.reason).toBe(reason);
    expect(audit.reasonCode).toBe("UNFULFILLABLE");
  });

  it("gives offer issuance and decline one legal winner", async () => {
    const created = await quotes.createRequest(
      requestInput("decline-issue-race"),
      "198.51.100.177",
      key("decline-issue-race-create"),
    );
    const requestId = created.requestId;
    await quotes.beginReview(
      operator,
      requestId,
      key("decline-issue-race-review"),
    );
    const items = await prepareOfferItems(requestId, defaultItems());
    const offer = offerInput(
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      items,
    ) as unknown as IssueOfferDto;
    const outcomes = await Promise.allSettled([
      quotes.issueOffer(operator, requestId, offer, key("decline-race-issue")),
      quotes.declineRequest(
        operator,
        requestId,
        {
          expectedStatus: "IN_REVIEW",
          reason: "Cannot complete the requested work",
          reasonCode: "UNFULFILLABLE",
        },
        key("decline-race-after-review"),
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    expect((loser as PromiseRejectedResult).reason.getStatus()).toBe(409);
    const request = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(request.status).toBe(
      outcomes[0]?.status === "fulfilled" ? "QUOTED" : "REJECTED",
    );
    expect(
      await prisma.quote.count({ where: { quoteRequestId: requestId } }),
    ).toBe(request.status === "QUOTED" ? 1 : 0);
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
      { method: "POST", headers: operatorHeaders(true) },
    );
    expect(crossRequestOperatorAttachment.response.status).toBe(404);

    const operatorAttachment = await apiJson<{
      downloadUrl: string;
      expiresAt: string;
    }>(
      `admin/quote-requests/${created.body.requestId.toUpperCase()}/attachments/${referencePhotoId.toUpperCase()}/download`,
      { method: "POST", headers: operatorHeaders(true) },
    );
    expect(operatorAttachment.response.status).toBe(200);
    expect(new URL(operatorAttachment.body.downloadUrl).protocol).toMatch(
      /^https?:$/,
    );
    expect(
      new Date(operatorAttachment.body.expiresAt).getTime(),
    ).toBeGreaterThan(Date.now());

    const reviewKey = key("review");
    const reviewed = await operatorCommand(
      `admin/quote-requests/${created.body.requestId}/review`,
      reviewKey,
    );
    expect(reviewed.response.status).toBe(200);
    expect(reviewed.body.status).toBe("IN_REVIEW");
    const [reviewAudit, reviewedRequest] = await Promise.all([
      prisma.auditEvent.findFirstOrThrow({
        where: {
          eventType: "quote_request.review_started",
          idempotencyKey: reviewKey,
        },
      }),
      prisma.quoteRequest.findUniqueOrThrow({
        where: { id: created.body.requestId },
      }),
    ]);
    expect(reviewAudit.createdAt.getTime()).toBe(
      reviewedRequest.updatedAt.getTime(),
    );

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
    const issuedAudit = await prisma.auditEvent.findFirstOrThrow({
      where: {
        eventType: "quote_offer.issued",
        idempotencyKey: issueKey,
      },
    });
    expect(issuedAudit).toMatchObject({ quoteId: issued.body.quoteId });
    const issuedQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: issued.body.quoteId },
    });
    expect(issuedAudit.createdAt.getTime()).toBe(
      issuedQuote.issuedAt.getTime(),
    );

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
      claimPolicyRevision: string;
      claimsSnapshot: Record<string, unknown>;
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
      claimPolicyRevision: e2eLegalRevisionCodes.claims,
      contractTotalMinor: 110_000,
      taxRegime: "NON_VAT_PAYER",
      vatRateBasisPoints: 0,
      netAmountMinor: 110_000,
      vatAmountMinor: 0,
    });
    expect(preview.body.claimsSnapshot).toEqual(claimsSnapshot);
    expect(preview.body.items).toEqual([
      expect.objectContaining({
        ordinal: 0,
        ...defaultOfferItem,
        modelSelectionId: expect.any(String),
        tailReferenceSliceResultId: null,
        color: null,
      }),
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

    const statusBeforeContact = await apiJson<{
      orderId: string;
      preparationStatus: string;
      initialPayment: unknown;
    }>(`offers/${issued.body.quoteId}/order-status`, {
      headers: bearer(issued.body.offerToken),
    });
    expect(statusBeforeContact.response.status).toBe(200);
    expect(statusBeforeContact.body).toMatchObject({
      orderId: accepted.body.orderId,
      preparationStatus: "UNPREPARED",
      initialPayment: null,
    });
    expect(statusBeforeContact.body).not.toHaveProperty("contact");
    const foreignStatus = await apiJson(
      `offers/${issued.body.quoteId}/order-status`,
      { headers: bearer(randomBytes(32).toString("base64url")) },
    );
    expect(foreignStatus.response.status).toBe(401);

    const contact = {
      email: requestBody.contact.email,
      fullName: "Accepted Customer",
      billing: {
        name: "Accepted Customer",
        addressLine1: "Masarykova 12",
        city: "Brno",
        postalCode: "60200",
        countryCode: "CZ",
      },
    };
    const contactKey = key("accepted-checkout-contact");
    const recordContact = (body: typeof contact, commandKey: string) =>
      apiJson(`offers/${issued.body.quoteId}/checkout-contact`, {
        method: "POST",
        headers: {
          ...bearer(issued.body.offerToken),
          "content-type": "application/json",
          "idempotency-key": commandKey,
        },
        body: JSON.stringify(body),
      });
    const wrongEmail = await recordContact(
      { ...contact, email: "foreign@example.test" },
      key("foreign-checkout-contact"),
    );
    expect(wrongEmail.response.status).toBe(409);
    const recordedContact = await recordContact(contact, contactKey);
    expect(recordedContact.response.status).toBe(200);
    expect(recordedContact.body).toEqual({
      orderId: accepted.body.orderId,
      contactRecorded: true,
    });
    expect((await recordContact(contact, contactKey)).body).toEqual(
      recordedContact.body,
    );
    const changedContact = await recordContact(
      { ...contact, billing: { ...contact.billing, city: "Praha" } },
      key("changed-checkout-contact"),
    );
    expect(changedContact.response.status).toBe(409);
    const frozenContact = await prisma.order.findUniqueOrThrow({
      where: { id: accepted.body.orderId },
      select: { checkoutContactSnapshot: true },
    });
    expect(frozenContact.checkoutContactSnapshot).toEqual({
      version: 2,
      ...contact,
    });
    const dispatchCandidates = vi.spyOn(
      app.get(AutomaticQuotesService),
      "dispatchOrderCandidates",
    );
    dispatchCandidates.mockResolvedValueOnce(undefined);
    try {
      const noCandidatePreparation = await apiJson<{ status: string }>(
        `admin/orders/${accepted.body.orderId}/resource-preparation`,
        {
          method: "POST",
          headers: {
            ...operatorHeaders(true),
            "content-type": "application/json",
            "idempotency-key": key(
              "accepted-resource-preparation-no-candidate",
            ),
          },
          body: JSON.stringify({ reason: "Check candidate availability" }),
        },
      );
      expect(noCandidatePreparation.response.status).toBe(200);
      expect(noCandidatePreparation.body.status).toBe("PENDING");
      const unavailableStatus = await apiJson<{ preparationStatus: string }>(
        `offers/${issued.body.quoteId}/order-status`,
        { headers: bearer(issued.body.offerToken) },
      );
      expect(unavailableStatus.body.preparationStatus).toBe("UNAVAILABLE");
    } finally {
      dispatchCandidates.mockRestore();
    }
    const prepareResources = await apiJson<{
      status: string;
      phaseResourcePlanId: string | null;
    }>(`admin/orders/${accepted.body.orderId}/resource-preparation`, {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "content-type": "application/json",
        "idempotency-key": "p".repeat(255),
      },
      body: JSON.stringify({ reason: "Prepare accepted offer resources" }),
    });
    expect(
      prepareResources.response.status,
      JSON.stringify(prepareResources.body),
    ).toBe(200);
    expect(prepareResources.body.status).toBe("PENDING");
    expect(prepareResources.body.phaseResourcePlanId).toBeNull();
    const dispatch = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        aggregateType: "CandidateEstimateDispatch",
        payload: {
          path: ["job", "correlationId"],
          equals: accepted.body.orderId,
        },
      },
    });
    const candidateJob = (dispatch.payload as { job: CandidateEstimateJob })
      .job;
    expect(candidateJob.input.geometry).toMatchObject({
      sourceModelFileId: defaultOfferItem.sourceModelFileId,
      modelGeometryId: defaultOfferItem.modelGeometryId,
      bodyIds: ["quote-test-body"],
      selectionSha256: (
        await import("@taven/slicer-contracts")
      ).geometrySelectionSha256(["quote-test-body"]),
    });
    const availability =
      await prisma.machineAvailabilitySelection.findFirstOrThrow({
        where: { machineId: candidateJob.input.machineId },
        include: { revision: { include: { windows: true } } },
      });
    const available = availability.revision.windows.find(
      (window) => window.endsAt.getTime() > Date.now() + 15 * 60_000,
    );
    expect(available).toBeDefined();
    const startsAt = new Date(
      Math.max(Date.now() + 5 * 60_000, available!.startsAt.getTime() + 60_000),
    );
    await candidates.ingest({
      result: successfulIndividualCandidateResult(candidateJob),
      capacityWindows: [
        { startsAt, endsAt: new Date(startsAt.getTime() + 60_000) },
      ],
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const shortPlanSpy = vi.spyOn(eligibilityPlans, "createCompletePlan");
    shortPlanSpy.mockResolvedValueOnce({
      eligibilitySnapshotId: randomUUID(),
      phaseResourcePlanId: randomUUID(),
      planKey: "short-lived-test-plan",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      candidateResourceEstimateIds: [],
    });
    try {
      const shortPreparation = await apiJson<{ status: string }>(
        `admin/orders/${accepted.body.orderId}/resource-preparation`,
        {
          method: "POST",
          headers: {
            ...operatorHeaders(true),
            "content-type": "application/json",
            "idempotency-key": key("accepted-resource-preparation-short"),
          },
          body: JSON.stringify({ reason: "Check short resource plan" }),
        },
      );
      expect(shortPreparation.response.status).toBe(200);
      expect(shortPreparation.body.status).toBe("PENDING");
      expect(
        await prisma.order.findUniqueOrThrow({
          where: { id: accepted.body.orderId },
          select: { status: true },
        }),
      ).toEqual({ status: "DRAFT" });
    } finally {
      shortPlanSpy.mockRestore();
    }
    const completedPreparation = await apiJson<{
      status: string;
      phaseResourcePlanId: string | null;
    }>(`admin/orders/${accepted.body.orderId}/resource-preparation`, {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "content-type": "application/json",
        "idempotency-key": key("accepted-resource-preparation-complete"),
      },
      body: JSON.stringify({ reason: "Complete accepted resource plan" }),
    });
    expect(
      completedPreparation.response.status,
      JSON.stringify(completedPreparation.body),
    ).toBe(200);
    expect(completedPreparation.body.status).toBe("READY");
    expect(completedPreparation.body.phaseResourcePlanId).toBeTruthy();
    const readPreparationStatus = () =>
      apiJson<{ preparationStatus: string }>(
        `offers/${issued.body.quoteId}/order-status`,
        { headers: bearer(issued.body.offerToken) },
      );
    expect((await readPreparationStatus()).body.preparationStatus).toBe(
      "READY",
    );
    const otherNode = await prisma.node.create({
      data: {
        code: `foreign-${randomUUID()}`.slice(0, 50),
        name: "Foreign preparation node",
        timeZone: "Europe/Prague",
      },
    });
    const acceptedPhase = await prisma.orderPhase.findFirstOrThrow({
      where: { orderId: accepted.body.orderId },
      select: { id: true },
    });
    await expect(
      eligibilityPlans.createCompletePlan({
        nodeId: otherNode.id,
        orderPhaseId: acceptedPhase.id,
        planKey: `foreign-individual:${randomUUID()}`,
        exclusiveOrderNode: true,
      }),
    ).rejects.toMatchObject({
      constraint: "individual_order_node_scope",
    });
    expect(
      await prisma.phaseResourcePlan.count({
        where: { orderPhaseId: acceptedPhase.id, nodeId: otherNode.id },
      }),
    ).toBe(0);
    const originalPlanId = completedPreparation.body.phaseResourcePlanId!;
    const originalPlan = await prisma.phaseResourcePlan.findUniqueOrThrow({
      where: { id: originalPlanId },
    });
    const terminalPlan = await eligibilityPlans.createCompletePlan({
      nodeId: originalPlan.nodeId,
      orderPhaseId: acceptedPhase.id,
      planKey: `individual-terminal-reservation:${randomUUID()}`,
      exclusiveOrderNode: true,
    });
    const reservationService = app.get(ResourceReservationService);
    const terminalReservation = await reservationService.reserve({
      nodeId: originalPlan.nodeId,
      phaseResourcePlanId: terminalPlan.phaseResourcePlanId,
      reservationKey: `individual-initial:${accepted.body.orderId}:${terminalPlan.phaseResourcePlanId}`,
    });
    expect(terminalReservation.status).toBe("RESERVED");
    expect(
      await reservationService.releaseBeforePrint(
        terminalReservation.phaseReservationSetId,
      ),
    ).toBe(true);
    expect(
      await prisma.phaseResourcePlan.findFirst({
        where: { orderPhaseId: acceptedPhase.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      }),
    ).toEqual({ id: terminalPlan.phaseResourcePlanId });
    const statusPlans = vi.spyOn(prisma.phaseResourcePlan, "findMany");
    try {
      expect((await readPreparationStatus()).body.preparationStatus).toBe(
        "READY",
      );
      expect(statusPlans).toHaveBeenCalledWith({
        where: {
          eligibilitySnapshot: {
            orderPhase: { orderId: accepted.body.orderId },
          },
          reservationSets: { none: {} },
        },
        select: { expiresAt: true },
      });
      statusPlans.mockResolvedValueOnce([
        { expiresAt: new Date(Date.now() + 10 * 60_000) },
      ] as never);
      expect((await readPreparationStatus()).body.preparationStatus).toBe(
        "UNAVAILABLE",
      );
    } finally {
      statusPlans.mockRestore();
    }
    const initialKey = key("accepted-individual-initial-payment");
    const createInitialPayment = (
      method: "CARD" | "BANK_TRANSFER",
      commandKey: string,
    ) =>
      apiJson<{
        paymentId: string;
        status: string;
        amountMinor: number;
        checkoutUrl: string | null;
      }>(`admin/orders/${accepted.body.orderId}/initial-payment`, {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": commandKey,
        },
        body: JSON.stringify({ method }),
      });
    const reserveSpy = vi.spyOn(reservationService, "reserveInTransaction");
    reserveSpy.mockRejectedValueOnce(
      new ResourceConflictError(
        "reservation conflicts with the current resource state",
        "capacity_reservations_no_active_overlap",
      ),
    );
    const staleResource = await createInitialPayment(
      "CARD",
      key("accepted-initial-stale-reservation"),
    );
    reserveSpy.mockRestore();
    expect(staleResource.response.status).toBe(409);
    expect(
      await prisma.payment.count({ where: { orderId: accepted.body.orderId } }),
    ).toBe(0);
    const initialPayment = await createInitialPayment("CARD", initialKey);
    expect(
      initialPayment.response.status,
      JSON.stringify(initialPayment.body),
    ).toBe(200);
    expect(initialPayment.body).toMatchObject({
      status: "PENDING",
      amountMinor: 33_000,
    });
    expect(initialPayment.body.checkoutUrl).toBeTruthy();
    expect(
      await prisma.phaseReservationSet.findFirst({
        where: { phaseResourcePlanId: originalPlanId, status: "RESERVED" },
        select: { reservationKey: true },
      }),
    ).toEqual({
      reservationKey: `individual-initial:${accepted.body.orderId}:${originalPlanId}`,
    });
    expect((await createInitialPayment("CARD", initialKey)).body).toEqual(
      initialPayment.body,
    );
    const concurrentKeys = [
      key("accepted-initial-concurrent-a"),
      key("accepted-initial-concurrent-b"),
    ];
    const concurrentInitialAttempts = await Promise.all(
      concurrentKeys.map((commandKey) =>
        createInitialPayment("CARD", commandKey),
      ),
    );
    expect(
      concurrentInitialAttempts.map((attempt) => attempt.response.status),
    ).toEqual([200, 200]);
    expect(
      concurrentInitialAttempts.map((attempt) => attempt.body.paymentId),
    ).toEqual([initialPayment.body.paymentId, initialPayment.body.paymentId]);
    for (const commandKey of concurrentKeys) {
      const replayRecord = await prisma.idempotencyRecord.findFirstOrThrow({
        where: {
          namespace: `individual-initial-payment:${accepted.body.orderId}`,
          idempotencyKey: commandKey,
        },
      });
      expect(replayRecord.status).toBe("COMPLETED");
      expect(replayRecord.responseBody).toMatchObject({
        paymentId: initialPayment.body.paymentId,
      });
    }
    expect(
      (
        await createInitialPayment(
          "BANK_TRANSFER",
          key("changed-initial-method"),
        )
      ).response.status,
    ).toBe(409);
    const scopedPaymentStatus = await apiJson<{
      initialPayment: {
        paymentId: string;
        status: string;
        checkoutUrl: string | null;
      };
    }>(`offers/${issued.body.quoteId}/order-status`, {
      headers: bearer(issued.body.offerToken),
    });
    expect(scopedPaymentStatus.body.initialPayment).toMatchObject({
      paymentId: initialPayment.body.paymentId,
      status: "PENDING",
      checkoutUrl: initialPayment.body.checkoutUrl,
    });
    expect(
      (
        await apiJson(`offers/${issued.body.quoteId}/order-status`, {
          headers: bearer("unrelated-offer-capability"),
        })
      ).response.status,
    ).toBe(401);
    const sandboxUrl = new URL(initialPayment.body.checkoutUrl!);
    const sandboxCapture = await fetch(
      new URL(`${sandboxUrl.pathname}/capture`, baseUrl),
      {
        method: "POST",
        redirect: "manual",
      },
    );
    expect(sandboxCapture.status, await sandboxCapture.text()).toBe(200);
    const capturedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: initialPayment.body.paymentId },
    });
    expect(capturedPayment.status).toBe("CAPTURED");
    expect(
      (await createInitialPayment("CARD", concurrentKeys[0]!)).body,
    ).toEqual(concurrentInitialAttempts[0]!.body);
    const productionJob = await prisma.job.findFirstOrThrow({
      where: { orderId: accepted.body.orderId },
      select: { id: true, status: true },
    });
    expect(productionJob.status).toBe("CREATED");
    const jobAccepted = await apiJson<{ code: string }>(
      `admin/orders/${accepted.body.orderId}/fulfilment/jobs/${productionJob.id}/accept`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "idempotency-key": key("accepted-individual-job"),
        },
      },
    );
    expect(jobAccepted.response.status, JSON.stringify(jobAccepted.body)).toBe(
      200,
    );
    const productionDispatch = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        aggregateType: "ProductionSliceDispatch",
        aggregateId: productionJob.id,
      },
    });
    const { ProductionSliceJobSchema } =
      await import("@taven/slicer-contracts");
    const productionInput = ProductionSliceJobSchema.parse(
      (productionDispatch.payload as { job: unknown }).job,
    );
    expect(productionInput.input.geometry.bodyIds).toEqual(
      candidateJob.input.geometry.bodyIds,
    );
    expect(productionInput.input.geometry.selectionSha256).toBe(
      candidateJob.input.geometry.selectionSha256,
    );
    expect(productionInput.input.productionReservationId).toBeTruthy();
    const preparationStatus = await apiJson<{ preparationStatus: string }>(
      `offers/${issued.body.quoteId}/order-status`,
      { headers: bearer(issued.body.offerToken) },
    );
    expect(preparationStatus.body.preparationStatus).toBe("ACTIVATED");
    const phaseStatusSpy = vi.spyOn(prisma.orderPhase, "findUnique");
    try {
      for (const status of ["CANCELLED", "RECOVERY_PENDING"] as const) {
        phaseStatusSpy.mockResolvedValueOnce({ status } as never);
        const terminalStatus = await apiJson<{ preparationStatus: string }>(
          `offers/${issued.body.quoteId}/order-status`,
          { headers: bearer(issued.body.offerToken) },
        );
        expect(terminalStatus.body.preparationStatus).toBe("UNAVAILABLE");
      }
    } finally {
      phaseStatusSpy.mockRestore();
    }

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
    ).toBe(1);
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
      { headers: operatorHeaders(false) },
    );
    expect(defaultQueue.response.status).toBe(200);
    expect(defaultQueue.body).not.toContainEqual(
      expect.objectContaining({ requestId: created.body.requestId }),
    );

    const acceptedHistory = await apiJson<
      Array<{
        requestId: string;
        status: string;
        acceptedOrderId: string | null;
      }>
    >("admin/quote-requests?status=ACCEPTED", {
      headers: operatorHeaders(false),
    });
    expect(acceptedHistory.response.status).toBe(200);
    expect(acceptedHistory.body).toContainEqual(
      expect.objectContaining({
        requestId: created.body.requestId,
        status: "ACCEPTED",
        acceptedOrderId: accepted.body.orderId,
      }),
    );
    const acceptedPage = await apiJson<{
      items: Array<{ requestId: string; acceptedOrderId: string | null }>;
    }>("admin/quote-requests/page?status=ACCEPTED&limit=100", {
      headers: operatorHeaders(false),
    });
    expect(acceptedPage.response.status).toBe(200);
    expect(acceptedPage.body.items).toContainEqual(
      expect.objectContaining({
        requestId: created.body.requestId,
        acceptedOrderId: accepted.body.orderId,
      }),
    );
  }, 30_000);

  it("dispatches each reserved individual job with its assigned body selection", async () => {
    const requestBody = requestInput("two-selections");
    const created = await createRequest(
      key("two-selections-create"),
      requestBody,
    );
    expect(created.response.status).toBe(201);
    expect(
      (
        await operatorCommand(
          `admin/quote-requests/${created.body.requestId}/review`,
          key("two-selections-review"),
        )
      ).response.status,
    ).toBe(200);
    const [firstItem] = await prepareOfferItems(created.body.requestId, [
      defaultOfferItem,
    ]);
    const firstSelectionId = firstItem!.modelSelectionId as string;
    const firstSelection =
      await prisma.quoteRequestModelSelection.findUniqueOrThrow({
        where: { id: firstSelectionId },
      });
    const secondBodyIds = ["quote-other-body"];
    const { geometrySelectionSha256, ProductionSliceJobSchema } =
      await import("@taven/slicer-contracts");
    const secondSelection = await prisma.quoteRequestModelSelection.create({
      data: {
        requestId: firstSelection.requestId,
        modelFileId: firstSelection.modelFileId,
        modelGeometryId: firstSelection.modelGeometryId,
        inspectionJobId: firstSelection.inspectionJobId,
        sourceContentSha256: firstSelection.sourceContentSha256,
        bodyIds: secondBodyIds,
        selectionSha256: geometrySelectionSha256(secondBodyIds),
      },
    });
    const items = [
      { ...defaultOfferItem, modelSelectionId: firstSelection.id },
      { ...defaultOfferItem, modelSelectionId: secondSelection.id },
    ];
    const components = [0, 1].flatMap((quoteItemOrdinal) => [
      { kind: "ITEM_PRODUCTION", quoteItemOrdinal, amountMinor: 40_000 },
      { kind: "ITEM_QUANTITY", quoteItemOrdinal, amountMinor: 10_000 },
      { kind: "ITEM_POSTPROCESSING", quoteItemOrdinal, amountMinor: 5_000 },
    ]);
    const issued = await issueOffer(
      created.body.requestId,
      key("two-selections-issue"),
      new Date(Date.now() + 60 * 60_000),
      components,
      items,
    );
    expect(issued.response.status, JSON.stringify(issued.body)).toBe(201);
    const accepted = await acceptOffer(
      issued.body,
      key("two-selections-accept"),
    );
    expect(accepted.response.status, JSON.stringify(accepted.body)).toBe(200);
    const contact = await apiJson(
      `offers/${issued.body.quoteId}/checkout-contact`,
      {
        method: "POST",
        headers: {
          ...bearer(issued.body.offerToken),
          "content-type": "application/json",
          "idempotency-key": key("two-selections-contact"),
        },
        body: JSON.stringify({
          email: requestBody.contact.email,
          fullName: "Two Selection Customer",
          billing: {
            name: "Two Selection Customer",
            addressLine1: "Masarykova 12",
            city: "Brno",
            postalCode: "60200",
            countryCode: "CZ",
          },
        }),
      },
    );
    expect(contact.response.status, JSON.stringify(contact.body)).toBe(200);
    const prepare = (commandKey: string) =>
      apiJson<{ status: string }>(
        `admin/orders/${accepted.body.orderId}/resource-preparation`,
        {
          method: "POST",
          headers: {
            ...operatorHeaders(true),
            "content-type": "application/json",
            "idempotency-key": commandKey,
          },
          body: JSON.stringify({ reason: "Prepare both selected items" }),
        },
      );
    expect((await prepare(key("two-selections-dispatch"))).body.status).toBe(
      "PENDING",
    );
    const dispatches = await prisma.outboxMessage.findMany({
      where: {
        aggregateType: "CandidateEstimateDispatch",
        payload: {
          path: ["job", "correlationId"],
          equals: accepted.body.orderId,
        },
      },
    });
    const bySelection = new Map<string, CandidateEstimateJob>();
    for (const dispatch of dispatches) {
      const job = (dispatch.payload as { job: CandidateEstimateJob }).job;
      bySelection.set(job.input.geometry.selectionSha256, job);
    }
    expect([...bySelection.keys()].sort()).toEqual(
      [firstSelection.selectionSha256, secondSelection.selectionSha256].sort(),
    );
    const acceptedBinding = await prisma.order.findUniqueOrThrow({
      where: { id: accepted.body.orderId },
      select: { acceptedOrderPriceBindingId: true },
    });
    const candidateFrontier = vi.spyOn(
      app.get(AutomaticQuotesService),
      "hasUnavailableCandidateRequirement",
    );
    candidateFrontier.mockResolvedValueOnce(true);
    try {
      const status = await apiJson<{ preparationStatus: string }>(
        `offers/${issued.body.quoteId}/order-status`,
        { headers: bearer(issued.body.offerToken) },
      );
      expect(status.body.preparationStatus).toBe("UNAVAILABLE");
      expect(candidateFrontier).toHaveBeenCalledWith(
        acceptedBinding.acceptedOrderPriceBindingId,
        expect.any(Date),
      );
    } finally {
      candidateFrontier.mockRestore();
    }
    let offsetMinutes = 20;
    for (const job of bySelection.values()) {
      const availability =
        await prisma.machineAvailabilitySelection.findFirstOrThrow({
          where: { machineId: job.input.machineId },
          include: { revision: { include: { windows: true } } },
        });
      const available = availability.revision.windows.find(
        (window) => window.endsAt.getTime() > Date.now() + 40 * 60_000,
      );
      expect(available).toBeDefined();
      const startsAt = new Date(
        Math.max(
          Date.now() + offsetMinutes * 60_000,
          available!.startsAt.getTime() + offsetMinutes * 60_000,
        ),
      );
      offsetMinutes += 5;
      await candidates.ingest({
        result: successfulIndividualCandidateResult(job),
        capacityWindows: [
          { startsAt, endsAt: new Date(startsAt.getTime() + 60_000) },
        ],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
    }
    const completed = await prepare(key("two-selections-plan"));
    expect(completed.response.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.status).toBe("READY");
    const payment = await apiJson<{ checkoutUrl: string; status: string }>(
      `admin/orders/${accepted.body.orderId}/initial-payment`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": key("two-selections-payment"),
        },
        body: JSON.stringify({ method: "CARD" }),
      },
    );
    expect(payment.response.status, JSON.stringify(payment.body)).toBe(200);
    const sandboxPath = new URL(payment.body.checkoutUrl).pathname;
    expect(
      (
        await fetch(new URL(`${sandboxPath}/capture`, baseUrl), {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    const jobs = await prisma.job.findMany({
      where: { orderId: accepted.body.orderId },
      orderBy: { id: "asc" },
    });
    expect(jobs).toHaveLength(2);
    const productionSelections: string[] = [];
    for (const job of jobs) {
      const acceptedJob = await apiJson(
        `admin/orders/${accepted.body.orderId}/fulfilment/jobs/${job.id}/accept`,
        {
          method: "POST",
          headers: {
            ...operatorHeaders(true),
            "idempotency-key": key(`two-selections-job-${job.id}`),
          },
        },
      );
      expect(
        acceptedJob.response.status,
        JSON.stringify(acceptedJob.body),
      ).toBe(200);
      const dispatch = await prisma.outboxMessage.findFirstOrThrow({
        where: {
          aggregateType: "ProductionSliceDispatch",
          aggregateId: job.id,
        },
      });
      const queued = ProductionSliceJobSchema.parse(
        (dispatch.payload as { job: unknown }).job,
      );
      productionSelections.push(queued.input.geometry.selectionSha256);
    }
    expect(productionSelections.sort()).toEqual(
      [firstSelection.selectionSha256, secondSelection.selectionSha256].sort(),
    );
  }, 30_000);

  it("issues and previews an immutable VAT-payer price split", async () => {
    const created = await quotes.createRequest(
      requestInput("vat-payer-offer"),
      "198.51.100.81",
      key("vat-payer-offer-create"),
    );
    await quotes.beginReview(
      operator,
      created.requestId,
      key("vat-payer-offer-review"),
    );
    const previousPolicyId = priceListId;
    const previousPolicy = await prisma.priceList.findUniqueOrThrow({
      where: { id: previousPolicyId },
    });
    const vatPolicyId = await publishTestPriceList(
      {
        ...(previousPolicy.parameters as Record<string, unknown>),
        sellerTaxPolicy: { regime: "VAT_PAYER", vatRateBasisPoints: 2_100 },
        balance_payment_days: 7,
        balance_timeout_earned_component_kinds: [
          "ITEM_PRODUCTION",
          "ITEM_QUANTITY",
          "ITEM_POSTPROCESSING",
          "VAT",
        ],
      },
      previousPolicy.termsRevision,
    );
    const issued = await issueOffer(
      created.requestId,
      key("vat-payer-offer-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      defaultItems(),
      vatPolicyId,
      {
        contractTotalMinor: 133_100,
        depositMinor: 39_930,
        taxRegime: "VAT_PAYER",
        vatRateBasisPoints: 2_100,
        netAmountMinor: 110_000,
        vatAmountMinor: 23_100,
      },
    );
    expect(issued.response.status).toBe(201);

    const preview = await apiJson<{
      contractTotalMinor: number;
      taxRegime: string;
      vatRateBasisPoints: number;
      netAmountMinor: number;
      vatAmountMinor: number;
      components: Array<{ kind: string; amountMinor: number }>;
    }>(`offers/${issued.body.quoteId}`, {
      headers: bearer(issued.body.offerToken),
    });
    expect(preview.body).toMatchObject({
      contractTotalMinor: 133_100,
      taxRegime: "VAT_PAYER",
      vatRateBasisPoints: 2_100,
      netAmountMinor: 110_000,
      vatAmountMinor: 23_100,
    });
    expect(
      preview.body.components.find((component) => component.kind === "VAT"),
    ).toEqual({
      kind: "VAT",
      scope: "ORDER",
      quoteItemOrdinal: null,
      shipmentPlanOrdinal: null,
      amountMinor: 23_100,
      allocation: null,
    });

    const snapshot = await prisma.priceSnapshot.findFirstOrThrow({
      where: { quoteBinding: { quoteId: issued.body.quoteId } },
    });
    expect(snapshot).toMatchObject({
      contractTotalMinor: 133_100n,
      taxRegime: "VAT_PAYER",
      vatRateBasisPoints: 2_100,
      netAmountMinor: 110_000n,
      vatAmountMinor: 23_100n,
    });
    await expect(
      prisma.priceSnapshot.update({
        where: { id: snapshot.id },
        data: { vatAmountMinor: 0n },
      }),
    ).rejects.toBeDefined();

    const accepted = await acceptOffer(
      issued.body,
      key("vat-payer-offer-accept"),
    );
    expect(accepted.response.status).toBe(200);
    await activateTestPriceList(previousPolicyId);
  });

  it("reissues an active offer without changing its numerical provenance", async () => {
    const created = await quotes.createRequest(
      requestInput("reissue-provenance"),
      "198.51.100.90",
      key("reissue-provenance-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("reissue-provenance-review"),
    );
    const initialExpiry = new Date(Date.now() + 60 * 60 * 1_000);
    const initialIssueKey = key("reissue-provenance-issue");
    const initial = await issueOffer(
      created.requestId,
      initialIssueKey,
      initialExpiry,
    );
    expect(initial.response.status, JSON.stringify(initial.body)).toBe(201);
    const initialSnapshot = await prisma.quote.findUniqueOrThrow({
      where: { id: initial.body.quoteId },
      include: {
        priceBinding: { include: { priceSnapshot: true } },
        items: { orderBy: { ordinal: "asc" } },
      },
    });

    const reissueKey = key("reissue-provenance-command");
    const reissueExpiry = new Date(Date.now() + 2 * 60 * 60 * 1_000);
    const reissued = await reissueOffer(
      created.requestId,
      reissueKey,
      initial.body.quoteId,
      initial.body.version,
      reissueExpiry,
    );
    expect(reissued.response.status, JSON.stringify(reissued.body)).toBe(201);
    expect(reissued.body).toMatchObject({ version: 2 });
    expect(reissued.body.quoteId).not.toBe(initial.body.quoteId);
    expect(reissued.body.offerToken).not.toBe(initial.body.offerToken);

    const replay = await reissueOffer(
      created.requestId,
      reissueKey,
      initial.body.quoteId,
      initial.body.version,
      reissueExpiry,
    );
    expect(replay.response.status).toBe(201);
    expect(replay.body).toEqual(reissued.body);

    const current = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: created.requestId },
      select: { status: true, currentQuoteId: true },
    });
    expect(current).toEqual({
      status: "QUOTED",
      currentQuoteId: reissued.body.quoteId,
    });
    const versions = await prisma.quote.findMany({
      where: { quoteRequestId: created.requestId },
      orderBy: { version: "asc" },
      include: {
        priceBinding: { include: { priceSnapshot: true } },
        items: { orderBy: { ordinal: "asc" } },
      },
    });
    expect(versions.map((quote) => quote.version)).toEqual([1, 2]);
    const reissuedSnapshot = versions[1]!.priceBinding!.priceSnapshot!;
    expect(reissuedSnapshot).toMatchObject({
      currency: initialSnapshot.priceBinding!.priceSnapshot!.currency,
      contractTotalMinor:
        initialSnapshot.priceBinding!.priceSnapshot!.contractTotalMinor,
      netAmountMinor:
        initialSnapshot.priceBinding!.priceSnapshot!.netAmountMinor,
      vatAmountMinor:
        initialSnapshot.priceBinding!.priceSnapshot!.vatAmountMinor,
    });
    const initialInputSnapshot = initialSnapshot.priceBinding!.priceSnapshot!
      .inputSnapshot as Record<string, unknown>;
    const reissuedInputSnapshot = reissuedSnapshot.inputSnapshot as Record<
      string,
      unknown
    >;
    expect({
      ...reissuedInputSnapshot,
      quoteVersion: initialInputSnapshot.quoteVersion,
    }).toEqual(initialInputSnapshot);
    expect(
      versions[1]!.items.map(
        ({ id: _id, quoteId: _quoteId, createdAt: _createdAt, ...item }) =>
          item,
      ),
    ).toEqual(
      versions[0]!.items.map(
        ({ id: _id, quoteId: _quoteId, createdAt: _createdAt, ...item }) =>
          item,
      ),
    );

    const oldPreview = await apiJson(`offers/${initial.body.quoteId}`, {
      headers: bearer(initial.body.offerToken),
    });
    expect(oldPreview.response.status).toBe(410);
    const oldIssueReplay = await issueOffer(
      created.requestId,
      initialIssueKey,
      initialExpiry,
    );
    expect(
      oldIssueReplay.response.status,
      JSON.stringify(oldIssueReplay.body),
    ).toBe(201);
    expect(oldIssueReplay.body).toEqual(initial.body);

    const accepted = await acceptOffer(
      reissued.body,
      key("reissue-provenance-accept"),
    );
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.status).toBe("DRAFT");
    const preparation = await apiJson<{ status: string }>(
      `admin/orders/${accepted.body.orderId}/resource-preparation`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": key("reissue-provenance-preparation"),
        },
        body: JSON.stringify({ reason: "Prepare reissued accepted offer" }),
      },
    );
    expect(preparation.response.status).toBe(200);
    expect(preparation.body.status).toBe("PENDING");
    const dispatches = await prisma.outboxMessage.findMany({
      where: {
        aggregateType: "CandidateEstimateDispatch",
        payload: {
          path: ["job", "correlationId"],
          equals: accepted.body.orderId,
        },
      },
      select: { id: true },
    });
    expect(dispatches.length).toBeGreaterThan(0);
    await prisma.outboxMessage.updateMany({
      where: { id: { in: dispatches.map((dispatch) => dispatch.id) } },
      data: { status: "DELIVERED", deliveredAt: new Date() },
    });
    const acceptedStatus = () =>
      apiJson<{ preparationStatus: string }>(
        `offers/${reissued.body.quoteId}/order-status`,
        { headers: bearer(reissued.body.offerToken) },
      );
    expect((await acceptedStatus()).body.preparationStatus).toBe("PREPARING");
    for (const dispatch of dispatches) {
      await prisma.outboxMessage.create({
        data: {
          deduplicationKey: `individual-status-dead-letter:${dispatch.id}`,
          aggregateType: "SlicingDispatchDeadLetter",
          aggregateId: dispatch.id,
          messageType: "slicing.candidate_estimate.dead-lettered",
          schemaVersion: 1,
          payload: { dispatchId: dispatch.id },
          status: "DELIVERED",
          deliveredAt: new Date(),
        },
      });
    }
    expect((await acceptedStatus()).body.preparationStatus).toBe("UNAVAILABLE");
    await expect(
      prisma.individualOrderOrigin.findMany({
        where: { quote: { quoteRequestId: created.requestId } },
        select: { quoteId: true },
      }),
    ).resolves.toEqual([{ quoteId: reissued.body.quoteId }]);
  }, 30_000);

  it("serializes concurrent reissues against one current offer", async () => {
    const created = await quotes.createRequest(
      requestInput("reissue-race"),
      "198.51.100.91",
      key("reissue-race-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("reissue-race-review"),
    );
    const initial = await issueOffer(
      created.requestId,
      key("reissue-race-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );

    const [left, right] = await Promise.all([
      reissueOffer(
        created.requestId,
        key("reissue-race-left"),
        initial.body.quoteId,
        initial.body.version,
        new Date(Date.now() + 2 * 60 * 60 * 1_000),
        "Reissue race left",
        "RACE_LEFT",
      ),
      reissueOffer(
        created.requestId,
        key("reissue-race-right"),
        initial.body.quoteId,
        initial.body.version,
        new Date(Date.now() + 2 * 60 * 60 * 1_000),
        "Reissue race right",
        "RACE_RIGHT",
      ),
    ]);
    expect([left.response.status, right.response.status].sort()).toEqual([
      201, 409,
    ]);
    const successful = left.response.status === 201 ? left : right;
    expect(successful.body.version).toBe(2);
    const persisted = await prisma.quote.findMany({
      where: { quoteRequestId: created.requestId },
      orderBy: { version: "asc" },
      select: { id: true, version: true },
    });
    expect(persisted).toHaveLength(2);
    expect(persisted.map((quote) => quote.version)).toEqual([1, 2]);
    await expect(
      prisma.quoteRequest.findUniqueOrThrow({
        where: { id: created.requestId },
        select: { status: true, currentQuoteId: true },
      }),
    ).resolves.toEqual({
      status: "QUOTED",
      currentQuoteId: successful.body.quoteId,
    });
  });

  it("reissues a retained unaccepted legacy offer through preview, acceptance, and payment schedules", async () => {
    const created = await quotes.createRequest(
      requestInput("legacy-reissue-payment"),
      "198.51.100.92",
      key("legacy-reissue-payment-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("legacy-reissue-payment-review"),
    );
    const initialExpiry = new Date(Date.now() + 60 * 60 * 1_000);
    const initialIssueKey = key("legacy-reissue-payment-issue");
    const initial = await issueOffer(
      created.requestId,
      initialIssueKey,
      initialExpiry,
    );
    expect(initial.response.status).toBe(201);

    const initialPackage = await prisma.quote.findUniqueOrThrow({
      where: { id: initial.body.quoteId },
      include: {
        items: { orderBy: { ordinal: "asc" } },
        priceBinding: {
          include: {
            priceSnapshot: {
              include: {
                components: { orderBy: { id: "asc" } },
                paymentSchedules: { orderBy: { sequence: "asc" } },
                quoteShipmentPlans: { orderBy: { ordinal: "asc" } },
              },
            },
          },
        },
        deliveryDestination: true,
        shipmentPlans: { orderBy: { ordinal: "asc" } },
      },
    });
    const initialChildPackage = {
      items: initialPackage.items,
      priceBinding: initialPackage.priceBinding,
      deliveryDestination: initialPackage.deliveryDestination,
      shipmentPlans: initialPackage.shipmentPlans,
    };

    // This is a migration-owned historical fixture. The real migration marks
    // the row in legacy_quote_request_imports and leaves its legal columns
    // absent; disabling user triggers for this isolated fixture reproduces
    // that retained shape without changing production writers.
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        "SET LOCAL session_replication_role = 'replica'",
      );
      await transaction.$executeRaw`
        UPDATE quotes
        SET public_token_hash = NULL,
            capability_key_id = NULL,
            terms_revision = 'legacy-terms',
            terms_snapshot = '{}'::jsonb,
            legal_terms_revision_id = NULL,
            legal_claims_revision_id = NULL,
            claim_window_days = NULL,
            issuance_command_key = 'legacy-import'
        WHERE id = ${initial.body.quoteId}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE quote_requests
        SET current_state_command_key = 'legacy-import'
        WHERE id = ${created.requestId}::uuid
      `;
      await transaction.$executeRaw`
        INSERT INTO legacy_quote_request_imports
          (quote_request_id, quote_id, photo_publication_consent_granted_at)
        VALUES (${created.requestId}::uuid, ${initial.body.quoteId}::uuid, NULL)
      `;
    });

    const reissued = await reissueOffer(
      created.requestId,
      key("legacy-reissue-payment-command"),
      initial.body.quoteId,
      initial.body.version,
      new Date(Date.now() + 2 * 60 * 60 * 1_000),
    );
    expect(reissued.response.status, JSON.stringify(reissued.body)).toBe(201);
    expect(reissued.body.version).toBe(2);

    const preview = await apiJson<{
      version: number;
      claimPolicyRevision: string;
      paymentSchedules: Array<{ role: string; grossAmountMinor: number }>;
    }>(`offers/${reissued.body.quoteId}`, {
      headers: bearer(reissued.body.offerToken),
    });
    expect(preview.response.status).toBe(200);
    expect(preview.body).toMatchObject({
      version: 2,
      claimPolicyRevision: e2eLegalRevisionCodes.claims,
    });
    expect(
      preview.body.paymentSchedules.map((schedule) => schedule.role),
    ).toEqual(["DEPOSIT", "BALANCE"]);

    const accepted = await acceptOffer(
      reissued.body,
      key("legacy-reissue-payment-accept"),
    );
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.status).toBe("DRAFT");

    const current = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: created.requestId },
      select: { status: true, currentQuoteId: true },
    });
    expect(current).toEqual({
      status: "ACCEPTED",
      currentQuoteId: reissued.body.quoteId,
    });
    const legacy = await prisma.quote.findUniqueOrThrow({
      where: { id: initial.body.quoteId },
      select: {
        issuanceCommandKey: true,
        version: true,
        publicTokenHash: true,
        legalTermsRevisionId: true,
        legalClaimsRevisionId: true,
      },
    });
    expect(legacy).toEqual({
      issuanceCommandKey: "legacy-import",
      version: 1,
      publicTokenHash: null,
      legalTermsRevisionId: null,
      legalClaimsRevisionId: null,
    });

    const retainedChildPackage = await prisma.quote.findUniqueOrThrow({
      where: { id: initial.body.quoteId },
      include: {
        items: { orderBy: { ordinal: "asc" } },
        priceBinding: {
          include: {
            priceSnapshot: {
              include: {
                components: { orderBy: { id: "asc" } },
                paymentSchedules: { orderBy: { sequence: "asc" } },
                quoteShipmentPlans: { orderBy: { ordinal: "asc" } },
              },
            },
          },
        },
        deliveryDestination: true,
        shipmentPlans: { orderBy: { ordinal: "asc" } },
      },
    });
    expect({
      items: retainedChildPackage.items,
      priceBinding: retainedChildPackage.priceBinding,
      deliveryDestination: retainedChildPackage.deliveryDestination,
      shipmentPlans: retainedChildPackage.shipmentPlans,
    }).toEqual(initialChildPackage);

    const priceSnapshot = await prisma.quotePriceBinding.findUniqueOrThrow({
      where: { quoteId: reissued.body.quoteId },
      select: { priceSnapshotId: true },
    });
    await expect(
      prisma.paymentSchedule.findMany({
        where: { priceSnapshotId: priceSnapshot.priceSnapshotId },
        orderBy: { sequence: "asc" },
        select: { role: true },
      }),
    ).resolves.toEqual([{ role: "DEPOSIT" }, { role: "BALANCE" }]);

    const issuedEvents = await prisma.auditEvent.findMany({
      where: {
        quoteRequestId: created.requestId,
        eventType: "quote_offer.issued",
      },
      select: { quoteId: true, payload: true },
    });
    expect(issuedEvents).toHaveLength(2);
    expect(issuedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quoteId: initial.body.quoteId }),
        expect.objectContaining({ quoteId: reissued.body.quoteId }),
      ]),
    );
    await expect(
      prisma.outboxMessage.findMany({
        where: {
          aggregateType: "Quote",
          aggregateId: reissued.body.quoteId,
          messageType: "email.quote-offer-issued",
        },
        select: { messageType: true },
      }),
    ).resolves.toEqual([{ messageType: "email.quote-offer-issued" }]);

    // The historical issuance idempotency response remains replayable even
    // though its quote is no longer the current version.
    const oldReplay = await issueOffer(
      created.requestId,
      initialIssueKey,
      initialExpiry,
    );
    expect(oldReplay.response.status).toBe(201);
    expect(oldReplay.body).toEqual(initial.body);
  });

  it("serializes reissue against acceptance without creating a duplicate order", async () => {
    const created = await quotes.createRequest(
      requestInput("reissue-accept-race"),
      "198.51.100.93",
      key("reissue-accept-race-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("reissue-accept-race-review"),
    );
    const initial = await issueOffer(
      created.requestId,
      key("reissue-accept-race-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    const [reissue, acceptance] = await Promise.all([
      reissueOffer(
        created.requestId,
        key("reissue-accept-race-reissue"),
        initial.body.quoteId,
        initial.body.version,
        new Date(Date.now() + 2 * 60 * 60 * 1_000),
      ),
      acceptOffer(initial.body, key("reissue-accept-race-accept")),
    ]);

    expect([
      [201, 409],
      [201, 410],
      [409, 200],
      [410, 200],
    ]).toContainEqual([reissue.response.status, acceptance.response.status]);
    const acceptedOrders = await prisma.individualOrderOrigin.count({
      where: { quote: { quoteRequestId: created.requestId } },
    });
    expect(acceptedOrders).toBe(acceptance.response.status === 200 ? 1 : 0);
    const request = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: created.requestId },
      select: { status: true, currentQuoteId: true },
    });
    expect(request.currentQuoteId).toBe(
      reissue.response.status === 201
        ? reissue.body.quoteId
        : initial.body.quoteId,
    );
    expect(request.status).toBe(
      acceptance.response.status === 200 ? "ACCEPTED" : "QUOTED",
    );
  });

  it("serializes reissue against rejection without changing the current pointer", async () => {
    const created = await quotes.createRequest(
      requestInput("reissue-reject-race"),
      "198.51.100.94",
      key("reissue-reject-race-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("reissue-reject-race-review"),
    );
    const initial = await issueOffer(
      created.requestId,
      key("reissue-reject-race-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    const [reissue, rejection] = await Promise.all([
      reissueOffer(
        created.requestId,
        key("reissue-reject-race-reissue"),
        initial.body.quoteId,
        initial.body.version,
        new Date(Date.now() + 2 * 60 * 60 * 1_000),
      ),
      rejectOffer(initial.body, key("reissue-reject-race-reject")),
    ]);

    expect([
      [201, 409],
      [201, 410],
      [409, 200],
      [410, 200],
    ]).toContainEqual([reissue.response.status, rejection.response.status]);
    const request = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: created.requestId },
      select: { status: true, currentQuoteId: true },
    });
    expect(request.currentQuoteId).toBe(
      reissue.response.status === 201
        ? reissue.body.quoteId
        : initial.body.quoteId,
    );
    expect(request.status).toBe(
      rejection.response.status === 200 ? "REJECTED" : "QUOTED",
    );
  });

  it("serializes expiry against reissue at the immutable deadline", async () => {
    const created = await quotes.createRequest(
      requestInput("expiry-reissue"),
      "198.51.100.95",
      key("expiry-reissue-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("expiry-reissue-review"),
    );
    const initial = await issueOffer(
      created.requestId,
      key("expiry-reissue-issue"),
      new Date(Date.now() + 700),
    );
    const barrier = new Promise<void>((resolve) => setTimeout(resolve, 550));
    const [reissue, expiration] = await Promise.allSettled([
      barrier.then(() =>
        reissueOffer(
          created.requestId,
          key("expiry-reissue-command"),
          initial.body.quoteId,
          initial.body.version,
          new Date(Date.now() + 2 * 60 * 60 * 1_000),
        ),
      ),
      barrier.then(() =>
        quotes.expireOffer(
          operator,
          created.requestId,
          key("expiry-reissue-expire"),
        ),
      ),
    ]);
    expect(reissue.status).toBe("fulfilled");
    if (reissue.status !== "fulfilled")
      throw new Error("Reissue did not settle");
    expect([201, 409, 410]).toContain(reissue.value.response.status);
    if (expiration.status === "fulfilled") {
      expect(expiration.value.status).toBe("EXPIRED");
    } else {
      expect(expiration.reason).toMatchObject({ status: 409 });
    }
    const request = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: created.requestId },
      select: { status: true, currentQuoteId: true },
    });
    const expired = request.status === "EXPIRED";
    if (expired) {
      expect(reissue.value.response.status).not.toBe(201);
      expect(request.currentQuoteId).toBe(initial.body.quoteId);
    } else {
      expect(request.status).toBe("QUOTED");
      expect(reissue.value.response.status).toBe(201);
      expect(request.currentQuoteId).toBe(reissue.value.body.quoteId);
    }
    await expect(
      prisma.quoteRequest.findUniqueOrThrow({
        where: { id: created.requestId },
        select: { status: true, currentQuoteId: true },
      }),
    ).resolves.toEqual(request);
    await expect(
      prisma.quote.count({ where: { quoteRequestId: created.requestId } }),
    ).resolves.toBe(expired ? 1 : 2);
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
          acknowledgeWithdrawalException: true,
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
      operator,
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
  }, 60_000);

  it("issues a many-item offer with bounded reference lookup batches", async () => {
    const itemCount = 501;
    const created = await quotes.createRequest(
      requestInput("batched-reference-lookups"),
      "198.51.100.46",
      key("batched-reference-lookups-create"),
    );
    await quotes.beginReview(
      operator,
      created.requestId,
      key("batched-reference-lookups-review"),
    );
    const sourceModelFileId = String(defaultOfferItem.sourceModelFileId);
    const references = Array.from({ length: itemCount }, (_, ordinal) => ({
      ordinal,
      modelGeometryId: randomUUID(),
      printConfigRevisionId: randomUUID(),
      modelSelectionId: randomUUID(),
      referenceSliceResultId: randomUUID(),
    }));
    const source = await prisma.modelFile.findUniqueOrThrow({
      where: { id: sourceModelFileId },
    });
    const referenceProfile = await prisma.referenceProfile.findFirstOrThrow({
      where: { material: "PLA", quality: "STANDARD", state: "ACTIVE" },
    });
    const inspectionJobId = randomUUID();
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
      await transaction.quoteRequestModel.create({
        data: {
          requestId: created.requestId,
          modelFileId: sourceModelFileId,
          attachedByOperatorId: operator.operatorId,
          inspectionJobId,
        },
      });
      await transaction.quoteRequestModelSelection.createMany({
        data: references.map(({ modelGeometryId, modelSelectionId }) => ({
          id: modelSelectionId,
          requestId: created.requestId,
          modelFileId: sourceModelFileId,
          modelGeometryId,
          inspectionJobId,
          sourceContentSha256: source.contentHash,
          bodyIds: ["quote-test-body"],
          selectionSha256: createHash("sha256")
            .update(modelSelectionId)
            .digest("hex"),
        })),
      });
      await transaction.sliceResult.createMany({
        data: references.map(
          ({
            modelGeometryId,
            printConfigRevisionId,
            referenceSliceResultId,
          }) => ({
            id: referenceSliceResultId,
            kind: "REFERENCE",
            cacheKey: `quote-e2e:${referenceSliceResultId}`,
            modelGeometryId,
            printConfigRevisionId,
            referenceProfileId: referenceProfile.id,
            partsPerPlate: 1,
            artifactObjectKey: `quote-tests/slices/${referenceSliceResultId}`,
            artifactHash: createHash("sha256")
              .update(referenceSliceResultId)
              .digest("hex"),
            estimatedPrintSeconds: 1n,
            estimatedMaterialMilligrams: 1n,
            slicerEngine: referenceProfile.slicerEngine,
            slicerVersion: referenceProfile.slicerVersion,
          }),
        ),
      });
    });
    const items: Array<Record<string, unknown>> = references.map(
      ({
        modelGeometryId,
        printConfigRevisionId,
        modelSelectionId,
        referenceSliceResultId,
      }) => ({
        kind: "MODEL",
        sourceModelFileId,
        modelGeometryId,
        modelSelectionId,
        printConfigRevisionId,
        primaryReferenceSliceResultId: referenceSliceResultId,
        referencePartsPerPlate: 1,
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

  it("uses the effective legal revision instead of price-list terms metadata", async () => {
    const previousPolicyId = priceListId;
    const previousPolicy = await prisma.priceList.findUniqueOrThrow({
      where: { id: previousPolicyId },
    });
    const selectedPriceListId = await publishTestPriceList(
      previousPolicy.parameters as Record<string, unknown>,
      "terms-catalog-metadata-only",
    );
    const created = await quotes.createRequest(
      requestInput("spaced-terms"),
      "198.51.100.49",
      key("spaced-terms-create"),
    );
    await quotes.beginReview(
      operator,
      created.requestId,
      key("spaced-terms-review"),
    );

    const issued = await issueOffer(
      created.requestId,
      key("spaced-terms-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
      defaultComponents(),
      defaultItems(),
      selectedPriceListId,
    );
    expect(issued.response.status).toBe(201);
    expect(issued.body.termsRevision).toBe(e2eLegalRevisionCodes.terms);
    await activateTestPriceList(previousPolicyId);
  });

  it("rejects a quote whose terms code differs from its bound legal revision", async () => {
    const created = await quotes.createRequest(
      requestInput("mismatched-legal-terms"),
      "198.51.100.53",
      key("mismatched-legal-terms-create"),
    );
    await quotes.beginReview(
      operator,
      created.requestId,
      key("mismatched-legal-terms-review"),
    );
    await issueOffer(
      created.requestId,
      key("mismatched-legal-terms-valid-offer"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    const request = await prisma.quoteRequest.findUniqueOrThrow({
      where: { id: created.requestId },
      select: { customerId: true },
    });
    const legalRevisions = await prisma.legalDocumentRevision.findMany({
      where: {
        revisionCode: {
          in: [e2eLegalRevisionCodes.terms, e2eLegalRevisionCodes.claims],
        },
      },
      select: { id: true, revisionCode: true },
    });
    const termsRevision = legalRevisions.find(
      (revision) => revision.revisionCode === e2eLegalRevisionCodes.terms,
    );
    const claimsRevision = legalRevisions.find(
      (revision) => revision.revisionCode === e2eLegalRevisionCodes.claims,
    );
    if (!termsRevision || !claimsRevision)
      throw new Error("E2E legal revisions are unavailable");
    await expect(
      prisma.$executeRaw`
        INSERT INTO "quotes" (
          "id", "quote_request_id", "customer_id", "terms_revision",
          "legal_terms_revision_id", "legal_claims_revision_id", "claim_window_days",
          "expires_at", "issued_at", "created_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${created.requestId}::uuid, ${request.customerId}::uuid,
          'mismatched-terms-v1', ${termsRevision.id}::uuid, ${claimsRevision.id}::uuid, 30,
          clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp()
        )
      `,
    ).rejects.toThrow(
      /Quote terms revision must match its legal terms revision/,
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

  it("records the exact offer when an operator expires it", async () => {
    const created = await quotes.createRequest(
      requestInput("manual-expiry"),
      "198.51.100.49",
      key("manual-expiry-create"),
    );
    await quotes.beginReview(
      operator,
      created.requestId,
      key("manual-expiry-review"),
    );
    const issued = await quotes.issueOffer(
      operator,
      created.requestId,
      {
        summary: "Manual expiry audit offer",
        expiresAt: new Date(Date.now() + 600).toISOString(),
        promisedDate: "2026-10-01",
        priceListId,
        expectedSelectionVersion: selectionVersion,
        contractTotalMinor: 110_000,
        taxRegime: "NON_VAT_PAYER",
        vatRateBasisPoints: 0,
        netAmountMinor: 110_000,
        vatAmountMinor: 0,
        depositMinor: 33_000,
        termsSnapshot,
        inputSnapshot: { operatorEstimate: "manual-v0" },
        deliveryDestination: defaultDeliveryDestination(),
        shipmentPlans: defaultShipmentPlans(),
        paymentPolicy: defaultPaymentPolicy(),
        items: await prepareOfferItems(created.requestId, defaultItems()),
        components: defaultComponents(),
      } as unknown as IssueOfferDto,
      key("manual-expiry-issue"),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 700));

    const manualExpiryKey = key("manual-expiry-command");
    const expired = await quotes.expireOffer(
      operator,
      created.requestId,
      manualExpiryKey,
    );
    expect(expired).toEqual({
      requestId: created.requestId,
      status: "EXPIRED",
    });
    await expect(
      prisma.auditEvent.findFirstOrThrow({
        where: {
          eventType: "quote_offer.expired",
          idempotencyKey: manualExpiryKey,
        },
      }),
    ).resolves.toMatchObject({ quoteId: issued.quoteId });
  });

  it("accepts against one captured database instant near the deadline", async () => {
    const created = await quotes.createRequest(
      requestInput("acceptance-deadline-race"),
      "198.51.100.47",
      key("acceptance-deadline-race-create"),
    );
    await quotes.beginReview(
      operator,
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
    const created = await quotes.createRequest(
      requestInput("custom-service-create"),
      "198.51.100.220",
      key("custom-service-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("custom-service-review"),
    );
    const response = await issueOffer(
      created.requestId,
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
        where: { quoteRequestId: created.requestId },
      }),
    ).toBe(0);
  });

  it("rejects unselected historical price lists before issuance", async () => {
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
          sellerTaxPolicy: {
            regime: "NON_VAT_PAYER",
            vatRateBasisPoints: 0,
          },
          balance_timeout_earned_component_kinds: ["ITEM_PRODUCTION"],
        },
      },
      {
        scope: "missing-earned-components",
        parameters: {
          sellerTaxPolicy: {
            regime: "NON_VAT_PAYER",
            vatRateBasisPoints: 0,
          },
          balance_payment_days: 7,
        },
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

      expect(response.response.status).toBe(409);
      expect(response.body).toMatchObject({
        message: "Commercial policy selection changed",
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

  it("requires immutable legal evidence for direct quote-request writes", async () => {
    const quoteSession = await prisma.quoteSession.create({
      data: {
        publicTokenHash: createHash("sha256")
          .update(randomBytes(32))
          .digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      prisma.quoteRequest.create({
        data: {
          quoteSessionId: quoteSession.id,
          publicReference: `mp-${randomUUID()}`,
          description: "Direct write without privacy evidence",
          currentStateCommandKey: key("direct-without-privacy"),
        },
      }),
    ).rejects.toThrow(
      "Quote request requires immutable privacy acknowledgement evidence",
    );

    const privacyRevision = await prisma.legalDocumentRevision.findFirstOrThrow(
      {
        where: { revisionCode: e2eLegalRevisionCodes.privacy },
        select: { id: true },
      },
    );
    const requestId = randomUUID();
    await expect(
      prisma.$transaction(async (transaction) => {
        const commandIdentity = key("direct-photo-without-evidence");
        const decision = await transaction.legalAcceptanceDecision.create({
          data: {
            id: randomUUID(),
            quoteRequestId: requestId,
            commandIdentity,
            decidedAt: new Date(),
            originatingXid: "test",
          },
        });
        const request = await transaction.quoteRequest.create({
          data: {
            id: requestId,
            publicReference: `mphoto-${randomUUID()}`,
            description: "Direct write without photo consent evidence",
            photoPublicationConsentGrantedAt: new Date(),
            currentStateCommandKey: key("direct-photo-without-evidence"),
            createdAt: decision.decidedAt,
            updatedAt: decision.decidedAt,
          },
        });
        await transaction.legalAcceptance.create({
          data: {
            quoteRequestId: request.id,
            revisionId: privacyRevision.id,
            purpose: "PRIVACY_NOTICE_ACKNOWLEDGED",
            acceptedAt: decision.decidedAt,
            commandIdentity,
            decisionId: decision.id,
          },
        });
      }),
    ).rejects.toThrow("Quote request legal acceptance decision is incomplete");
  });

  it("owns decision time and transaction provenance and rejects later ledger repairs", async () => {
    const requestId = randomUUID();
    const quoteSession = await prisma.quoteSession.create({
      data: {
        publicTokenHash: createHash("sha256")
          .update(randomBytes(32))
          .digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const commandIdentity = key("legacy-photo-consent-repair");
    const beforeDecision = await databaseNow(prisma);
    const decision = await prisma.$transaction(async (transaction) => {
      const created = await transaction.legalAcceptanceDecision.create({
        data: {
          id: randomUUID(),
          quoteRequestId: requestId,
          commandIdentity: `fixture:${requestId}:privacy`,
          decidedAt: new Date("2000-01-01T00:00:00.000Z"),
          originatingXid: "forged-xid",
        },
      });
      await transaction.quoteRequest.create({
        data: {
          id: requestId,
          quoteSessionId: quoteSession.id,
          publicReference: `legacy-photo-${randomUUID()}`,
          description: "Legacy photo consent repair",
          currentStateCommandKey: "legacy-import",
          createdAt: created.decidedAt,
          updatedAt: created.decidedAt,
        },
      });
      const privacyRevision =
        await transaction.legalDocumentRevision.findFirstOrThrow({
          where: { revisionCode: e2eLegalRevisionCodes.privacy },
          select: { id: true },
        });
      await transaction.legalAcceptance.create({
        data: {
          quoteRequestId: requestId,
          revisionId: privacyRevision.id,
          purpose: "PRIVACY_NOTICE_ACKNOWLEDGED",
          acceptedAt: created.decidedAt,
          commandIdentity: created.commandIdentity,
          decisionId: created.id,
        },
      });
      return created;
    });
    const afterDecision = await databaseNow(prisma);
    expect(decision.decidedAt.getTime()).toBeGreaterThanOrEqual(
      beforeDecision.getTime(),
    );
    expect(decision.decidedAt.getTime()).toBeLessThanOrEqual(
      afterDecision.getTime(),
    );
    expect(decision.originatingXid).not.toBe("forged-xid");
    await expect(
      prisma.legalAcceptanceDecision.create({
        data: {
          id: randomUUID(),
          quoteRequestId: requestId,
          commandIdentity: key("duplicate-privacy-decision"),
          decidedAt: new Date(),
          originatingXid: "forged-xid",
        },
      }),
    ).rejects.toThrow("requires a new request");
    const photoRevisionRows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM legal_document_revisions
      WHERE revision_code = ${e2eLegalRevisionCodes.photoConsent}
      LIMIT 1
    `;
    const photoRevision = photoRevisionRows[0];
    if (!photoRevision) throw new Error("E2E photo revision is missing");
    await expect(
      prisma.$executeRaw`
        INSERT INTO legal_acceptances
          (id, quote_request_id, revision_id, purpose, accepted_at, command_identity)
        VALUES
          (${randomUUID()}::uuid, ${requestId}::uuid, ${photoRevision.id}::uuid,
           'PHOTO_PUBLICATION_GRANTED', ${decision.decidedAt}, ${commandIdentity})
      `,
    ).rejects.toThrow("New legal acceptance requires a database decision");
    await expect(
      prisma.$executeRaw`
        INSERT INTO legal_acceptances
          (id, quote_request_id, revision_id, purpose, accepted_at,
           command_identity, decision_id)
        VALUES
          (${randomUUID()}::uuid, ${requestId}::uuid, ${photoRevision.id}::uuid,
           'PHOTO_PUBLICATION_GRANTED', ${decision.decidedAt},
           ${decision.commandIdentity}, ${decision.id}::uuid)
      `,
    ).rejects.toThrow("Legal acceptance does not match its database decision");
    await expect(
      prisma.$executeRaw`
        UPDATE legal_acceptance_decisions
        SET command_identity = 'tampered'
        WHERE id = ${decision.id}::uuid
      `,
    ).rejects.toThrow("Legal acceptance decisions are immutable");
    const privacyEvidence = await prisma.legalAcceptance.findFirstOrThrow({
      where: { decisionId: decision.id },
      select: { id: true },
    });
    await expect(
      prisma.$executeRaw`
        DELETE FROM legal_acceptances WHERE id = ${privacyEvidence.id}::uuid
      `,
    ).rejects.toThrow("Legal acceptance evidence is append-only");
  });

  it("rejects orphan decisions, request sources, and mismatched ledger evidence", async () => {
    const orphanRequestId = randomUUID();
    const orphanDecisionId = randomUUID();
    await expect(
      prisma.$executeRaw`
        INSERT INTO legal_acceptance_decisions
          (id, quote_request_id, command_identity, decided_at, originating_xid)
        VALUES
          (${orphanDecisionId}::uuid, ${orphanRequestId}::uuid,
           ${key("orphan-privacy-decision")}, clock_timestamp(), 'forged-xid')
      `,
    ).rejects.toThrow();
    await expect(
      prisma.legalAcceptanceDecision.count({ where: { id: orphanDecisionId } }),
    ).resolves.toBe(0);

    await expect(
      prisma.$executeRaw`
        INSERT INTO legal_acceptance_decisions
          (id, quote_request_id, source_quote_id, command_identity,
           decided_at, originating_xid)
        VALUES
          (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
           ${key("invalid-request-source")}, clock_timestamp(), 'forged-xid')
      `,
    ).rejects.toThrow("Request creation decision cannot have a source Quote");

    const privacyRevision = await prisma.legalDocumentRevision.findFirstOrThrow(
      {
        where: { revisionCode: e2eLegalRevisionCodes.privacy },
        select: { id: true },
      },
    );
    for (const mismatch of ["command", "subject", "time"] as const) {
      const requestId = randomUUID();
      await expect(
        prisma.$transaction(async (transaction) => {
          const decision = await transaction.legalAcceptanceDecision.create({
            data: {
              id: randomUUID(),
              quoteRequestId: requestId,
              commandIdentity: key(`${mismatch}-mismatch-decision`),
              decidedAt: new Date(),
              originatingXid: "forged-xid",
            },
          });
          await transaction.quoteRequest.create({
            data: {
              id: requestId,
              publicReference: `decision-${randomUUID()}`,
              currentStateCommandKey: decision.commandIdentity,
              createdAt: decision.decidedAt,
              updatedAt: decision.decidedAt,
            },
          });
          const ledgerSubject =
            mismatch === "subject" ? randomUUID() : requestId;
          const ledgerCommand =
            mismatch === "command"
              ? key("different-command")
              : decision.commandIdentity;
          const ledgerTime =
            mismatch === "time"
              ? new Date(decision.decidedAt.getTime() - 1_000)
              : decision.decidedAt;
          await transaction.$executeRaw`
            INSERT INTO legal_acceptances
              (id, quote_request_id, revision_id, purpose, accepted_at,
               command_identity, decision_id)
            VALUES
              (${randomUUID()}::uuid, ${ledgerSubject}::uuid,
               ${privacyRevision.id}::uuid, 'PRIVACY_NOTICE_ACKNOWLEDGED',
               ${ledgerTime}, ${ledgerCommand}, ${decision.id}::uuid)
          `;
        }),
      ).rejects.toThrow(
        "Legal acceptance does not match its database decision",
      );
      await expect(
        prisma.legalAcceptanceDecision.count({
          where: { quoteRequestId: requestId },
        }),
      ).resolves.toBe(0);
    }
  });

  it("reissues against the newly published terms revision", async () => {
    const created = await quotes.createRequest(
      requestInput("publication-reissue"),
      "198.51.100.96",
      key("publication-reissue-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("publication-reissue-review"),
    );
    const initial = await issueOffer(
      created.requestId,
      key("publication-reissue-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    const initialQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: initial.body.quoteId },
      select: { legalTermsRevisionId: true },
    });
    const termsDocument = await prisma.legalDocument.findUniqueOrThrow({
      where: { key: "terms" },
    });
    const previousGeneration = termsDocument.generation;
    const previousPublications = await prisma.legalDocumentPublication.findMany(
      {
        where: { documentId: termsDocument.id },
      },
    );
    const latestTerms = await prisma.legalDocumentRevision.findFirstOrThrow({
      where: { documentId: termsDocument.id },
      orderBy: { sequence: "desc" },
    });
    const title = "Published terms revision for reissue";
    const summary = "A rotated terms document used by the reissue regression.";
    const sections = [{ title: "Reissue", paragraphs: ["Updated terms."] }];
    const nextTerms = await prisma.legalDocumentRevision.create({
      data: {
        documentId: termsDocument.id,
        sequence: latestTerms.sequence + 1,
        editVersion: 1,
        status: "APPROVED",
        contentVersion: 1,
        title,
        summary,
        sections,
        contentHash: computeLegalRevisionContentHash({
          contentVersion: 1,
          title,
          summary,
          sections,
        }),
        revisionCode: `terms-reissue-${randomUUID()}`,
        effectiveAt: new Date(Date.now() - 1_000),
        approvalEvidence: "Quote reissue E2E fixture",
        approvedBy: operator.operatorId,
        approvedAt: new Date(),
      },
    });
    const previousTermsSnapshot = termsSnapshot;
    try {
      const [publication, reissued] = await Promise.allSettled([
        legalDocuments.publishRevision(
          operator,
          "terms",
          nextTerms.id,
          {
            expectedGeneration: previousGeneration,
            reason: "Quote reissue publication race E2E fixture",
            reasonCode: "E2E_PUBLICATION_RACE",
          },
          key("publication-reissue-publication"),
        ),
        reissueOffer(
          created.requestId,
          key("publication-reissue-command"),
          initial.body.quoteId,
          initial.body.version,
          new Date(Date.now() + 2 * 60 * 60 * 1_000),
        ),
      ]);
      expect(publication.status, JSON.stringify(publication)).toBe("fulfilled");
      expect(reissued.status).toBe("fulfilled");
      if (publication.status !== "fulfilled" || reissued.status !== "fulfilled")
        throw new Error("Publication/reissue race did not settle");
      const reissueResponse = reissued.value;
      expect([201, 400]).toContain(reissueResponse.response.status);
      if (reissueResponse.response.status === 400) {
        expect(reissueResponse.body).toMatchObject({
          message:
            "termsSnapshot must match the current immutable terms revision",
        });
      }
      const versions = await prisma.quote.findMany({
        where: { quoteRequestId: created.requestId },
        orderBy: { version: "asc" },
        select: { id: true, version: true, legalTermsRevisionId: true },
      });
      if (reissueResponse.response.status === 201) {
        expect(versions).toEqual([
          {
            id: initial.body.quoteId,
            version: 1,
            legalTermsRevisionId: initialQuote.legalTermsRevisionId,
          },
          {
            id: reissueResponse.body.quoteId,
            version: 2,
            legalTermsRevisionId: initialQuote.legalTermsRevisionId,
          },
        ]);
      } else {
        expect(versions).toEqual([
          {
            id: initial.body.quoteId,
            version: 1,
            legalTermsRevisionId: initialQuote.legalTermsRevisionId,
          },
        ]);
      }
      await expect(
        prisma.quoteRequest.findUniqueOrThrow({
          where: { id: created.requestId },
          select: { currentQuoteId: true, status: true },
        }),
      ).resolves.toMatchObject({
        status: "QUOTED",
        ...(reissueResponse.response.status === 201
          ? { currentQuoteId: reissueResponse.body.quoteId }
          : { currentQuoteId: initial.body.quoteId }),
      });
    } finally {
      termsSnapshot = previousTermsSnapshot;
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          "SET LOCAL session_replication_role = 'replica'",
        );
        await transaction.$executeRaw`
          DELETE FROM legal_document_publications
          WHERE document_id = ${termsDocument.id}::uuid
        `;
        for (const publication of previousPublications) {
          await transaction.$executeRaw`
            INSERT INTO legal_document_publications
              (id, document_id, revision_id, starts_at, ends_at, cancelled_at,
               published_by, reason, created_at, updated_at)
            VALUES
              (${publication.id}::uuid, ${publication.documentId}::uuid,
               ${publication.revisionId}::uuid, ${publication.startsAt},
               ${publication.endsAt}, ${publication.cancelledAt},
               ${publication.publishedBy}::uuid, ${publication.reason},
               ${publication.createdAt}, ${publication.updatedAt})
          `;
        }
        await transaction.$executeRaw`
          UPDATE legal_documents
          SET generation = ${previousGeneration}
          WHERE id = ${termsDocument.id}::uuid
        `;
      });
    }
  });

  it("rejects an offer acceptance when terms are archived before its legal lock", async () => {
    const created = await quotes.createRequest(
      requestInput("archive-accept-race"),
      "198.51.100.97",
      key("archive-accept-race-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("archive-accept-race-review"),
    );
    const issued = await issueOffer(
      created.requestId,
      key("archive-accept-race-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    expect(issued.response.status).toBe(201);
    const document = await prisma.legalDocument.findUniqueOrThrow({
      where: { key: "terms" },
    });
    const publication = await prisma.legalDocumentPublication.findFirstOrThrow({
      where: {
        documentId: document.id,
        cancelledAt: null,
        startsAt: { lte: new Date() },
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
      },
      orderBy: { startsAt: "desc" },
    });
    const approvals = app.get(LegalApprovalsService);
    const originalLock = approvals.lock.bind(approvals);
    let releaseAcceptance!: () => void;
    const acceptanceMayContinue = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let intercepted = false;
    const lockSpy = vi
      .spyOn(approvals, "lock")
      .mockImplementation(async (tx, keys) => {
        if (!intercepted && keys.includes("terms")) {
          intercepted = true;
          await acceptanceMayContinue;
        }
        return originalLock(tx, keys);
      });
    const acceptanceKey = key("archive-accept-race-accept");
    const acceptance = acceptOffer(issued.body, acceptanceKey);
    try {
      await vi.waitFor(() => expect(intercepted).toBe(true), {
        timeout: 3_000,
        interval: 25,
      });
      await legalDocuments.archivePublication(
        operator,
        "terms",
        publication.id,
        {
          expectedGeneration: document.generation,
          reason: "Quote acceptance archival race E2E fixture",
          reasonCode: "E2E_ACCEPTANCE_RACE",
        },
        key("archive-accept-race-archive"),
      );
      releaseAcceptance();
      const rejected = await acceptance;
      expect(rejected.response.status).toBe(503);
      expect(rejected.body).toMatchObject({ code: "LAUNCH_APPROVAL_REQUIRED" });
      await expect(
        prisma.quoteRequest.findUniqueOrThrow({
          where: { id: created.requestId },
          select: { status: true, currentQuoteId: true },
        }),
      ).resolves.toEqual({
        status: "QUOTED",
        currentQuoteId: issued.body.quoteId,
      });
      await expect(
        prisma.individualOrderOrigin.count({
          where: { quoteId: issued.body.quoteId },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.legalAcceptanceDecision.count({
          where: { sourceQuoteId: issued.body.quoteId },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.idempotencyRecord.count({
          where: {
            namespace: "quote-offer.accept",
            idempotencyKey: acceptanceKey,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      releaseAcceptance();
      await acceptance.catch(() => undefined);
      lockSpy.mockRestore();
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          "SET LOCAL session_replication_role = 'replica'",
        );
        await transaction.$executeRaw`
          UPDATE legal_document_publications
          SET ends_at = ${publication.endsAt}
          WHERE id = ${publication.id}::uuid
        `;
        await transaction.$executeRaw`
          UPDATE legal_documents
          SET generation = ${document.generation}
          WHERE id = ${document.id}::uuid
        `;
      });
    }
  });

  it("finishes an acceptance before a publication archive waiting on its legal lock", async () => {
    const created = await quotes.createRequest(
      requestInput("accept-before-archive-race"),
      "198.51.100.98",
      key("accept-before-archive-race-create"),
    );
    await operatorCommand(
      `admin/quote-requests/${created.requestId}/review`,
      key("accept-before-archive-race-review"),
    );
    const issued = await issueOffer(
      created.requestId,
      key("accept-before-archive-race-issue"),
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    expect(issued.response.status).toBe(201);
    const document = await prisma.legalDocument.findUniqueOrThrow({
      where: { key: "terms" },
    });
    const publication = await prisma.legalDocumentPublication.findFirstOrThrow({
      where: {
        documentId: document.id,
        cancelledAt: null,
        startsAt: { lte: new Date() },
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
      },
      orderBy: { startsAt: "desc" },
    });
    const approvals = app.get(LegalApprovalsService);
    const originalLock = approvals.lock.bind(approvals);
    let releaseAcceptance!: () => void;
    const acceptanceMayContinue = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let intercepted = false;
    const lockSpy = vi
      .spyOn(approvals, "lock")
      .mockImplementation(async (tx, keys) => {
        await originalLock(tx, keys);
        if (!intercepted && keys.includes("terms")) {
          intercepted = true;
          await acceptanceMayContinue;
        }
      });
    const acceptance = acceptOffer(
      issued.body,
      key("accept-before-archive-race-accept"),
    );
    let archival:
      ReturnType<LegalDocumentsService["archivePublication"]> | undefined;
    try {
      await vi.waitFor(() => expect(intercepted).toBe(true), {
        timeout: 3_000,
        interval: 25,
      });
      archival = legalDocuments.archivePublication(
        operator,
        "terms",
        publication.id,
        {
          expectedGeneration: document.generation,
          reason: "Quote acceptance lock race E2E fixture",
          reasonCode: "E2E_ACCEPTANCE_LOCK_RACE",
        },
        key("accept-before-archive-race-archive"),
      );
      await vi.waitFor(
        async () => {
          const rows = await prisma.$queryRaw<Array<{ blocked: bigint }>>`
          SELECT count(*)::bigint AS blocked
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%FROM "legal_documents"%'
            AND query LIKE '%FOR UPDATE%'
        `;
          expect(rows[0]?.blocked).toBeGreaterThan(0n);
        },
        { timeout: 3_000, interval: 25 },
      );
      releaseAcceptance();
      const accepted = await acceptance;
      expect(accepted.response.status).toBe(200);
      const archived = await archival;
      const decision = await prisma.legalAcceptanceDecision.findUniqueOrThrow({
        where: { sourceQuoteId: issued.body.quoteId },
      });
      expect(archived.endsAt).toBeDefined();
      expect(decision.decidedAt.getTime()).toBeLessThanOrEqual(
        new Date(archived.endsAt!).getTime(),
      );
      await expect(
        prisma.order.findUniqueOrThrow({
          where: { id: accepted.body.orderId },
          select: { acceptedTermsRevision: true },
        }),
      ).resolves.toEqual({ acceptedTermsRevision: issued.body.termsRevision });
    } finally {
      releaseAcceptance();
      await acceptance.catch(() => undefined);
      await archival?.catch(() => undefined);
      lockSpy.mockRestore();
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          "SET LOCAL session_replication_role = 'replica'",
        );
        await transaction.$executeRaw`
          UPDATE legal_document_publications
          SET ends_at = ${publication.endsAt}
          WHERE id = ${publication.id}::uuid
        `;
        await transaction.$executeRaw`
          UPDATE legal_documents
          SET generation = ${document.generation}
          WHERE id = ${document.id}::uuid
        `;
      });
    }
  });

  it("rejects a fresh assisted request when privacy is archived before its legal lock", async () => {
    const requestBody = requestInput("privacy-archive-request-race");
    const commandKey = key("privacy-archive-request-race-create");
    const document = await prisma.legalDocument.findUniqueOrThrow({
      where: { key: "privacy" },
      include: {
        publications: {
          where: { endsAt: null, cancelledAt: null },
          take: 1,
        },
      },
    });
    const publication = document.publications[0];
    if (!publication) {
      throw new Error("Quote request privacy publication is unavailable");
    }
    const approvals = app.get(LegalApprovalsService);
    const originalLock = approvals.lock.bind(approvals);
    let releaseRequest!: () => void;
    const requestMayContinue = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let requestBeforeLock = false;
    const lockSpy = vi
      .spyOn(approvals, "lock")
      .mockImplementation(async (tx, keys) => {
        if (!requestBeforeLock && keys.includes("privacy")) {
          requestBeforeLock = true;
          await requestMayContinue;
        }
        return originalLock(tx, keys);
      });
    const request = quotes
      .createRequest(requestBody, "198.51.100.99", commandKey)
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      await vi.waitFor(() => expect(requestBeforeLock).toBe(true), {
        timeout: 3_000,
        interval: 25,
      });
      await legalDocuments.archivePublication(
        operator,
        "privacy",
        publication.id,
        {
          expectedGeneration: document.generation,
          reason: "Assisted request publication race E2E fixture",
          reasonCode: "E2E_REQUEST_PUBLICATION_RACE",
        },
        key("privacy-archive-request-race-archive"),
      );
      releaseRequest();
      await expect(request).resolves.toMatchObject({
        status: 503,
        response: { code: "LAUNCH_APPROVAL_REQUIRED" },
      });
      await expect(
        prisma.customer.count({ where: { email: requestBody.contact.email } }),
      ).resolves.toBe(0);
      await expect(
        prisma.idempotencyRecord.count({
          where: {
            namespace: "quote-request.create",
            idempotencyKey: commandKey,
          },
        }),
      ).resolves.toBe(0);
    } finally {
      releaseRequest();
      await request.catch(() => undefined);
      lockSpy.mockRestore();
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          "SET LOCAL session_replication_role = 'replica'",
        );
        await transaction.$executeRaw`
          UPDATE legal_document_publications
          SET ends_at = ${publication.endsAt}
          WHERE id = ${publication.id}::uuid
        `;
        await transaction.$executeRaw`
          UPDATE legal_documents
          SET generation = ${document.generation}
          WHERE id = ${document.id}::uuid
        `;
      });
    }
  });

  it("uses the database instant after a legal lock wait across scheduled privacy activation", async () => {
    const document = await prisma.legalDocument.findUniqueOrThrow({
      where: { key: "privacy" },
    });
    const previousPublication =
      await prisma.legalDocumentPublication.findFirstOrThrow({
        where: {
          documentId: document.id,
          cancelledAt: null,
          startsAt: { lte: new Date() },
          OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
        },
        orderBy: { startsAt: "desc" },
      });
    const latestRevision = await prisma.legalDocumentRevision.findFirstOrThrow({
      where: { documentId: document.id },
      orderBy: { sequence: "desc" },
    });
    const title = "Scheduled privacy revision for lock boundary";
    const summary =
      "A scheduled privacy notice used by the lock-boundary regression.";
    const sections = [{ title: "Privacy", paragraphs: ["Updated notice."] }];
    const revisionCode = `privacy-lock-boundary-${randomUUID()}`;
    const nextRevision = await prisma.legalDocumentRevision.create({
      data: {
        documentId: document.id,
        sequence: latestRevision.sequence + 1,
        editVersion: 1,
        status: "APPROVED",
        contentVersion: 1,
        title,
        summary,
        sections,
        contentHash: computeLegalRevisionContentHash({
          contentVersion: 1,
          title,
          summary,
          sections,
        }),
        revisionCode,
        effectiveAt: new Date(Date.now() - 1_000),
        approvalEvidence: "Scheduled privacy lock-boundary E2E fixture",
        approvedBy: operator.operatorId,
        approvedAt: new Date(),
      },
    });
    const startsAt = new Date((await databaseNow(prisma)).getTime() + 12_000);
    const scheduled = await legalDocuments.publishRevision(
      operator,
      "privacy",
      nextRevision.id,
      {
        expectedGeneration: document.generation,
        startsAt: startsAt.toISOString(),
        reason: "Scheduled privacy lock-boundary E2E fixture",
        reasonCode: "E2E_PRIVACY_LOCK_BOUNDARY",
      },
      key("privacy-lock-boundary-publish"),
    );
    let releaseDocument!: () => void;
    const documentMayUnlock = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    let documentLocked!: () => void;
    const documentIsLocked = new Promise<void>((resolve) => {
      documentLocked = resolve;
    });
    const holdingDocument = prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw`
          SELECT key FROM "legal_documents" WHERE key = 'privacy' FOR UPDATE
        `;
        documentLocked();
        await documentMayUnlock;
      },
      { timeout: 20_000 },
    );
    const staleBody = requestInput("privacy-lock-boundary-stale");
    const staleKey = key("privacy-lock-boundary-stale-create");
    let staleRequest: Promise<unknown> | undefined;
    try {
      await Promise.race([documentIsLocked, holdingDocument]);
      // Set up the real lock well before activation, then enter the writer's
      // default transaction window only shortly before the database boundary.
      await vi.waitFor(
        async () => {
          expect((await databaseNow(prisma)).getTime()).toBeGreaterThanOrEqual(
            startsAt.getTime() - 3_000,
          );
        },
        { timeout: 15_000, interval: 50 },
      );
      staleRequest = quotes
        .createRequest(staleBody, "198.51.100.101", staleKey)
        .then(
          () => null,
          (error: unknown) => error,
        );
      await vi.waitFor(
        async () => {
          const rows = await prisma.$queryRaw<Array<{ blocked: bigint }>>`
            SELECT count(*)::bigint AS blocked
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE '%FROM "legal_documents"%'
              AND query LIKE '%FOR SHARE%'
          `;
          expect(rows[0]?.blocked).toBeGreaterThan(0n);
        },
        { timeout: 2_000, interval: 25 },
      );
      expect((await databaseNow(prisma)).getTime()).toBeLessThan(
        startsAt.getTime(),
      );
      await vi.waitFor(
        async () => {
          expect((await databaseNow(prisma)).getTime()).toBeGreaterThanOrEqual(
            startsAt.getTime(),
          );
        },
        { timeout: 5_000, interval: 25 },
      );
      releaseDocument();
      await holdingDocument;
      await expect(staleRequest).resolves.toMatchObject({
        status: 503,
        response: { code: "LAUNCH_APPROVAL_REQUIRED" },
      });
      await expect(
        prisma.customer.count({ where: { email: staleBody.contact.email } }),
      ).resolves.toBe(0);
      await expect(
        prisma.legalAcceptanceDecision.count({
          where: { commandIdentity: staleKey },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.idempotencyRecord.count({
          where: {
            namespace: "quote-request.create",
            idempotencyKey: staleKey,
          },
        }),
      ).resolves.toBe(0);

      const fresh = await quotes.createRequest(
        {
          ...requestInput("privacy-lock-boundary-fresh"),
          privacyNoticeRevision: revisionCode,
        },
        "198.51.100.102",
        key("privacy-lock-boundary-fresh-create"),
      );
      const decision = await prisma.legalAcceptanceDecision.findUniqueOrThrow({
        where: { quoteRequestId: fresh.requestId },
      });
      const privacyAcceptance = await prisma.legalAcceptance.findFirstOrThrow({
        where: {
          quoteRequestId: fresh.requestId,
          purpose: "PRIVACY_NOTICE_ACKNOWLEDGED",
        },
      });
      expect(decision.decidedAt.getTime()).toBeGreaterThanOrEqual(
        startsAt.getTime(),
      );
      expect(privacyAcceptance).toMatchObject({
        revisionId: nextRevision.id,
        decisionId: decision.id,
        acceptedAt: decision.decidedAt,
      });
    } finally {
      releaseDocument();
      await holdingDocument.catch(() => undefined);
      await staleRequest?.catch(() => undefined);
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          "SET LOCAL session_replication_role = 'replica'",
        );
        await transaction.$executeRaw`
          DELETE FROM legal_document_publications
          WHERE id = ${scheduled.id}::uuid
        `;
        await transaction.$executeRaw`
          UPDATE legal_document_publications
          SET ends_at = ${previousPublication.endsAt}
          WHERE id = ${previousPublication.id}::uuid
        `;
        await transaction.$executeRaw`
          UPDATE legal_documents
          SET generation = ${document.generation}
          WHERE id = ${document.id}::uuid
        `;
      });
    }
  }, 30_000);

  it("rejects cancellation and stale request after their lock waits cross publication start", async () => {
    const document = await prisma.legalDocument.findUniqueOrThrow({
      where: { key: "privacy" },
    });
    const previousPublication =
      await prisma.legalDocumentPublication.findFirstOrThrow({
        where: {
          documentId: document.id,
          cancelledAt: null,
          startsAt: { lte: new Date() },
          OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
        },
        orderBy: { startsAt: "desc" },
      });
    const latestRevision = await prisma.legalDocumentRevision.findFirstOrThrow({
      where: { documentId: document.id },
      orderBy: { sequence: "desc" },
    });
    const title = "Scheduled privacy revision for cancellation boundary";
    const summary =
      "A scheduled notice used by the cancellation race regression.";
    const sections = [{ title: "Privacy", paragraphs: ["Updated notice."] }];
    const nextRevision = await prisma.legalDocumentRevision.create({
      data: {
        documentId: document.id,
        sequence: latestRevision.sequence + 1,
        editVersion: 1,
        status: "APPROVED",
        contentVersion: 1,
        title,
        summary,
        sections,
        contentHash: computeLegalRevisionContentHash({
          contentVersion: 1,
          title,
          summary,
          sections,
        }),
        revisionCode: `privacy-cancel-boundary-${randomUUID()}`,
        effectiveAt: new Date(Date.now() - 1_000),
        approvalEvidence: "Scheduled privacy cancellation E2E fixture",
        approvedBy: operator.operatorId,
        approvedAt: new Date(),
      },
    });
    const startsAt = new Date((await databaseNow(prisma)).getTime() + 12_000);
    const scheduled = await legalDocuments.publishRevision(
      operator,
      "privacy",
      nextRevision.id,
      {
        expectedGeneration: document.generation,
        startsAt: startsAt.toISOString(),
        reason: "Scheduled privacy cancellation E2E fixture",
        reasonCode: "E2E_PRIVACY_CANCEL_BOUNDARY",
      },
      key("privacy-cancel-boundary-publish"),
    );
    let releaseDocument!: () => void;
    const documentMayUnlock = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    let documentLocked!: () => void;
    const documentIsLocked = new Promise<void>((resolve) => {
      documentLocked = resolve;
    });
    const holdingDocument = prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw`
          SELECT key FROM "legal_documents" WHERE key = 'privacy' FOR UPDATE
        `;
        documentLocked();
        await documentMayUnlock;
      },
      { timeout: 20_000 },
    );
    const cancellationKey = key("privacy-cancel-boundary-cancel");
    const staleKey = key("privacy-cancel-boundary-request");
    const staleBody = requestInput("privacy-cancel-boundary-stale");
    let cancellation: Promise<unknown> | undefined;
    let staleRequest: Promise<unknown> | undefined;
    try {
      await Promise.race([documentIsLocked, holdingDocument]);
      await vi.waitFor(
        async () => {
          expect((await databaseNow(prisma)).getTime()).toBeGreaterThanOrEqual(
            startsAt.getTime() - 3_000,
          );
        },
        { timeout: 15_000, interval: 50 },
      );
      cancellation = legalDocuments
        .cancelPublication(
          operator,
          "privacy",
          scheduled.id,
          {
            expectedGeneration: document.generation + 1,
            reason: "Cancellation blocked across scheduled start",
            reasonCode: "E2E_CANCEL_AFTER_START",
          },
          cancellationKey,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      staleRequest = quotes
        .createRequest(staleBody, "198.51.100.103", staleKey)
        .then(
          () => null,
          (error: unknown) => error,
        );
      await vi.waitFor(
        async () => {
          const rows = await prisma.$queryRaw<Array<{ blocked: bigint }>>`
            SELECT count(*)::bigint AS blocked
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE '%FROM "legal_documents"%'
              AND (query LIKE '%FOR UPDATE%' OR query LIKE '%FOR SHARE%')
          `;
          expect(rows[0]?.blocked).toBeGreaterThanOrEqual(2n);
        },
        { timeout: 2_000, interval: 25 },
      );
      expect((await databaseNow(prisma)).getTime()).toBeLessThan(
        startsAt.getTime(),
      );
      await vi.waitFor(
        async () => {
          expect((await databaseNow(prisma)).getTime()).toBeGreaterThanOrEqual(
            startsAt.getTime(),
          );
        },
        { timeout: 5_000, interval: 25 },
      );
      releaseDocument();
      await holdingDocument;
      await expect(cancellation).resolves.toMatchObject({
        status: 409,
        response: {
          message: "Cannot cancel a publication that has already started",
        },
      });
      await expect(staleRequest).resolves.toMatchObject({
        status: 503,
        response: { code: "LAUNCH_APPROVAL_REQUIRED" },
      });
      await expect(
        prisma.legalDocumentPublication.findUniqueOrThrow({
          where: { id: scheduled.id },
          select: { cancelledAt: true },
        }),
      ).resolves.toEqual({ cancelledAt: null });
      await expect(
        prisma.legalDocument.findUniqueOrThrow({
          where: { id: document.id },
          select: { generation: true },
        }),
      ).resolves.toEqual({ generation: document.generation + 1 });
      await expect(
        prisma.customer.count({ where: { email: staleBody.contact.email } }),
      ).resolves.toBe(0);
      await expect(
        prisma.legalAcceptanceDecision.count({
          where: { commandIdentity: staleKey },
        }),
      ).resolves.toBe(0);
      for (const [namespace, idempotencyKey] of [
        ["legal-document", cancellationKey],
        ["quote-request.create", staleKey],
      ] as const) {
        await expect(
          prisma.idempotencyRecord.count({
            where: { namespace, idempotencyKey },
          }),
        ).resolves.toBe(0);
      }
    } finally {
      releaseDocument();
      await holdingDocument.catch(() => undefined);
      await cancellation?.catch(() => undefined);
      await staleRequest?.catch(() => undefined);
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          "SET LOCAL session_replication_role = 'replica'",
        );
        await transaction.$executeRaw`
          DELETE FROM legal_document_publications
          WHERE id = ${scheduled.id}::uuid
        `;
        await transaction.$executeRaw`
          UPDATE legal_document_publications
          SET ends_at = ${previousPublication.endsAt}
          WHERE id = ${previousPublication.id}::uuid
        `;
        await transaction.$executeRaw`
          UPDATE legal_documents
          SET generation = ${document.generation}
          WHERE id = ${document.id}::uuid
        `;
      });
    }
  }, 30_000);

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
      attribution: { channel: "unknown", source: "e2e" },
      privacyAcknowledged: true,
      privacyNoticeRevision: e2eLegalRevisionCodes.privacy,
    };
  }

  async function createModelOfferItem(
    scope: string,
    retentionHold: "NONE" | "LEGAL",
  ) {
    const id = randomUUID();
    const modelGeometryId = randomUUID();
    const printConfigRevisionId = randomUUID();
    const referenceProfile = await prisma.referenceProfile.findFirstOrThrow({
      where: { material: "PLA", quality: "STANDARD", state: "ACTIVE" },
    });
    const referenceSliceId = randomUUID();
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
          canonicalObjectKey: `geometries/${modelGeometryId}/canonical`,
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
          settings: {
            bundleVersion: 1,
            presets: [
              {
                brim_width: "0",
                layer_height: "0.2",
                enable_support: "0",
                sparse_infill_density: "20%",
              },
            ],
          },
        },
      });
      await transaction.sliceResult.create({
        data: {
          id: referenceSliceId,
          kind: "REFERENCE",
          cacheKey: `quote-e2e:${referenceSliceId}`,
          modelGeometryId,
          printConfigRevisionId,
          referenceProfileId: referenceProfile.id,
          partsPerPlate: 1,
          artifactObjectKey: `quote-tests/slices/${referenceSliceId}`,
          artifactHash: createHash("sha256")
            .update(referenceSliceId)
            .digest("hex"),
          estimatedPrintSeconds: 1n,
          estimatedMaterialMilligrams: 1n,
          slicerEngine: referenceProfile.slicerEngine,
          slicerVersion: referenceProfile.slicerVersion,
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
        primaryReferenceSliceResultId: referenceSliceId,
        referencePartsPerPlate: 1,
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
      taxRegime?: "NON_VAT_PAYER" | "VAT_PAYER";
      vatRateBasisPoints?: number;
      netAmountMinor?: number;
      vatAmountMinor?: number;
    } = {},
  ) {
    items = await prepareOfferItems(requestId, items);
    const offer = offerInput(
      expiresAt,
      components,
      items,
      selectedPriceListId,
      options,
    );
    return apiJson<{
      quoteId: string;
      offerToken: string;
      version: number;
      termsRevision: string;
      expiresAt: string;
    }>(`admin/quote-requests/${requestId}/offers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        cookie: operatorCookie,
        origin: "http://localhost:3002",
        "x-csrf-token": operatorCsrfToken,
      },
      body: JSON.stringify(offer),
    });
  }

  function offerInput(
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
      taxRegime?: "NON_VAT_PAYER" | "VAT_PAYER";
      vatRateBasisPoints?: number;
      netAmountMinor?: number;
      vatAmountMinor?: number;
    } = {},
  ): Record<string, unknown> {
    return {
      summary: "Custom modelling and production offer",
      expiresAt:
        typeof expiresAt === "string" ? expiresAt : expiresAt.toISOString(),
      promisedDate: "2026-10-01",
      priceListId: selectedPriceListId,
      expectedSelectionVersion: selectionVersion,
      contractTotalMinor: options.contractTotalMinor ?? 110_000,
      taxRegime: options.taxRegime ?? "NON_VAT_PAYER",
      vatRateBasisPoints: options.vatRateBasisPoints ?? 0,
      netAmountMinor:
        options.netAmountMinor ?? options.contractTotalMinor ?? 110_000,
      vatAmountMinor: options.vatAmountMinor ?? 0,
      depositMinor: options.depositMinor ?? 33_000,
      termsSnapshot,
      inputSnapshot: { operatorEstimate: "manual-v0" },
      deliveryDestination:
        options.deliveryDestination ?? defaultDeliveryDestination(),
      shipmentPlans:
        options.shipmentPlans ?? defaultShipmentPlansForItems(items),
      paymentPolicy: options.paymentPolicy ?? defaultPaymentPolicy(),
      items,
      components,
    };
  }

  async function reissueOffer(
    requestId: string,
    idempotencyKey: string,
    expectedQuoteId: string,
    expectedVersion: number,
    expiresAt: Date | string,
    reason = "Refresh immutable offer after legal rotation",
    reasonCode = "LEGAL_ROTATION",
  ) {
    const items = await prepareOfferItems(requestId, defaultItems());
    return apiJson<{
      quoteId: string;
      offerToken: string;
      version: number;
      termsRevision: string;
      expiresAt: string;
    }>(`admin/quote-requests/${requestId}/offers/reissue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        cookie: operatorCookie,
        origin: "http://localhost:3002",
        "x-csrf-token": operatorCsrfToken,
      },
      body: JSON.stringify({
        expectedQuoteId,
        expectedVersion,
        reason,
        reasonCode,
        offer: offerInput(expiresAt, defaultComponents(), items),
      }),
    });
  }

  const selectedItems = new Map<string, Promise<string>>();
  const attachedModels = new Map<string, Promise<string>>();
  async function prepareOfferItems(
    requestId: string,
    items: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    return Promise.all(
      items.map(async (item) => {
        if (item.modelSelectionId !== undefined) return item;
        const sourceId = item.sourceModelFileId;
        const geometryId = item.modelGeometryId;
        if (typeof sourceId !== "string" || typeof geometryId !== "string")
          return item;
        const source = await prisma.modelFile.findUnique({
          where: { id: sourceId.toLowerCase() },
        });
        const request = await prisma.quoteRequest.findUnique({
          where: { id: requestId },
        });
        const geometry = await prisma.modelGeometry.findUnique({
          where: { id: geometryId.toLowerCase() },
        });
        if (
          !source ||
          !request ||
          !geometry ||
          geometry.sourceModelFileId !== source.id
        )
          return item;
        const canonicalRequestId = request.id;
        const cacheKey = `${canonicalRequestId}:${source.id}:${geometryId.toLowerCase()}`;
        let pending = selectedItems.get(cacheKey);
        if (!pending) {
          pending = (async () => {
            const attachedKey = `${canonicalRequestId}:${source.id}`;
            let attached = attachedModels.get(attachedKey);
            if (!attached) {
              attached = prisma.quoteRequestModel
                .upsert({
                  where: {
                    requestId_modelFileId: {
                      requestId: canonicalRequestId,
                      modelFileId: source.id,
                    },
                  },
                  create: {
                    requestId: canonicalRequestId,
                    modelFileId: source.id,
                    attachedByOperatorId: operator.operatorId,
                    inspectionJobId: randomUUID(),
                  },
                  update: {},
                })
                .then((model) => model.inspectionJobId);
              attachedModels.set(attachedKey, attached);
            }
            const inspectionJobId = await attached;
            const { geometrySelectionSha256 } =
              await import("@taven/slicer-contracts");
            const selected = await prisma.quoteRequestModelSelection.create({
              data: {
                requestId: canonicalRequestId,
                modelFileId: source.id,
                modelGeometryId: geometryId.toLowerCase(),
                inspectionJobId,
                sourceContentSha256: source.contentHash,
                bodyIds: ["quote-test-body"],
                selectionSha256: geometrySelectionSha256(["quote-test-body"]),
              },
            });
            return selected.id;
          })();
          selectedItems.set(cacheKey, pending);
        }
        return { ...item, modelSelectionId: await pending };
      }),
    );
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
      capabilitySnapshot: {
        carrier: "test",
        service: "standard",
        supportedCategoryIds: ["STANDARD"],
      },
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
    process.env.TAVEN_TERMS_REVISION = issued.termsRevision;
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
        acknowledgeWithdrawalException: true,
      }),
    });
  }

  async function rejectOffer(
    issued: {
      quoteId: string;
      offerToken: string;
      version: number;
      termsRevision: string;
    },
    idempotencyKey: string,
  ) {
    return apiJson<{ requestId: string; status: string }>(
      `offers/${issued.quoteId}/reject`,
      {
        method: "POST",
        headers: {
          ...bearer(issued.offerToken),
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          version: issued.version,
          termsRevision: issued.termsRevision,
          reason: "Customer declined the offer",
        }),
      },
    );
  }

  async function operatorCommand(path: string, idempotencyKey: string) {
    return apiJson<{ requestId: string; status: string }>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        cookie: operatorCookie,
        origin: "http://localhost:3002",
        "x-csrf-token": operatorCsrfToken,
      },
      body: "{}",
    });
  }

  function operatorHeaders(unsafe: boolean): Record<string, string> {
    return {
      cookie: operatorCookie,
      ...(unsafe
        ? {
            origin: "http://localhost:3002",
            "x-csrf-token": operatorCsrfToken,
          }
        : {}),
    };
  }

  async function activateTestPriceList(id: string): Promise<void> {
    const activated = await apiJson<{ selectionVersion: number }>(
      `admin/catalog/price-lists/${id}/activate`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": key("quote-suite-policy-activate"),
        },
        body: JSON.stringify({
          expectedSelectionVersion: selectionVersion,
          reason: "Quote suite policy switch",
        }),
      },
    );
    expect(activated.response.status, JSON.stringify(activated.body)).toBe(200);
    priceListId = id;
    selectionVersion = activated.body.selectionVersion;
  }

  async function publishTestPriceList(
    parameters: Record<string, unknown>,
    termsRevision: string,
  ): Promise<string> {
    const created = await apiJson<{ id: string }>("admin/catalog/price-lists", {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "content-type": "application/json",
        "idempotency-key": key("quote-suite-policy-create"),
      },
      body: JSON.stringify({
        currency: "CZK",
        revision: `quote-suite-${randomUUID()}`,
        termsRevision,
        parameters,
      }),
    });
    expect(created.response.status, JSON.stringify(created.body)).toBe(200);
    await activateTestPriceList(created.body.id);
    return created.body.id;
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

function successfulIndividualCandidateResult(
  job: CandidateEstimateJob,
): CandidateEstimateResult {
  const plateCount = Math.ceil(job.input.quantity / job.input.partsPerPlate);
  const occupancies = Array.from({ length: plateCount }, (_, index) =>
    index < plateCount - 1
      ? job.input.partsPerPlate
      : job.input.quantity - job.input.partsPerPlate * (plateCount - 1),
  );
  return {
    ...job,
    engine: {
      name: job.input.machineProfile.slicerEngine,
      version: job.input.machineProfile.slicerVersion,
      imageSha256: "b".repeat(64),
    },
    outcome: {
      status: "succeeded",
      metrics: {
        boundingBox: {
          xMicrometers: "20000",
          yMicrometers: "20000",
          zMicrometers: "20000",
        },
        objectCount: 1,
        bodyCount: job.input.geometry.bodyIds.length,
        topology: { watertight: true, manifold: true, normals: "consistent" },
        thinWallFeatureCount: 0,
        supportVolumeRatioPpm: 0,
        hasPaintAssignments: false,
        materialAssignmentCount: 0,
        estimatedPrintSeconds: String(60 * plateCount),
        estimatedMaterialMilligrams: String(60 * plateCount),
        plateCount,
      },
      plates: occupancies.map((partsOnPlate, index) => ({
        plateOrdinal: index + 1,
        partsOnPlate,
        estimatedPrintSeconds: "60",
        estimatedMaterialMilligrams: "60",
      })),
      occupancySlices: job.input.occupancySliceTargets.map((target) => ({
        partsPerPlate: target.partsPerPlate,
        cacheIdentitySha256: target.cacheIdentitySha256,
        estimatedPrintSeconds: "60",
        estimatedMaterialMilligrams: "60",
        artifact: {
          objectKey: target.analysisObjectKey,
          sha256: createHash("sha256")
            .update(target.analysisObjectKey)
            .digest("hex"),
        },
      })),
    },
  };
}
