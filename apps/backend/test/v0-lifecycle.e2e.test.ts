import "reflect-metadata";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { SlicingQueuePublisher } from "../src/modules/slicing/slicing-queue.publisher";
import { SLICING_QUEUE } from "../src/modules/slicing/slicing.tokens";
import { PrismaService } from "../src/prisma/prisma.service";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.TAVEN_REDIS_URL ?? "redis://127.0.0.1:6381";
const queuePrefix = `taven-v0-lifecycle-${randomUUID()}`;
const scope = `v0-lifecycle-${randomUUID()}`;

const machineBundle = (overrides: Record<string, unknown> = {}) => ({
  bundleVersion: 1,
  presets: [
    { type: "machine" },
    { type: "process", ...overrides },
    { type: "filament" },
  ],
});

const overrideBundle = (overrides: Record<string, unknown> = {}) => ({
  bundleVersion: 1,
  presets: [overrides],
});

const environment = {
  redisUrl: process.env.TAVEN_REDIS_URL,
  bindingFlows: process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED,
  checkoutPaymentFlows: process.env.TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED,
  claimPolicyRevision: process.env.TAVEN_CLAIM_POLICY_REVISION,
  claimWindowDays: process.env.TAVEN_CLAIM_WINDOW_DAYS,
  termsRevision: process.env.TAVEN_TERMS_REVISION,
  photoConsentRevision: process.env.TAVEN_PHOTO_CONSENT_REVISION,
  deliveryEndpoints: process.env.TAVEN_DELIVERY_ENDPOINTS_JSON,
  paymentProvider: process.env.TAVEN_PAYMENT_PROVIDER,
  paymentSandboxPublicUrl: process.env.TAVEN_PAYMENT_SANDBOX_PUBLIC_URL,
  paymentSandboxWebhookSecret: process.env.TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET,
};

process.env.TAVEN_QUOTE_CAPABILITY_KEY ??=
  "v0-lifecycle-quote-capability-key-at-least-32-characters";
process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION ??= "us-east-1";
process.env.TAVEN_S3_BUCKET ??= "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID ??= "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??=
  "v0-lifecycle-upload-client-hash-key-32";
process.env.TAVEN_REDIS_URL = redisUrl;
process.env.TAVEN_BINDING_QUOTE_FLOWS_ENABLED = "true";
process.env.TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED = "true";
process.env.TAVEN_CLAIM_POLICY_REVISION = "v0-lifecycle-claims-v1";
process.env.TAVEN_CLAIM_WINDOW_DAYS = "30";
process.env.TAVEN_TERMS_REVISION = "terms-v0-cz";
process.env.TAVEN_PHOTO_CONSENT_REVISION = "v0-lifecycle-photos-v1";
process.env.TAVEN_PAYMENT_PROVIDER = "sandbox";
process.env.TAVEN_PAYMENT_SANDBOX_PUBLIC_URL = "http://sandbox.local";
process.env.TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET =
  "v0-lifecycle-sandbox-webhook-secret-at-least-32";
process.env.TAVEN_DELIVERY_ENDPOINTS_JSON = JSON.stringify([
  {
    providerEndpointId: "v0-lifecycle-pickup",
    endpointType: "pickup_point",
    addressSnapshot: {
      country: "CZ",
      city: "Prague",
      label: "V0 lifecycle pickup",
    },
    supportedCategoryIds: ["pickup", "oversize"],
    provider: "fixture",
  },
]);

type FixtureWorker = Pick<Worker, "close" | "waitUntilReady">;

