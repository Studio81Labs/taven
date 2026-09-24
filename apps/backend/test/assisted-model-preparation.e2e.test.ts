import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { AppModule } from "../src/app.module";
import { configureHttpBodyParsers } from "../src/http-body.config";
import { PrismaService } from "../src/prisma/prisma.service";
import { QuotesService } from "../src/modules/quotes/quotes.service";
import { e2eLegalRevisionCodes } from "./support/publish-e2e-legal-fixtures";

process.env.TAVEN_ENVIRONMENT ??= "development";
process.env.TAVEN_QUOTE_CAPABILITY_KEY ??=
  "test-quote-capability-key-with-at-least-32-characters";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??=
  "test-only-upload-client-hash-key-32";
process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION ??= "us-east-1";
process.env.TAVEN_S3_BUCKET ??= "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID ??= "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED = "true";

describe("assisted request model preparation", () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: URL;
  let requestId: string;
  let operatorId: string;
  let operatorCookie: string;
  let csrf: string;

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
    const node = await prisma.node.findFirstOrThrow({
      where: { active: true },
    });
    operatorId = randomUUID();
    await prisma.operatorIdentity.create({
      data: {
        id: operatorId,
        email: `assisted-model-${operatorId}@example.test`,
        role: "ADMIN",
        nodeGrants: { create: { nodeId: node.id } },
      },
    });
    const token = randomBytes(32).toString("base64url");
    const csrfKey = process.env.TAVEN_ADMIN_CSRF_KEY
      ? Buffer.from(process.env.TAVEN_ADMIN_CSRF_KEY, "base64url")
      : createHash("sha256").update("openapi:TAVEN_ADMIN_CSRF_KEY").digest();
    csrf = createHmac("sha256", csrfKey).update(token).digest("base64url");
    operatorCookie = `taven_admin=${token}`;
    await prisma.operatorSession.create({
      data: {
        tokenHash: sha256(token),
        csrfHash: sha256(csrf),
        operatorId,
        authenticationMethod: "DEVELOPMENT_PASSWORD",
        credentialVersion: 1,
        absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const request = await app.get(QuotesService).createRequest(
      {
        description: "A custom replacement part needs operator preparation",
        purpose: "Household repair",
        measurements: {},
        requestedDate: "2026-10-01",
        contact: {
          name: "Assisted Customer",
          email: `assisted-${randomUUID()}@example.test`,
        },
        attribution: { channel: "unknown", source: "e2e" },
        privacyAcknowledged: true,
        privacyNoticeRevision: e2eLegalRevisionCodes.privacy,
      },
      `198.51.100.${20 + (randomBytes(1)[0]! % 200)}`,
      `assisted-create-${randomUUID()}`,
    );
    requestId = request.requestId;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function api<T = Record<string, unknown>>(
    path: string,
    init?: RequestInit,
  ) {
    const response = await fetch(new URL(path, baseUrl), init);
    return { response, body: (await response.json()) as T };
  }

  function operatorHeaders(unsafe = false): Record<string, string> {
    return {
      cookie: operatorCookie,
      ...(unsafe
        ? { origin: "http://localhost:3002", "x-csrf-token": csrf }
        : {}),
    };
  }

  it("confirms only a scoped verified upload and dispatches trusted preparation", async () => {
    const bytes = new Uint8Array(84);
    const foreign = await api(
      `admin/quote-requests/${randomUUID()}/model-uploads`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          format: "STL",
          originalFilename: "part.stl",
          contentType: "model/stl",
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        }),
      },
    );
    expect(foreign.response.status).toBe(404);

    const initiated = await api<{
      uploadId: string;
      assetId: string;
      accessToken: string;
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
    }>(`admin/quote-requests/${requestId}/model-uploads`, {
      method: "POST",
      headers: { ...operatorHeaders(true), "content-type": "application/json" },
      body: JSON.stringify({
        format: "STL",
        originalFilename: "part.stl",
        contentType: "model/stl",
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
      }),
    });
    expect(initiated.response.status).toBe(201);
    const upload = initiated.body;
    expect(
      (
        await fetch(upload.uploadUrl, {
          method: "PUT",
          headers: upload.requiredHeaders,
          body: Buffer.from(bytes),
        })
      ).status,
    ).toBe(200);
    const publicConfirm = await api(
      `storage/uploads/${upload.uploadId}/confirm`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${upload.accessToken}` },
      },
    );
    expect(publicConfirm.response.status).toBe(401);
    const wrongRequest = await api(
      `admin/quote-requests/${randomUUID()}/model-uploads/${upload.uploadId}/confirm`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          authorization: `Bearer ${upload.accessToken}`,
        },
      },
    );
    expect(wrongRequest.response.status).toBe(401);
    const confirmed = await api(
      `admin/quote-requests/${requestId}/model-uploads/${upload.uploadId}/confirm`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          authorization: `Bearer ${upload.accessToken}`,
        },
      },
    );
    expect(confirmed.response.status).toBe(200);
    const attached = await prisma.quoteRequestModel.findUniqueOrThrow({
      where: {
        requestId_modelFileId: { requestId, modelFileId: upload.assetId },
      },
    });
    const dispatch = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        aggregateId: attached.inspectionJobId,
        messageType: "slicing.model-inspection.requested",
      },
    });
    expect((dispatch.payload as Record<string, unknown>).job).toBeTruthy();
    const models = await api<{
      items: Array<{ modelFileId: string; inspectionStatus: string }>;
    }>(`admin/quote-requests/${requestId}/models`, {
      headers: operatorHeaders(),
    });
    expect(models.body.items).toEqual([
      expect.objectContaining({
        modelFileId: upload.assetId,
        inspectionStatus: "PENDING",
      }),
    ]);
    const premature = await api(
      `admin/quote-requests/${requestId}/models/select`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": `select-pending-${randomUUID()}`,
        },
        body: JSON.stringify({
          modelFileId: upload.assetId,
          bodyIds: ["body-a"],
        }),
      },
    );
    expect(premature.response.status).toBe(409);

    const job = (dispatch.payload as { job: Record<string, unknown> }).job;
    const result = {
      ...job,
      engine: { name: "orca", version: "2.0", imageSha256: "2".repeat(64) },
      outcome: {
        status: "succeeded",
        canonicalGeometry: null,
        metrics: {
          boundingBox: {
            xMicrometers: "1",
            yMicrometers: "2",
            zMicrometers: "3",
          },
          objectCount: 1,
          bodyCount: 1,
          unitHint: "millimeter",
          scaleAssessment: "trusted",
          suggestedScaleFactorPpm: null,
          thinWallFeatureCount: 0,
          hasPaintAssignments: false,
          materialAssignmentCount: 0,
          extruderAssignmentCount: 0,
        },
        bodies: [
          {
            bodyId: "body-a",
            bodySha256: "3".repeat(64),
            boundingBox: {
              xMicrometers: "1",
              yMicrometers: "2",
              zMicrometers: "3",
            },
            volumeCubicMicrometers: "4",
            triangleCount: 1,
            topology: {
              watertight: true,
              manifold: true,
              normals: "consistent",
            },
            hasPaintAssignments: false,
            materialAssignmentIds: [],
            extruderAssignmentIds: [],
          },
        ],
        findings: [],
      },
    };
    const { ModelInspectionResultSchema } =
      await import("@taven/slicer-contracts");
    ModelInspectionResultSchema.parse(result);
    await prisma.outboxMessage.create({
      data: {
        deduplicationKey: `assisted-model-test:${dispatch.id}`,
        aggregateType: "SlicingDispatchResult",
        aggregateId: dispatch.id,
        messageType: "slicing.model_inspection.result-received",
        schemaVersion: 2,
        payload: { result } as Prisma.InputJsonObject,
      },
    });
    const badBody = await api(
      `admin/quote-requests/${requestId}/models/select`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": `select-bad-${randomUUID()}`,
        },
        body: JSON.stringify({
          modelFileId: upload.assetId,
          bodyIds: ["foreign-body"],
        }),
      },
    );
    expect(badBody.response.status).toBe(409);
    const selected = await api<{
      selectionId: string;
      modelGeometryId: string;
    }>(`admin/quote-requests/${requestId}/models/select`, {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "content-type": "application/json",
        "idempotency-key": `select-good-${randomUUID()}`,
      },
      body: JSON.stringify({
        modelFileId: upload.assetId,
        bodyIds: ["body-a"],
      }),
    });
    expect(selected.response.status).toBe(201);
    const selection = await prisma.quoteRequestModelSelection.findUniqueOrThrow(
      {
        where: { id: selected.body.selectionId },
      },
    );
    expect(selection).toMatchObject({
      requestId,
      modelFileId: upload.assetId,
      modelGeometryId: selected.body.modelGeometryId,
      sourceContentSha256: sha256(bytes),
      bodyIds: ["body-a"],
    });
    const canonical = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        aggregateId: { not: attached.inspectionJobId },
        messageType: "slicing.model-inspection.requested",
        payload: {
          path: [
            "job",
            "input",
            "operation",
            "targetGeometry",
            "modelGeometryId",
          ],
          equals: selected.body.modelGeometryId,
        },
      },
    });
    expect(canonical.aggregateType).toBe("ModelInspectionDispatch");
    await expect(prisma.$executeRaw`
      UPDATE quote_request_model_selections SET body_ids = ARRAY['other']::text[]
      WHERE id = ${selection.id}::uuid
    `).rejects.toThrow();

    await prisma.modelGeometry.create({
      data: {
        id: selection.modelGeometryId,
        sourceModelFileId: upload.assetId,
        canonicalObjectKey: `geometries/${selection.modelGeometryId}/canonical`,
        geometryHash: "4".repeat(64),
        canonicalizerRevision: "canonical-v1",
        volumeCubicMicrometers: 4n,
        boundsXMicrometers: 1n,
        boundsYMicrometers: 2n,
        boundsZMicrometers: 3n,
        triangleCount: 1,
      },
    });
    const configId = randomUUID();
    const profile = await prisma.referenceProfile.findFirstOrThrow({
      where: { material: "PLA", quality: "STANDARD", state: "ACTIVE" },
    });
    const profileId = profile.id;
    await prisma.revisionIdentity.create({
      data: { id: configId, kind: "PRINT_CONFIG", digest: sha256(configId) },
    });
    await prisma.printConfigRevision.create({
      data: {
        id: configId,
        quality: "STANDARD",
        infillPercent: 20,
        layerHeightMicrometers: 200,
        settings: {},
      },
    });
    const preparation = {
      selectionId: selection.id,
      printConfigRevisionId: configId,
      referenceProfileId: profileId,
      quantity: 1,
      partsPerPlate: 1,
    };
    const prepared = await api<{
      primaryReferenceSliceResultId: string | null;
      pendingJobIds: string[];
    }>(`admin/quote-requests/${requestId}/references/prepare`, {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "content-type": "application/json",
        "idempotency-key": `reference-${randomUUID()}`,
      },
      body: JSON.stringify(preparation),
    });
    expect(prepared.response.status).toBe(201);
    expect(prepared.body.primaryReferenceSliceResultId).toBeNull();
    expect(prepared.body.pendingJobIds).toHaveLength(1);
    const referenceDispatch = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        aggregateId: prepared.body.pendingJobIds[0]!,
        messageType: "slicing.reference-slice.requested",
      },
    });
    const { ReferenceSliceJobSchema } = await import("@taven/slicer-contracts");
    ReferenceSliceJobSchema.parse(
      (referenceDispatch.payload as { job: unknown }).job,
    );

    const { buildReferenceSliceCacheKey, RevisionRef, Sha256Digest } =
      await import("@taven/core");
    const cacheKey = buildReferenceSliceCacheKey({
      geometryHash: Sha256Digest.parse("4".repeat(64)),
      modelGeometryId: selection.modelGeometryId,
      geometrySelectionHash: Sha256Digest.parse(selection.selectionSha256),
      referenceProfileRevision: RevisionRef.create(
        "reference-profile",
        profileId,
      ),
      printConfigRevision: RevisionRef.create("print-config", configId),
      partsPerPlate: 1,
    });
    const slice = await prisma.sliceResult.create({
      data: {
        kind: "REFERENCE",
        cacheKey,
        modelGeometryId: selection.modelGeometryId,
        printConfigRevisionId: configId,
        referenceProfileId: profileId,
        partsPerPlate: 1,
        artifactObjectKey: `slice-metrics/${randomUUID()}/result.json`,
        artifactHash: "5".repeat(64),
        estimatedPrintSeconds: 10n,
        estimatedMaterialMilligrams: 20n,
        slicerEngine: profile.slicerEngine,
        slicerVersion: profile.slicerVersion,
      },
    });
    const params = new URLSearchParams(
      Object.entries(preparation).map(([key, value]) => [key, String(value)]),
    );
    const ready = await api<{
      primaryReferenceSliceResultId: string | null;
      pendingJobIds: string[];
    }>(`admin/quote-requests/${requestId}/references/status?${params}`, {
      headers: operatorHeaders(),
    });
    expect(ready.response.status).toBe(200);
    expect(ready.body).toMatchObject({
      primaryReferenceSliceResultId: slice.id,
      pendingJobIds: [],
    });
    const composer = await api<{
      models: {
        items: Array<{
          selections: Array<{ id: string; geometryReady: boolean }>;
        }>;
      };
      policy: {
        selectionVersion: number;
        taxRegime: string;
        vatRateBasisPoints: number;
      };
      referenceProfiles: Array<{ id: string }>;
    }>(`admin/quote-requests/${requestId}/composer`, {
      headers: operatorHeaders(),
    });
    expect(composer.response.status).toBe(200);
    expect(composer.body.models.items[0]?.selections).toEqual([
      expect.objectContaining({ id: selection.id, geometryReady: true }),
    ]);
    expect(composer.body.policy.selectionVersion).toBeGreaterThan(0);
    expect(composer.body.referenceProfiles).toContainEqual(
      expect.objectContaining({ id: profileId }),
    );

    const reviewed = await api(`admin/quote-requests/${requestId}/review`, {
      method: "POST",
      headers: {
        ...operatorHeaders(true),
        "idempotency-key": `review-${randomUUID()}`,
      },
    });
    expect(reviewed.response.status).toBe(200);
    const policy = await prisma.commercialPolicySelection.findUniqueOrThrow({
      where: { currency: "CZK" },
      include: { priceList: true },
    });
    const gross = 110_000;
    const taxRate = composer.body.policy.vatRateBasisPoints;
    const vat = Math.floor(
      (2 * gross * taxRate + (10_000 + taxRate)) / (2 * (10_000 + taxRate)),
    );
    const net = gross - vat;
    const offer = {
      expectedSelectionVersion: policy.selectionVersion,
      summary: "Custom part printed from the inspected selection",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      priceListId: policy.priceListId,
      contractTotalMinor: gross,
      taxRegime: composer.body.policy.taxRegime,
      vatRateBasisPoints: taxRate,
      netAmountMinor: net,
      vatAmountMinor: vat,
      depositMinor: 33_000,
      inputSnapshot: { operatorEstimate: "assisted-e2e" },
      deliveryDestination: {
        providerEndpointId: "local-pickup",
        endpointType: "pickup_point",
        addressSnapshot: { country: "CZ", city: "Praha" },
        capabilitySnapshot: { provider: "local-development" },
      },
      shipmentPlans: [
        {
          category: "STANDARD",
          plannedVolumeCubicMm: 1000,
          plannedWeightMilligrams: 1000,
          shippingAmountMinor: 0,
          packagingAmountMinor: 0,
          handlingAmountMinor: 0,
          packingUnits: [{ quoteItemOrdinal: 0, quantityOrdinal: 1 }],
        },
      ],
      paymentPolicy: {
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
      },
      items: [
        {
          kind: "MODEL",
          modelSelectionId: selection.id,
          sourceModelFileId: upload.assetId,
          modelGeometryId: selection.modelGeometryId,
          printConfigRevisionId: configId,
          primaryReferenceSliceResultId: slice.id,
          referencePartsPerPlate: 1,
          material: "PLA",
          quantity: 1,
        },
      ],
      components: [
        {
          kind: "ITEM_PRODUCTION",
          quoteItemOrdinal: 0,
          amountMinor: net - 30_000,
        },
        { kind: "ITEM_QUANTITY", quoteItemOrdinal: 0, amountMinor: 20_000 },
        {
          kind: "ITEM_POSTPROCESSING",
          quoteItemOrdinal: 0,
          amountMinor: 10_000,
        },
      ],
    };
    const stale = await api(
      `admin/quote-requests/${requestId}/offers/preview`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...offer,
          expectedSelectionVersion: policy.selectionVersion + 1,
        }),
      },
    );
    expect(stale.response.status).toBe(409);
    const preview = await api<{
      contractTotalMinor: number;
      balanceMinor: number;
      paymentSchedules: Array<{ grossAmountMinor: number }>;
    }>(`admin/quote-requests/${requestId}/offers/preview`, {
      method: "POST",
      headers: { ...operatorHeaders(true), "content-type": "application/json" },
      body: JSON.stringify(offer),
    });
    expect(preview.response.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({
      contractTotalMinor: gross,
      balanceMinor: 77_000,
      paymentSchedules: [
        { grossAmountMinor: 33_000 },
        { grossAmountMinor: 77_000 },
      ],
    });
    const issued = await api<{ quoteId: string; offerToken: string }>(
      `admin/quote-requests/${requestId}/offers`,
      {
        method: "POST",
        headers: {
          ...operatorHeaders(true),
          "content-type": "application/json",
          "idempotency-key": `issue-${randomUUID()}`,
        },
        body: JSON.stringify(offer),
      },
    );
    expect(issued.response.status).toBe(201);
    const pinned = await prisma.quoteItem.findFirstOrThrow({
      where: { quoteId: issued.body.quoteId },
    });
    expect(pinned.modelSelectionId).toBe(selection.id);
    const detail = await api<Record<string, unknown>>(
      `admin/quote-requests/${requestId}/offers/${issued.body.quoteId}`,
      { headers: operatorHeaders() },
    );
    expect(detail.response.status).toBe(200);
    expect(detail.body).toMatchObject({
      quoteId: issued.body.quoteId,
      requestId,
      isCurrent: true,
      acceptedOrderId: null,
    });
    expect(detail.body).not.toHaveProperty("offerToken");
  });
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
