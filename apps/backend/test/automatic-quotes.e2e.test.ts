import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CandidateEstimateJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { CandidateEstimateService } from "../src/modules/resources/candidate-estimate.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { PersistenceFactory } from "./support/persistence-factory";

const quoteCapabilityKey =
  "test-automatic-quote-capability-key-at-least-32-characters";
process.env.TAVEN_QUOTE_CAPABILITY_KEY ??= quoteCapabilityKey;
process.env.TAVEN_DELIVERY_ENDPOINTS_JSON ??= JSON.stringify([
  {
    providerEndpointId: "test-pickup",
    endpointType: "pickup_point",
    supportedCategoryIds: ["pickup", "oversize"],
    provider: "test",
  },
  {
    providerEndpointId: "test-zbox",
    endpointType: "pickup_point",
    supportedCategoryIds: ["zbox"],
    provider: "test",
  },
  {
    providerEndpointId: "test-incompatible",
    endpointType: "pickup_point",
    supportedCategoryIds: ["not-a-priced-category"],
    provider: "test",
  },
]);
process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION ??= "us-east-1";
process.env.TAVEN_S3_BUCKET ??= "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID ??= "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??=
  "test-automatic-upload-client-hash-key-at-least-32";

const databaseUrl = process.env.DATABASE_URL;
const scope = `automatic-quotes-${randomUUID()}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!databaseUrl)("automatic quote lifecycle", () => {
  let app: INestApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let candidates: CandidateEstimateService;
  let pool: Pool;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = new URL(await app.getUrl());
    prisma = app.get(PrismaService);
    candidates = app.get(CandidateEstimateService);
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  }, 30_000);

  it("resumes a quote through binding, complete reservation, and endpoint replacement", async () => {
    const sql = await pool.connect();
    const factory = new PersistenceFactory(sql, `${scope}:happy`);
    await sql.query("BEGIN");
    const foundation = await factory
      .createFoundation(
        "resources",
        { deleteAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000) },
        undefined,
        undefined,
        undefined,
        1,
        [{ color: "red", quantity: 1 }],
      )
      .then(async (created) => {
        await sql.query("COMMIT");
        return created;
      })
      .catch(async (error: unknown) => {
        await sql.query("ROLLBACK");
        throw error;
      })
      .finally(() => sql.release());
    await prisma.inventory.update({
      where: { id: foundation.inventoryId },
      data: { remainingMilligrams: 1_000_000n },
    });
    const machineProfile = await prisma.machineProfile.findUniqueOrThrow({
      where: { id: foundation.machineProfileId },
    });
    const printConfig = await prisma.printConfigRevision.findUniqueOrThrow({
      where: { id: foundation.printConfigRevisionId },
    });
    expect(printConfig.infillPercent).toBe(20);
    const modelFileId = randomUUID();
    const modelFile = await prisma.modelFile.create({
      data: {
        id: modelFileId,
        format: "STL",
        originalFilename: "assembly.stl",
        storageObjectKey: `models/${modelFileId}/source`,
        contentHash: sha(`${scope}:assembly`),
        sizeBytes: 1n,
        uploadedAt: new Date(),
        sourceDeleteAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
      },
    });

    const uploadToken = randomBytes(32).toString("base64url");
    await prisma.uploadIntent.create({
      data: {
        assetKind: "MODEL_FILE",
        capabilityTokenHash: sha(uploadToken),
        originalFilename: "assembly.stl",
        modelFormat: "STL",
        intendedAssetId: modelFile.id,
        expectedContentType: "model/stl",
        expectedSizeBytes: 1n,
        expectedContentHash: modelFile.contentHash,
        quarantineObjectKey: `${scope}/quarantine/assembly.stl`,
        finalObjectKey: `${scope}/models/assembly.stl`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        status: "CONFIRMED",
        confirmedModelFileId: modelFile.id,
        confirmedAt: new Date(),
      },
    });

    const created = await api("automatic-quote-sessions", {
      method: "POST",
      headers: jsonHeaders(key("create")),
      body: JSON.stringify({ attribution: { campaign: "e2e" } }),
    });
    expect(created.response.status).toBe(201);
    const sessionId = string(created.body.sessionId);
    const sessionToken = string(created.body.sessionToken);
    const orderId = string(created.body.orderId);

    const previousCapabilityKeys =
      process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS;
    process.env.TAVEN_QUOTE_CAPABILITY_KEY =
      "test-rotated-automatic-quote-capability-key-at-least-32";
    process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS = JSON.stringify([
      quoteCapabilityKey,
    ]);
    try {
      const replayed = await api("automatic-quote-sessions", {
        method: "POST",
        headers: jsonHeaders(key("create")),
        body: JSON.stringify({ attribution: { campaign: "e2e" } }),
      });
      expect(replayed.response.status).toBe(201);
      expect(replayed.body.sessionId).toBe(sessionId);
      expect(replayed.body.sessionToken).toBe(sessionToken);
    } finally {
      process.env.TAVEN_QUOTE_CAPABILITY_KEY = quoteCapabilityKey;
      if (previousCapabilityKeys === undefined) {
        delete process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS;
      } else {
        process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS =
          previousCapabilityKeys;
      }
    }

    const attached = await api(
      `automatic-quote-sessions/${sessionId}/model-files`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("attach")),
        body: JSON.stringify({
          modelFileId: modelFile.id,
          uploadToken,
        }),
      },
    );
    expect(attached.response.status).toBe(200);
    expect(attached.body.phase).toBe("INSPECTION_PENDING");
    const attachedReplay = await api(
      `automatic-quote-sessions/${sessionId}/model-files`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("attach")),
        body: JSON.stringify({
          modelFileId: modelFile.id,
          uploadToken,
        }),
      },
    );
    expect(attachedReplay.response.status).toBe(200);

    const automaticFile = await prisma.automaticQuoteModelFile.findFirstOrThrow(
      {
        where: {
          draft: { order: { automaticOrigin: { quoteSessionId: sessionId } } },
        },
      },
    );
    expect(
      await prisma.outboxMessage.count({
        where: {
          aggregateId: automaticFile.inspectionJobId,
          messageType: "slicing.model-inspection.requested",
        },
      }),
    ).toBe(1);
    const inspectionDispatch = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        aggregateId: automaticFile.inspectionJobId,
        messageType: "slicing.model-inspection.requested",
      },
    });
    await prisma.outboxMessage.create({
      data: {
        deduplicationKey: `${scope}:inspection-result`,
        aggregateType: "SlicingDispatchResult",
        aggregateId: inspectionDispatch.id,
        messageType: "slicing.model_inspection.result-received",
        schemaVersion: 2,
        payload: {
          result: {
            outcome: {
              status: "succeeded",
              bodies: [
                { bodyId: "body-a" },
                { bodyId: "body-b" },
                { bodyId: "body-c" },
              ],
            },
          },
        },
      },
    });

    const configure = async (
      ordinal: number,
      bodyId: string,
      quantity: number,
      command: string,
    ) =>
      api(
        `automatic-quote-sessions/${sessionId}/items/${ordinal}/configuration`,
        {
          method: "PUT",
          headers: capabilityHeaders(sessionToken, key(command)),
          body: JSON.stringify({
            modelFileId: modelFile.id,
            bodyIds: [bodyId],
            printConfigRevisionId: foundation.printConfigRevisionId,
            material: "PLA",
            color: "red",
            infillPreset: "STANDARD",
            quantity,
            preferredPartsPerPlate: 1,
            fitSensitive: ordinal === 1,
          }),
        },
      );
    const draftItem = (ordinal: number) =>
      prisma.automaticQuoteItemDraft.findFirstOrThrow({
        where: {
          draft: { order: { automaticOrigin: { quoteSessionId: sessionId } } },
          ordinal,
        },
      });
    const { buildReferenceSliceCacheKey, RevisionRef, Sha256Digest } =
      await import("@taven/core");
    const seedReference = async (
      draft: Awaited<ReturnType<typeof draftItem>>,
      bodyId: string,
      marker: string,
    ) => {
      const geometryHash = sha(`${scope}:geometry:${marker}`);
      await prisma.modelGeometry.create({
        data: {
          id: draft.targetModelGeometryId,
          sourceModelFileId: modelFile.id,
          sourceSelector: JSON.stringify({ bodyIds: [bodyId] }),
          canonicalObjectKey: `geometries/${draft.targetModelGeometryId}/canonical`,
          geometryHash,
          canonicalizerRevision: "canonical-v1",
          volumeCubicMicrometers: 8_000_000_000_000n,
          boundsXMicrometers: 20_000n,
          boundsYMicrometers: 20_000n,
          boundsZMicrometers: 20_000n,
          triangleCount: 12,
        },
      });
      const cacheKey = buildReferenceSliceCacheKey({
        geometryHash: Sha256Digest.parse(geometryHash),
        modelGeometryId: draft.targetModelGeometryId,
        geometrySelectionHash: Sha256Digest.parse(draft.selectionSha256),
        referenceProfileRevision: RevisionRef.create(
          "reference-profile",
          draft.referenceProfileId,
        ),
        printConfigRevision: RevisionRef.create(
          "print-config",
          draft.printConfigRevisionId,
        ),
        partsPerPlate: 1,
      });
      await prisma.sliceResult.create({
        data: {
          kind: "REFERENCE",
          cacheKey,
          modelGeometryId: draft.targetModelGeometryId,
          printConfigRevisionId: draft.printConfigRevisionId,
          referenceProfileId: draft.referenceProfileId,
          partsPerPlate: 1,
          artifactObjectKey: `${scope}/reference/${marker}.json`,
          artifactHash: sha(`${scope}:reference:${marker}`),
          estimatedPrintSeconds: 60n,
          estimatedMaterialMilligrams: 60n,
          slicerEngine: machineProfile.slicerEngine,
          slicerVersion: machineProfile.slicerVersion,
        },
      });
    };

    expect(
      (await configure(0, "body-a", 1, "configure-stale")).response.status,
    ).toBe(200);
    const staleDraft = await draftItem(0);
    for (const command of ["stale-dispatch", "stale-dispatch-replay"]) {
      expect(
        (
          await api(`automatic-quote-sessions/${sessionId}/prepare`, {
            method: "POST",
            headers: capabilityHeaders(sessionToken, key(command)),
          })
        ).response.status,
      ).toBe(200);
    }
    expect(
      await prisma.outboxMessage.count({
        where: {
          messageType: "slicing.model-inspection.requested",
          AND: [
            { payload: { path: ["job", "correlationId"], equals: orderId } },
            {
              payload: {
                path: ["job", "input", "operation", "mode"],
                equals: "canonicalize_selection",
              },
            },
          ],
        },
      }),
    ).toBe(1);

    expect(
      (await configure(0, "body-b", 1, "configure-current-0")).response.status,
    ).toBe(200);
    await seedReference(staleDraft, "body-a", "stale");
    const staleResult = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("stale-result")),
      },
    );
    expect(staleResult.response.status).toBe(200);
    expect(staleResult.body.phase).toBe("REFERENCE_SLICES_PENDING");
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(0);

    expect(
      (await configure(1, "body-c", 2, "configure-current-1")).response.status,
    ).toBe(200);
    await seedReference(await draftItem(0), "body-b", "current-0");
    await seedReference(await draftItem(1), "body-c", "current-1");

    const rough = await api(`automatic-quote-sessions/${sessionId}/prepare`, {
      method: "POST",
      headers: capabilityHeaders(sessionToken, key("rough")),
    });
    expect(rough.response.status).toBe(200);
    expect(rough.body.roughEstimate).toMatchObject({
      kind: "ROUGH_ESTIMATE",
      currency: "CZK",
    });
    expect(rough.body.bindingQuote).toBeNull();
    expect(rough.body.phase).toBe("DESTINATION_REQUIRED");
    expect(
      await prisma.outboxMessage.count({
        where: {
          messageType: "slicing.reference-slice.requested",
          payload: { path: ["job", "correlationId"], equals: orderId },
        },
      }),
    ).toBe(0);

    const expressRejected = await api(
      `automatic-quote-sessions/${sessionId}/express`,
      {
        method: "PUT",
        headers: capabilityHeaders(sessionToken, key("express-rejected")),
        body: JSON.stringify({ requested: true }),
      },
    );
    expect(expressRejected.response.status).toBe(200);
    expect(expressRejected.body.express).toMatchObject({
      requested: true,
      eligible: false,
      reasons: expect.arrayContaining(["TOO_MANY_PLATES"]),
    });
    expect(expressRejected.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["EXPRESS_INELIGIBLE"]),
    });
    expect(
      (
        await api(`automatic-quote-sessions/${sessionId}/express`, {
          method: "PUT",
          headers: capabilityHeaders(sessionToken, key("express-reset")),
          body: JSON.stringify({ requested: false }),
        })
      ).response.status,
    ).toBe(200);
    expect(
      (await configure(1, "body-c", 1, "configure-normalized-1")).response
        .status,
    ).toBe(200);

    const incompatibleDestination = await api(
      `automatic-quote-sessions/${sessionId}/delivery-destination`,
      {
        method: "PUT",
        headers: capabilityHeaders(
          sessionToken,
          key("destination-incompatible"),
        ),
        body: JSON.stringify({
          providerEndpointId: "test-incompatible",
          endpointType: "pickup_point",
          address: { country: "CZ", city: "Prague" },
        }),
      },
    );
    expect(incompatibleDestination.response.status).toBe(200);
    const incompatible = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("incompatible-prepare")),
      },
    );
    expect(incompatible.response.status).toBe(200);
    expect(incompatible.body.checkoutReady).toBe(false);
    expect(incompatible.body.bindingQuote).toBeNull();
    expect(incompatible.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["SHIPMENT_INELIGIBLE"]),
    });
    expect(await prisma.orderPriceBinding.count({ where: { orderId } })).toBe(
      0,
    );

    const destination = await api(
      `automatic-quote-sessions/${sessionId}/delivery-destination`,
      {
        method: "PUT",
        headers: capabilityHeaders(sessionToken, key("destination")),
        body: JSON.stringify({
          providerEndpointId: "test-pickup",
          endpointType: "pickup_point",
          address: { country: "CZ", city: "Prague" },
        }),
      },
    );
    expect(destination.response.status).toBe(200);

    const staged = await api(`automatic-quote-sessions/${sessionId}/prepare`, {
      method: "POST",
      headers: capabilityHeaders(sessionToken, key("stage")),
    });
    expect(staged.response.status).toBe(200);
    expect(staged.body.checkoutReady).toBe(false);
    expect(staged.body.bindingQuote).toBeNull();

    const firstBinding = await prisma.orderActivePriceBinding.findUniqueOrThrow(
      {
        where: { orderId },
      },
    );
    const candidateDispatches = await prisma.outboxMessage.findMany({
      where: {
        aggregateType: "CandidateEstimateDispatch",
        messageType: "slicing.candidate-estimate.requested",
        AND: [
          { payload: { path: ["job", "correlationId"], equals: orderId } },
          { payload: { path: ["nodeId"], equals: foundation.nodeId } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    expect(candidateDispatches).toHaveLength(2);
    const capacityBase = Date.now() + 60_000;
    for (const [index, dispatch] of candidateDispatches.entries()) {
      const payload = dispatch.payload as unknown as {
        job: CandidateEstimateJob;
      };
      const job = payload.job;
      const startsAt = new Date(capacityBase + index * 120_000);
      const endsAt = new Date(startsAt.getTime() + 60_000);
      const result = {
        ...job,
        engine: { name: "orca", version: "test", imageSha256: "b".repeat(64) },
        outcome: {
          status: "succeeded" as const,
          metrics: {
            boundingBox: {
              xMicrometers: "20000",
              yMicrometers: "20000",
              zMicrometers: "20000",
            },
            objectCount: 1,
            bodyCount: 1,
            topology: {
              watertight: true,
              manifold: true,
              normals: "consistent" as const,
            },
            thinWallFeatureCount: 0,
            supportVolumeRatioPpm: 0,
            hasPaintAssignments: false,
            materialAssignmentCount: 0,
            estimatedPrintSeconds: "60",
            estimatedMaterialMilligrams: "60",
            plateCount: 1,
          },
          plates: [
            {
              plateOrdinal: 1,
              partsOnPlate: 1,
              estimatedPrintSeconds: "60",
              estimatedMaterialMilligrams: "60",
            },
          ],
          occupancySlices: job.input.occupancySliceTargets.map((target) => ({
            partsPerPlate: target.partsPerPlate,
            cacheIdentitySha256: target.cacheIdentitySha256,
            estimatedPrintSeconds: "60",
            estimatedMaterialMilligrams: "60",
            artifact: {
              objectKey: target.analysisObjectKey,
              sha256: sha(target.analysisObjectKey),
            },
          })),
        },
      };
      await candidates.ingest({
        result,
        capacityWindows: [{ startsAt, endsAt }],
        expiresAt: new Date(Date.now() + 25 * 60_000),
      });
    }

    const ready = await api(`automatic-quote-sessions/${sessionId}/prepare`, {
      method: "POST",
      headers: capabilityHeaders(sessionToken, key("finalize")),
    });
    expect(ready.response.status).toBe(200);
    expect(ready.body.phase).toBe("CHECKOUT_READY");
    expect(ready.body.checkoutReady).toBe(true);
    expect(ready.body.bindingQuote).toMatchObject({
      kind: "BINDING",
      currency: "CZK",
    });
    const binding = ready.body.bindingQuote as {
      totalMinor: number;
      components: Array<{ amountMinor: number }>;
    };
    expect(
      binding.components.reduce(
        (sum, component) => sum + component.amountMinor,
        0,
      ),
    ).toBe(binding.totalMinor);

    const replay = await api(`automatic-quote-sessions/${sessionId}/prepare`, {
      method: "POST",
      headers: capabilityHeaders(sessionToken, key("finalize-replay")),
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body.checkoutReady).toBe(true);
    expect(await prisma.orderPriceBinding.count({ where: { orderId } })).toBe(
      1,
    );
    expect(
      await prisma.phaseReservationSet.count({
        where: {
          phaseResourcePlan: {
            eligibilitySnapshot: { orderPhase: { orderId } },
          },
        },
      }),
    ).toBe(1);
    expect(await prisma.orderPhase.count({ where: { orderId } })).toBe(1);
    expect(await prisma.fulfilmentSlot.count({ where: { orderId } })).toBe(2);
    expect(
      await prisma.outboxMessage.count({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          AND: [
            { payload: { path: ["job", "correlationId"], equals: orderId } },
            { payload: { path: ["nodeId"], equals: foundation.nodeId } },
          ],
        },
      }),
    ).toBe(2);
    const firstReservation = await prisma.phaseReservationSet.findFirstOrThrow({
      where: {
        phaseResourcePlan: {
          eligibilitySnapshot: { orderPhase: { orderId } },
        },
      },
    });

    const changed = await api(
      `automatic-quote-sessions/${sessionId}/delivery-destination`,
      {
        method: "PUT",
        headers: capabilityHeaders(sessionToken, key("destination-change")),
        body: JSON.stringify({
          providerEndpointId: "test-zbox",
          endpointType: "pickup_point",
          address: { country: "CZ", city: "Brno" },
        }),
      },
    );
    expect(changed.response.status).toBe(200);
    expect(changed.body.checkoutReady).toBe(false);
    expect(changed.body.bindingQuote).toBeNull();
    await expect(
      prisma.phaseReservationSet.findUniqueOrThrow({
        where: { id: firstReservation.id },
      }),
    ).resolves.toMatchObject({ status: "RELEASED" });

    const restaged = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("restage")),
      },
    );
    expect(restaged.response.status).toBe(200);
    const replacement = await prisma.orderActivePriceBinding.findUniqueOrThrow({
      where: { orderId },
    });
    expect(replacement.orderPriceBindingId).not.toBe(
      firstBinding.orderPriceBindingId,
    );
    await expect(
      prisma.orderPriceBinding.findUniqueOrThrow({
        where: { id: firstBinding.orderPriceBindingId },
      }),
    ).resolves.toMatchObject({ invalidatedAt: expect.any(Date) });
  }, 120_000);

  it("surfaces unsupported 3MF worker results without duplicate quote work", async () => {
    const modelFileId = randomUUID();
    const modelFile = await prisma.modelFile.create({
      data: {
        id: modelFileId,
        format: "THREE_MF",
        originalFilename: "painted.3mf",
        storageObjectKey: `models/${modelFileId}/source`,
        contentHash: sha(`${scope}:painted`),
        sizeBytes: 1n,
        uploadedAt: new Date(),
        sourceDeleteAfter: new Date(Date.now() + 60 * 60 * 1_000),
      },
    });
    const uploadToken = randomBytes(32).toString("base64url");
    await prisma.uploadIntent.create({
      data: {
        assetKind: "MODEL_FILE",
        capabilityTokenHash: sha(uploadToken),
        originalFilename: "painted.3mf",
        modelFormat: "THREE_MF",
        intendedAssetId: modelFile.id,
        expectedContentType:
          "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
        expectedSizeBytes: 1n,
        expectedContentHash: modelFile.contentHash,
        quarantineObjectKey: `${scope}/quarantine/painted.3mf`,
        finalObjectKey: `${scope}/final/painted.3mf`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        status: "CONFIRMED",
        confirmedModelFileId: modelFile.id,
        confirmedAt: new Date(),
      },
    });
    const created = await api("automatic-quote-sessions", {
      method: "POST",
      headers: jsonHeaders(key("3mf-create")),
      body: "{}",
    });
    const sessionId = string(created.body.sessionId);
    const sessionToken = string(created.body.sessionToken);
    const attached = await api(
      `automatic-quote-sessions/${sessionId}/model-files`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("3mf-attach")),
        body: JSON.stringify({ modelFileId: modelFile.id, uploadToken }),
      },
    );
    expect(attached.response.status).toBe(200);
    const automaticFile = await prisma.automaticQuoteModelFile.findFirstOrThrow(
      {
        where: {
          draft: { order: { automaticOrigin: { quoteSessionId: sessionId } } },
        },
      },
    );
    const dispatch = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        aggregateId: automaticFile.inspectionJobId,
        messageType: "slicing.model-inspection.requested",
      },
    });
    await prisma.outboxMessage.create({
      data: {
        deduplicationKey: `${scope}:3mf-unsupported-result`,
        aggregateType: "SlicingDispatchResult",
        aggregateId: dispatch.id,
        messageType: "slicing.model_inspection.result-received",
        schemaVersion: 2,
        payload: {
          result: {
            outcome: {
              status: "failed",
              failureClass: "unsupported_input",
              code: "PAINTED_OR_MULTIMATERIAL",
              retryable: false,
              message: "Painted geometry requires an individual offer",
              retryAfterMilliseconds: null,
            },
          },
        },
      },
    });

    for (const command of ["3mf-prepare", "3mf-prepare-replay"]) {
      const result = await api(
        `automatic-quote-sessions/${sessionId}/prepare`,
        {
          method: "POST",
          headers: capabilityHeaders(sessionToken, key(command)),
        },
      );
      expect(result.response.status).toBe(200);
      expect(result.body.phase).toBe("HANDOFF_REQUIRED");
      expect(result.body.modelFiles).toEqual([
        expect.objectContaining({ inspectionStatus: "UNSUPPORTED" }),
      ]);
      expect(result.body.handoff).toMatchObject({
        reasons: expect.arrayContaining(["UNSUPPORTED_FORMAT"]),
      });
    }
    expect(
      await prisma.outboxMessage.count({
        where: {
          aggregateId: automaticFile.inspectionJobId,
          messageType: "slicing.model-inspection.requested",
        },
      }),
    ).toBe(1);
  });

  it("reports expiry and rejects further commands without quote artifacts", async () => {
    const created = await api("automatic-quote-sessions", {
      method: "POST",
      headers: jsonHeaders(key("expiry-create")),
      body: "{}",
    });
    const sessionId = string(created.body.sessionId);
    const sessionToken = string(created.body.sessionToken);
    const orderId = string(created.body.orderId);
    const expiredNow = new Date(string(created.body.expiresAt)).getTime() + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiredNow);
    try {
      const expired = await api(`automatic-quote-sessions/${sessionId}`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(expired.response.status).toBe(200);
      expect(expired.body.phase).toBe("EXPIRED");
      const rejected = await api(
        `automatic-quote-sessions/${sessionId}/express`,
        {
          method: "PUT",
          headers: capabilityHeaders(sessionToken, key("expiry-mutation")),
          body: JSON.stringify({ requested: true }),
        },
      );
      expect(rejected.response.status).toBe(410);
      expect(await prisma.orderPriceBinding.count({ where: { orderId } })).toBe(
        0,
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("returns a machine-readable handoff for STEP without queue work", async () => {
    const modelFile = await prisma.modelFile.create({
      data: {
        format: "STEP",
        originalFilename: "unsupported.step",
        storageObjectKey: `${scope}/unsupported.step`,
        contentHash: sha(`${scope}:unsupported`),
        sizeBytes: 1n,
        uploadedAt: new Date(),
        sourceDeleteAfter: new Date(Date.now() + 60 * 60 * 1_000),
      },
    });
    const uploadToken = randomBytes(32).toString("base64url");
    await prisma.uploadIntent.create({
      data: {
        assetKind: "MODEL_FILE",
        capabilityTokenHash: sha(uploadToken),
        originalFilename: "unsupported.step",
        modelFormat: "STEP",
        intendedAssetId: modelFile.id,
        expectedContentType: "model/step",
        expectedSizeBytes: 1n,
        expectedContentHash: modelFile.contentHash,
        quarantineObjectKey: `${scope}/quarantine/unsupported.step`,
        finalObjectKey: `${scope}/final/unsupported.step`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        status: "CONFIRMED",
        confirmedModelFileId: modelFile.id,
        confirmedAt: new Date(),
      },
    });
    const created = await api("automatic-quote-sessions", {
      method: "POST",
      headers: jsonHeaders(key("step-create")),
      body: "{}",
    });
    const sessionId = string(created.body.sessionId);
    const sessionToken = string(created.body.sessionToken);
    const attached = await api(
      `automatic-quote-sessions/${sessionId}/model-files`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("step-attach")),
        body: JSON.stringify({ modelFileId: modelFile.id, uploadToken }),
      },
    );

    expect(attached.response.status).toBe(200);
    expect(attached.body.phase).toBe("HANDOFF_REQUIRED");
    expect(attached.body.handoff).toMatchObject({
      kind: "INDIVIDUAL_QUOTE_REQUEST",
      reasons: ["UNSUPPORTED_FORMAT"],
    });
    expect(
      await prisma.outboxMessage.count({
        where: {
          aggregateId: modelFile.id,
          messageType: "slicing.model-inspection.requested",
        },
      }),
    ).toBe(0);
  });

  async function api(path: string, init: RequestInit) {
    const response = await fetch(new URL(path, baseUrl), init);
    const body = (await response.json()) as Record<string, unknown>;
    return { response, body };
  }
});

function key(name: string): string {
  return `${scope}:${name}`;
}

function jsonHeaders(idempotencyKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
}

function capabilityHeaders(
  token: string,
  idempotencyKey: string,
): Record<string, string> {
  return {
    ...jsonHeaders(idempotencyKey),
    authorization: `Bearer ${token}`,
  };
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}