describe.skipIf(!databaseUrl)("v0 integrated lifecycle", () => {
  let app: INestApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let publisher: SlicingQueuePublisher;
  let fixtureWorkers: FixtureWorker[];
  let queue: Queue;
  let slicingQueueName: string;
  let fixtureRuntime: typeof import("@taven/slicer-worker/fixture-runtime", {
    with: { "resolution-mode": "import" },
  });

  beforeAll(async () => {
    const contracts = await import("@taven/slicer-contracts");
    fixtureRuntime = await import("@taven/slicer-worker/fixture-runtime");
    slicingQueueName = contracts.SLICING_QUEUE_NAME;
    const connection = fixtureRuntime.redisConnection(redisUrl);
    queue = new Queue(slicingQueueName, { connection, prefix: queuePrefix });
    fixtureWorkers = fixtureRuntime.createFixtureWorkers(
      (name, processor) =>
        new Worker(name, async (job) => processor(job.data), {
          connection,
          prefix: queuePrefix,
        }),
    );
    await Promise.all(fixtureWorkers.map((worker) => worker.waitUntilReady()));

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SLICING_QUEUE)
      .useValue(queue)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = new URL(await app.getUrl());
    prisma = app.get(PrismaService);
    publisher = app.get(SlicingQueuePublisher);
  }, 30_000);

  afterAll(async () => {
    await fixtureRuntime?.closeFixtureWorkers(fixtureWorkers ?? []);
    await app?.close();
    restoreEnvironment("TAVEN_REDIS_URL", environment.redisUrl);
    restoreEnvironment(
      "TAVEN_BINDING_QUOTE_FLOWS_ENABLED",
      environment.bindingFlows,
    );
    restoreEnvironment(
      "TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED",
      environment.checkoutPaymentFlows,
    );
    restoreEnvironment(
      "TAVEN_CLAIM_POLICY_REVISION",
      environment.claimPolicyRevision,
    );
    restoreEnvironment("TAVEN_CLAIM_WINDOW_DAYS", environment.claimWindowDays);
    restoreEnvironment("TAVEN_TERMS_REVISION", environment.termsRevision);
    restoreEnvironment(
      "TAVEN_PHOTO_CONSENT_REVISION",
      environment.photoConsentRevision,
    );
    restoreEnvironment(
      "TAVEN_DELIVERY_ENDPOINTS_JSON",
      environment.deliveryEndpoints,
    );
    restoreEnvironment("TAVEN_PAYMENT_PROVIDER", environment.paymentProvider);
    restoreEnvironment(
      "TAVEN_PAYMENT_SANDBOX_PUBLIC_URL",
      environment.paymentSandboxPublicUrl,
    );
    restoreEnvironment(
      "TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET",
      environment.paymentSandboxWebhookSecret,
    );
  }, 30_000);

  it("drives an uploaded automatic quote through real slicing, sandbox capture, operator fulfilment, and delivery", async () => {
    const { createTavenApiClient } = await import("@taven/openapi-client");
    const infrastructure = await seedInfrastructure();
    const operator = await operatorSession(infrastructure.nodeId);
    const api = createTavenApiClient({ baseUrl: baseUrl.toString() });
    const operatorApi = createTavenApiClient({
      baseUrl: baseUrl.toString(),
      headers: {
        cookie: operator.cookie,
        origin: "http://localhost:3002",
      },
    });

    const previousReference = await prisma.referenceProfile.findFirst({
      where: { material: "PLA", quality: "STANDARD", state: "ACTIVE" },
      select: { id: true },
    });
    if (!previousReference) {
      throw new Error(
        "the seeded active PLA/STANDARD reference profile is required",
      );
    }
    success(
      await operatorApi.POST("/admin/catalog/reference-profiles/{id}/retire", {
        params: {
          path: { id: previousReference.id },
          header: operatorHeaders(
            operator.csrfToken,
            "retire-seeded-reference",
          ),
        },
        body: { reason: "Superseded by the v0 lifecycle fixture profile" },
      }),
    );

    const reference = success(
      await operatorApi.POST("/admin/catalog/reference-profiles", {
        params: { header: operatorHeaders(operator.csrfToken, "reference") },
        body: {
          material: "PLA",
          quality: "STANDARD",
          slicerEngine: "fixture",
          slicerVersion: "0.0.0",
          settings: machineBundle({ profile: scope, layerHeight: 200 }),
        },
      }),
    );
    const activatedReference = success(
      await operatorApi.POST(
        "/admin/catalog/reference-profiles/{id}/activate",
        {
          params: {
            path: { id: reference.id },
            header: operatorHeaders(operator.csrfToken, "reference-activate"),
          },
          body: { reason: "Fixture reference profile verified" },
        },
      ),
    );
    expect(activatedReference.notice).toMatchObject({
      referenceProfileId: reference.id,
      material: "PLA",
      quality: "STANDARD",
    });
    const activationNotices = success(
      await operatorApi.GET(
        "/admin/catalog/reference-profile-activation-notices",
      ),
    );
    expect(activationNotices.items).toContainEqual(activatedReference.notice);

    const machineProfile = success(
      await operatorApi.POST("/admin/catalog/machine-profiles", {
        params: {
          header: operatorHeaders(operator.csrfToken, "machine-profile"),
        },
        body: {
          machineCapabilityId: infrastructure.machineCapabilityId,
          referenceProfileId: reference.id,
          material: "PLA",
          quality: "STANDARD",
          slicerEngine: "fixture",
          slicerVersion: "0.0.0",
          nozzleDiameterMicrometers: 400,
          productionArtifactFormat: "GCODE_3MF",
          settings: machineBundle({ profile: scope, machine: "fixture" }),
        },
      }),
    );
    success(
      await operatorApi.POST("/admin/catalog/machine-profiles/{id}/activate", {
        params: {
          path: { id: machineProfile.id },
          header: operatorHeaders(
            operator.csrfToken,
            "machine-profile-activate",
          ),
        },
        body: { reason: "Fixture machine profile verified" },
      }),
    );

    const calibration = success(
      await operatorApi.POST("/admin/nodes/{nodeId}/calibrations", {
        params: {
          path: { nodeId: infrastructure.nodeId },
          header: operatorHeaders(operator.csrfToken, "calibration"),
        },
        body: {
          machineId: infrastructure.machineId,
          flowRatioPartsPerMillion: 1_000_000,
          xyCompensationMicrometers: 0,
          elephantFootCompensationMicrometers: 0,
          settings: overrideBundle({ calibration: scope }),
        },
      }),
    );
    success(
      await operatorApi.POST(
        "/admin/nodes/{nodeId}/calibrations/{calibrationId}/activate",
        {
          params: {
            path: {
              nodeId: infrastructure.nodeId,
              calibrationId: calibration.id,
            },
            header: operatorHeaders(operator.csrfToken, "calibration-activate"),
          },
          body: { reason: "Fixture machine calibration verified" },
        },
      ),
    );
    const inventory = success(
      await operatorApi.POST("/admin/nodes/{nodeId}/inventories", {
        params: {
          path: { nodeId: infrastructure.nodeId },
          header: operatorHeaders(operator.csrfToken, "inventory"),
        },
        body: {
          machineId: infrastructure.machineId,
          sku: `v0-lifecycle-${randomUUID()}`,
          material: "PLA",
          vendor: "Taven fixture",
          color: "v0-blue",
          lotCode: "v0-lifecycle",
          priceMinorUnitsNumerator: "1",
          priceMinorUnitsDenominator: "1",
          currency: "CZK",
          remainingMilligrams: "1000000",
        },
      }),
    );
    expect(inventory.status).toBe("AVAILABLE");

    const created = success(
      await api.POST("/automatic-quote-sessions", {
        params: { header: { "Idempotency-Key": commandKey("create") } },
        body: { attribution: { channel: "direct", campaign: "v0-lifecycle" } },
      }),
    );
    const sessionApi = createTavenApiClient({
      baseUrl: baseUrl.toString(),
      headers: { authorization: `Bearer ${created.sessionToken}` },
    });
    const sourceBytes = binaryStl();
    const upload = success(
      await api.POST("/storage/uploads/model-files", {
        body: {
          format: "STL",
          originalFilename: "v0-lifecycle.stl",
          contentType: "model/stl",
          sizeBytes: sourceBytes.byteLength,
          sha256: sha256(sourceBytes),
        },
      }),
    );
    const uploadResponse = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: upload.requiredHeaders,
      body: Buffer.from(sourceBytes),
    });
    expect(uploadResponse.status).toBe(200);
    const uploadApi = createTavenApiClient({
      baseUrl: baseUrl.toString(),
      headers: { authorization: `Bearer ${upload.accessToken}` },
    });
    const confirmed = success(
      await uploadApi.POST("/storage/uploads/{uploadId}/confirm", {
        params: { path: { uploadId: upload.uploadId } },
      }),
    );
    expect(confirmed.assetId).toBe(upload.assetId);

    const attached = success(
      await sessionApi.POST(
        "/automatic-quote-sessions/{sessionId}/model-files",
        {
          params: {
            path: { sessionId: created.sessionId },
            header: { "Idempotency-Key": commandKey("attach") },
          },
          body: {
            modelFileId: upload.assetId,
            uploadToken: upload.accessToken,
          },
        },
      ),
    );
    expect(attached.modelFiles).toEqual([
      expect.objectContaining({
        modelFileId: upload.assetId,
        inspectionStatus: "PENDING",
      }),
    ]);
    await drainSlicing(1);

    const afterInspection = success(
      await sessionApi.GET("/automatic-quote-sessions/{sessionId}", {
        params: { path: { sessionId: created.sessionId } },
      }),
    );
    expect(afterInspection.modelFiles).toEqual([
      expect.objectContaining({
        modelFileId: upload.assetId,
        inspectionStatus: "SUCCEEDED",
        discoveredBodyIds: ["body-0001"],
      }),
    ]);

    const configured = success(
      await sessionApi.PUT(
        "/automatic-quote-sessions/{sessionId}/items/{ordinal}/configuration",
        {
          params: {
            path: { sessionId: created.sessionId, ordinal: 0 },
            header: { "Idempotency-Key": commandKey("configure") },
          },
          body: {
            modelFileId: upload.assetId,
            bodyIds: ["body-0001"],
            printConfigRevisionId: infrastructure.printConfigRevisionId,
            material: "PLA",
            color: "v0-blue",
            infillPreset: "STANDARD",
            quantity: 1,
            fitSensitive: false,
          },
        },
      ),
    );
    expect(configured.items).toEqual([
      expect.objectContaining({ status: "CANONICALIZATION_PENDING" }),
    ]);

    const canonicalPending = success(
      await sessionApi.POST("/automatic-quote-sessions/{sessionId}/prepare", {
        params: {
          path: { sessionId: created.sessionId },
          header: { "Idempotency-Key": commandKey("canonical") },
        },
      }),
    );
    expect(canonicalPending.phase).toBe("REFERENCE_SLICES_PENDING");
    await drainSlicing(1);

    const referencePending = success(
      await sessionApi.POST("/automatic-quote-sessions/{sessionId}/prepare", {
        params: {
          path: { sessionId: created.sessionId },
          header: { "Idempotency-Key": commandKey("reference") },
        },
      }),
    );
    expect(referencePending.phase).toBe("REFERENCE_SLICES_PENDING");
    await drainSlicing(1);

    const destinationRequired = success(
      await sessionApi.POST("/automatic-quote-sessions/{sessionId}/prepare", {
        params: {
          path: { sessionId: created.sessionId },
          header: { "Idempotency-Key": commandKey("post-reference") },
        },
      }),
    );
    expect(destinationRequired.phase).toBe("DESTINATION_REQUIRED");
    success(
      await sessionApi.PUT(
        "/automatic-quote-sessions/{sessionId}/delivery-destination",
        {
          params: {
            path: { sessionId: created.sessionId },
            header: { "Idempotency-Key": commandKey("destination") },
          },
          body: {
            providerEndpointId: "v0-lifecycle-pickup",
            endpointType: "pickup_point",
          },
        },
      ),
    );
    const eligibilityPending = success(
      await sessionApi.POST("/automatic-quote-sessions/{sessionId}/prepare", {
        params: {
          path: { sessionId: created.sessionId },
          header: { "Idempotency-Key": commandKey("binding") },
        },
      }),
    );
    expect(eligibilityPending.phase).toBe("ELIGIBILITY_PENDING");
    await drainSlicing(1);

    const ready = success(
      await sessionApi.POST("/automatic-quote-sessions/{sessionId}/prepare", {
        params: {
          path: { sessionId: created.sessionId },
          header: { "Idempotency-Key": commandKey("ready") },
        },
      }),
    );
    expect(ready).toMatchObject({
      phase: "CHECKOUT_READY",
      checkoutReady: true,
      bindingQuote: { kind: "BINDING", currency: "CZK" },
    });

    const capabilities = success(await api.GET("/payments/capabilities"));
    if (!capabilities.legalDocuments) {
      throw new Error("sandbox checkout must expose legal documents");
    }
    const payment = success(
      await sessionApi.POST(
        "/automatic-quote-sessions/{sessionId}/checkout/payments",
        {
          params: {
            path: { sessionId: created.sessionId },
            header: { "Idempotency-Key": commandKey("checkout") },
          },
          body: {
            email: `customer-${randomUUID()}@example.test`,
            fullName: "V0 Lifecycle Customer",
            billing: {
              name: "V0 Lifecycle Customer",
              addressLine1: "Testovací 12",
              city: "Prague",
              postalCode: "110 00",
              countryCode: "CZ",
            },
            method: "CARD",
            acceptTerms: true,
            acceptClaimPolicy: true,
            termsRevision: capabilities.legalDocuments.termsRevision,
            claimPolicyRevision:
              capabilities.legalDocuments.claimPolicyRevision,
            acknowledgeWithdrawalException: true,
            photoPublicationConsent: false,
            photoConsentRevision:
              capabilities.legalDocuments.photoConsentRevision,
          },
        },
      ),
    );
    expect(payment).toMatchObject({ provider: "sandbox", status: "PENDING" });
    if (!payment.checkoutUrl)
      throw new Error("sandbox checkout URL is required");
    const sandboxPath = new URL(payment.checkoutUrl).pathname;
    const captured = await fetch(new URL(`${sandboxPath}/capture`, baseUrl), {
      method: "POST",
    });
    expect(captured.status).toBe(200);

    const job = await prisma.job.findFirstOrThrow({
      where: { orderId: created.orderId },
      select: { id: true, status: true },
    });
    expect(job.status).toBe("CREATED");
    const acceptHeaders = operatorHeaders(operator.csrfToken, "accept");
    const accepted = success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/accept",
        {
          params: {
            path: { orderId: created.orderId, jobId: job.id },
            header: acceptHeaders,
          },
        },
      ),
    );
    const acceptedReplay = success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/accept",
        {
          params: {
            path: { orderId: created.orderId, jobId: job.id },
            header: acceptHeaders,
          },
        },
      ),
    );
    expect(acceptedReplay).toEqual(accepted);
    await expect(
      prisma.outboxMessage.count({
        where: {
          aggregateType: "ProductionSliceDispatch",
          aggregateId: job.id,
        },
      }),
    ).resolves.toBe(1);
    await drainSlicing(1);
    await expect(
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: "GCODE_READY" });

    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/printing",
        {
          params: {
            path: { orderId: created.orderId, jobId: job.id },
            header: operatorHeaders(operator.csrfToken, "printing"),
          },
        },
      ),
    );
    const reservation = await prisma.productionReservation.findFirstOrThrow({
      where: { jobId: job.id },
      select: { requiredMaterialMilligrams: true },
    });
    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/printed",
        {
          params: {
            path: { orderId: created.orderId, jobId: job.id },
            header: operatorHeaders(operator.csrfToken, "printed"),
          },
          body: {
            actualMaterialMilligrams:
              reservation.requiredMaterialMilligrams.toString(),
          },
        },
      ),
    );
    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/qc-submission",
        {
          params: {
            path: { orderId: created.orderId, jobId: job.id },
            header: operatorHeaders(operator.csrfToken, "qc-submission"),
          },
          body: { omissionReason: "v0 named-operator visual inspection" },
        },
      ),
    );
    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/qc-approval",
        {
          params: {
            path: { orderId: created.orderId, jobId: job.id },
            header: operatorHeaders(operator.csrfToken, "qc-approval"),
          },
        },
      ),
    );

    const shipmentPlan = await prisma.shipmentPlan.findFirstOrThrow({
      where: { orderId: created.orderId },
      select: { id: true },
    });
    success(
      await operatorApi.POST("/admin/orders/{orderId}/fulfilment/shipments", {
        params: {
          path: { orderId: created.orderId },
          header: operatorHeaders(operator.csrfToken, "create-shipment"),
        },
        body: { shipmentPlanId: shipmentPlan.id },
      }),
    );
    const shipment = await prisma.shipment.findFirstOrThrow({
      where: { orderId: created.orderId },
      select: { id: true },
    });
    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/shipments/{shipmentId}/label",
        {
          params: {
            path: { orderId: created.orderId, shipmentId: shipment.id },
            header: operatorHeaders(operator.csrfToken, "label"),
          },
          body: {
            carrier: "fixture-carrier",
            providerShipmentId: `fixture-shipment-${shipment.id}`,
            carrierLabelId: `fixture-label-${shipment.id}`,
            trackingCode: `fixture-tracking-${shipment.id}`,
            reason: "Label printed for v0 lifecycle",
          },
        },
      ),
    );
    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/packing",
        {
          params: {
            path: { orderId: created.orderId, jobId: job.id },
            header: operatorHeaders(operator.csrfToken, "packing"),
          },
          body: { shipmentId: shipment.id },
        },
      ),
    );
    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/shipments/{shipmentId}/handoff",
        {
          params: {
            path: { orderId: created.orderId, shipmentId: shipment.id },
            header: operatorHeaders(operator.csrfToken, "handoff"),
          },
          body: providerEvidence("handoff", shipment.id),
        },
      ),
    );
    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/shipments/{shipmentId}/events",
        {
          params: {
            path: { orderId: created.orderId, shipmentId: shipment.id },
            header: operatorHeaders(operator.csrfToken, "transit"),
          },
          body: {
            ...providerEvidence("transit", shipment.id),
            kind: "TRANSIT_SCAN",
          },
        },
      ),
    );
    success(
      await operatorApi.POST(
        "/admin/orders/{orderId}/fulfilment/shipments/{shipmentId}/events",
        {
          params: {
            path: { orderId: created.orderId, shipmentId: shipment.id },
            header: operatorHeaders(operator.csrfToken, "delivered"),
          },
          body: {
            ...providerEvidence("delivered", shipment.id),
            kind: "DELIVERY_SCAN",
          },
        },
      ),
    );
    const completed = success(
      await operatorApi.POST("/admin/orders/{orderId}/fulfilment/complete", {
        params: {
          path: { orderId: created.orderId },
          header: operatorHeaders(operator.csrfToken, "complete"),
        },
      }),
    );
    expect(completed.status).toBe("ORDER_COMPLETED");
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: created.orderId } }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
    const projection = success(
      await operatorApi.GET("/admin/orders/{orderId}/fulfilment", {
        params: { path: { orderId: created.orderId } },
      }),
    );
    expect(projection).toMatchObject({
      orderId: created.orderId,
      orderStatus: "COMPLETED",
      jobs: [{ id: job.id, status: "SETTLED" }],
      shipments: [{ id: shipment.id, status: "DELIVERED" }],
    });
    const [events, audits, reservations] = await Promise.all([
      prisma.businessEvent.findMany({
        where: {
          OR: [
            { orderId: created.orderId },
            { eventType: "upload.confirmed", dedupeKey: upload.assetId },
          ],
        },
        select: { dedupeKey: true, eventType: true },
      }),
      prisma.auditEvent.findMany({
        where: {
          orderId: created.orderId,
          eventType: "fulfilment.command_completed",
        },
        select: { actorId: true, nodeId: true },
      }),
      prisma.productionReservation.findMany({
        where: { jobId: job.id },
        select: {
          status: true,
          inventoryReservation: { select: { status: true } },
          capacityReservations: { select: { status: true } },
        },
      }),
    ]);
    expect(
      events.map(({ eventType, dedupeKey }) => `${eventType}:${dedupeKey}`),
    ).toHaveLength(
      new Set(
        events.map(({ eventType, dedupeKey }) => `${eventType}:${dedupeKey}`),
      ).size,
    );
    expect(events.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining([
        "upload.confirmed",
        "quote.bound",
        "payment.captured",
        "job.qc-approved",
        "shipment.handed-off",
        "shipment.delivered",
        "order.completed",
      ]),
    );
    expect(audits).not.toHaveLength(0);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: operator.operatorId,
          nodeId: infrastructure.nodeId,
        }),
      ]),
    );
    expect(reservations).toEqual([
      {
        status: "CONSUMED",
        inventoryReservation: { status: "CONSUMED" },
        capacityReservations: [{ status: "COMPLETED" }],
      },
    ]);
  }, 90_000);

  async function seedInfrastructure(): Promise<{
    nodeId: string;
    machineId: string;
    machineCapabilityId: string;
    printConfigRevisionId: string;
  }> {
    const printConfig = await prisma.printConfigRevision.findFirst({
      where: { quality: "STANDARD", infillPercent: 20 },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (!printConfig) {
      throw new Error("the v0 STANDARD/20 print configuration must be seeded");
    }
    const nodeId = randomUUID();
    const machineCapabilityId = randomUUID();
    const machineId = randomUUID();
    await prisma.$transaction([
      prisma.node.create({
        data: {
          id: nodeId,
          code: `v0-${scope.slice(-12)}`,
          name: "V0 lifecycle node",
          timeZone: "Europe/Prague",
          active: true,
        },
      }),
      prisma.machineCapability.create({
        data: {
          id: machineCapabilityId,
          capabilityKey: `v0-lifecycle-${scope}`,
          manufacturer: "Taven fixture",
          model: "V0 fixture machine",
          buildVolumeXMicrometers: 200_000n,
          buildVolumeYMicrometers: 200_000n,
          buildVolumeZMicrometers: 200_000n,
          supportedNozzleMicrometers: [400],
          supportedMaterials: ["PLA"],
        },
      }),
      prisma.machine.create({
        data: {
          id: machineId,
          nodeId,
          machineCapabilityId,
          code: `v0-${scope.slice(-12)}`,
          displayName: "V0 lifecycle machine",
          status: "ACTIVE",
          installedNozzleMicrometers: 400,
        },
      }),
    ]);
    return {
      nodeId,
      machineId,
      machineCapabilityId,
      printConfigRevisionId: printConfig.id,
    };
  }

  async function operatorSession(nodeId: string): Promise<{
    cookie: string;
    csrfToken: string;
    operatorId: string;
  }> {
    const identity = await prisma.operatorIdentity.create({
      data: {
        email: `v0-lifecycle-${randomUUID()}@example.test`,
        role: "ADMIN",
        nodeGrants: { create: { nodeId } },
      },
    });
    const token = randomBytes(32).toString("base64url");
    const csrfKey = createHash("sha256")
      .update("openapi:TAVEN_ADMIN_CSRF_KEY")
      .digest();
    const csrfToken = createHmac("sha256", csrfKey)
      .update(token)
      .digest("base64url");
    await prisma.operatorSession.create({
      data: {
        tokenHash: sha256(token),
        csrfHash: sha256(csrfToken),
        operatorId: identity.id,
        authenticationMethod: "DEVELOPMENT_PASSWORD",
        credentialVersion: 1,
        absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    });
    return {
      cookie: `taven_admin=${token}`,
      csrfToken,
      operatorId: identity.id,
    };
  }

  async function drainSlicing(expectedAtLeast: number): Promise<void> {
    let reconciled = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await publisher.publishPending(100);
      reconciled += await publisher.reconcileCompleted(100);
      if (reconciled >= expectedAtLeast) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `fixture worker did not reconcile ${expectedAtLeast} slicing dispatches on ${slicingQueueName}`,
    );
  }
});

function success<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (
    result.response.status >= 300 ||
    result.error !== undefined ||
    result.data === undefined
  ) {
    throw new Error(
      `unexpected API response ${result.response.status}: ${JSON.stringify(result.error)}`,
    );
  }
  return result.data;
}

function commandKey(name: string): string {
  return `v0-lifecycle-${name}-${randomUUID()}`;
}

function operatorHeaders(csrfToken: string, name: string) {
  return {
    "x-csrf-token": csrfToken,
    "Idempotency-Key": commandKey(name),
  };
}

function providerEvidence(prefix: string, shipmentId: string) {
  return {
    providerEventId: `${prefix}-${shipmentId}`,
    providerTransactionId: `${prefix}-transaction-${shipmentId}`,
    occurredAt: new Date().toISOString(),
    reason: `${prefix} recorded by the named v0 lifecycle operator`,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function binaryStl(): Uint8Array {
  const bytes = new Uint8Array(84);
  new DataView(bytes.buffer).setUint32(80, 0, true);
  return bytes;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
