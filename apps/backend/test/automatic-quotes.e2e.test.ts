import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import type {
  CandidateEstimateJob,
  CandidateEstimateResult,
} from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AppModule } from "../src/app.module";
import { AutomaticQuotesService } from "../src/modules/automatic-quotes/automatic-quotes.service";
import { CandidateEstimateService } from "../src/modules/resources/candidate-estimate.service";
import { EligibilityPlanService } from "../src/modules/resources/eligibility-plan.service";
import { ResourceReservationService } from "../src/modules/resources/resource-reservation.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { PersistenceFactory } from "./support/persistence-factory";

const quoteCapabilityKey =
  "test-automatic-quote-capability-key-at-least-32-characters";
const localAutomaticQuoteSubjectHash = createHmac("sha256", quoteCapabilityKey)
  .update("anonymous-automatic-quote\0" + "127.0.0.1")
  .digest("hex");
process.env.TAVEN_QUOTE_CAPABILITY_KEY ??= quoteCapabilityKey;
process.env.TAVEN_DELIVERY_ENDPOINTS_JSON ??= JSON.stringify([
  {
    providerEndpointId: "test-pickup",
    endpointType: "pickup_point",
    addressSnapshot: { country: "CZ", city: "Prague", label: "Test pickup" },
    supportedCategoryIds: ["pickup", "oversize"],
    provider: "test",
  },
  {
    providerEndpointId: "test-zbox",
    endpointType: "pickup_point",
    addressSnapshot: { country: "CZ", city: "Brno", label: "Test Z-BOX" },
    supportedCategoryIds: ["zbox"],
    provider: "test",
  },
  {
    providerEndpointId: "test-incompatible",
    endpointType: "pickup_point",
    addressSnapshot: {
      country: "CZ",
      city: "Ostrava",
      label: "Test incompatible endpoint",
    },
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
const inspectedBody = (bodyId: string) => ({
  bodyId,
  boundingBox: {
    xMicrometers: "20000",
    yMicrometers: "20000",
    zMicrometers: "20000",
  },
  volumeCubicMicrometers: "8000000000000",
});

describe.skipIf(!databaseUrl)("automatic quote lifecycle", () => {
  let app: INestApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let automaticQuotes: AutomaticQuotesService;
  let candidates: CandidateEstimateService;
  let eligibilityPlans: EligibilityPlanService;
  let resourceReservations: ResourceReservationService;
  let pool: Pool;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = new URL(await app.getUrl());
    prisma = app.get(PrismaService);
    automaticQuotes = app.get(AutomaticQuotesService);
    candidates = app.get(CandidateEstimateService);
    eligibilityPlans = app.get(EligibilityPlanService);
    resourceReservations = app.get(ResourceReservationService);
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  }, 30_000);

  afterEach(async () => {
    await prisma.anonymousQuoteLimit.deleteMany({
      where: { subjectHash: localAutomaticQuoteSubjectHash },
    });
  });

  it("binds create-session idempotency replay to the initiating client", async () => {
    const idempotencyKey = key("client-bound-create");
    const body = { attribution: { campaign: "client-bound" } };
    const created = await automaticQuotes.createSession(
      body,
      "198.51.100.10",
      idempotencyKey,
    );
    const replayed = await automaticQuotes.createSession(
      body,
      "::ffff:198.51.100.10",
      idempotencyKey,
    );
    expect(replayed.sessionId).toBe(created.sessionId);
    expect(replayed.sessionToken).toBe(created.sessionToken);
    await expect(
      automaticQuotes.createSession(body, "198.51.100.11", idempotencyKey),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("limits anonymous session creation atomically before persisting quote work", async () => {
    const subjectHash = localAutomaticQuoteSubjectHash;
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
    const attempts = ["first", "second"].map((attempt) => ({
      idempotencyKey: key(`limited-create-${attempt}`),
      forwardedFor: attempt === "first" ? "203.0.113.44" : "198.51.100.22",
    }));
    const results = await Promise.all(
      attempts.map(({ idempotencyKey, forwardedFor }) =>
        api("automatic-quote-sessions", {
          method: "POST",
          headers: {
            ...jsonHeaders(idempotencyKey),
            "x-forwarded-for": forwardedFor,
          },
          body: "{}",
        }),
      ),
    );
    expect(results.map(({ response }) => response.status).sort()).toEqual([
      201, 429,
    ]);
    expect(
      await prisma.anonymousQuoteLimit.findUniqueOrThrow({
        where: { subjectHash },
        select: { issuedCount: true },
      }),
    ).toEqual({ issuedCount: 5 });

    const successfulIndex = results.findIndex(
      ({ response }) => response.status === 201,
    );
    const successful = results[successfulIndex];
    const successfulAttempt = attempts[successfulIndex];
    if (!successful || !successfulAttempt) {
      throw new Error("expected one successful automatic quote session");
    }
    const rejectedAttempt = attempts.find(
      (_, index) => results[index]?.response.status === 429,
    );
    if (!rejectedAttempt) {
      throw new Error("expected one rejected automatic quote session");
    }
    await expect(
      prisma.automaticOrderOrigin.findUniqueOrThrow({
        where: { quoteSessionId: string(successful.body.sessionId) },
        include: { order: { include: { automaticQuoteDraft: true } } },
      }),
    ).resolves.toMatchObject({
      order: { automaticQuoteDraft: expect.any(Object) },
    });
    expect(
      await prisma.idempotencyRecord.findFirst({
        where: {
          namespace: "automatic-quote.create",
          idempotencyKey: rejectedAttempt.idempotencyKey,
        },
      }),
    ).toBeNull();
    const replayed = await api("automatic-quote-sessions", {
      method: "POST",
      headers: jsonHeaders(successfulAttempt.idempotencyKey),
      body: "{}",
    });
    expect(replayed.response.status).toBe(201);
    expect(replayed.body.sessionId).toBe(successful.body.sessionId);
    expect(
      await prisma.anonymousQuoteLimit.findUniqueOrThrow({
        where: { subjectHash },
        select: { issuedCount: true },
      }),
    ).toEqual({ issuedCount: 5 });
  });

  it("binds preparation idempotency to the revision observed under the session lock", async () => {
    const created = await automaticQuotes.createSession(
      {},
      "198.51.100.30",
      key("prepare-revision-create"),
    );
    const draft = await prisma.automaticQuoteDraft.findUniqueOrThrow({
      where: { orderId: created.orderId },
    });
    type AutomaticQuoteLoadHarness = {
      loadSession(sessionId: string): Promise<unknown>;
    };
    const loadHarness = automaticQuotes as unknown as AutomaticQuoteLoadHarness;
    const originalLoadSession = loadHarness.loadSession.bind(loadHarness);
    const loadGap = vi
      .spyOn(loadHarness, "loadSession")
      .mockImplementationOnce(async (sessionId) => {
        const loaded = await originalLoadSession(sessionId);
        await prisma.automaticQuoteDraft.update({
          where: { orderId: created.orderId },
          data: { configurationRevision: { increment: 1 } },
        });
        return loaded;
      });
    const commandKey = key("prepare-revision-race");
    const prepared = await automaticQuotes.prepare(
      created.sessionId,
      `Bearer ${created.sessionToken}`,
      commandKey,
    );
    loadGap.mockRestore();
    expect(prepared.configurationRevision).toBe(
      draft.configurationRevision + 1,
    );
    const replayed = await automaticQuotes.prepare(
      created.sessionId,
      `Bearer ${created.sessionToken}`,
      commandKey,
    );
    expect(replayed.configurationRevision).toBe(prepared.configurationRevision);
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          namespace: "automatic-quote.prepare",
          idempotencyKey: commandKey,
          status: "COMPLETED",
        },
      }),
    ).toBe(1);
  });

  it("resumes a quote through binding, complete reservation, and endpoint replacement", async () => {
    const sql = await pool.connect();
    const factory = new PersistenceFactory(sql, `${scope}:happy`);
    const quoteColor = `red-${scope.slice(-12)}`;
    const splitNodeColor = `blue-${scope.slice(-12)}`;
    await sql.query("BEGIN");
    const foundation = await factory
      .createFoundation(
        "resources",
        { deleteAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000) },
        undefined,
        undefined,
        undefined,
        1,
        [{ color: quoteColor, quantity: 1 }],
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
    const compatibleMachine = await prisma.machine.findUniqueOrThrow({
      where: { id: foundation.machineId },
      include: {
        machineCapability: true,
        calibrations: { where: { state: "ACTIVE" } },
        inventories: { where: { status: "AVAILABLE" } },
      },
    });
    const invalidMachineId = randomUUID();
    const invalidCalibrationId = randomUUID();
    const invalidCapabilityId = randomUUID();
    const invalidProfileId = randomUUID();
    const splitNodeId = randomUUID();
    const splitMachineId = randomUUID();
    const splitCalibrationId = randomUUID();
    const compatibleProfile = await prisma.machineProfile.findUniqueOrThrow({
      where: { id: foundation.machineProfileId },
    });
    const replaceCompatibleProfileFormat = async (
      activeProfileId: string,
      productionArtifactFormat: "BGCODE" | "GCODE_3MF",
    ): Promise<string> => {
      const replacementId = randomUUID();
      const observedAt = new Date();
      await prisma.$transaction(async (transaction) => {
        await transaction.machineProfile.update({
          where: { id: activeProfileId },
          data: { state: "RETIRED", retiredAt: observedAt },
        });
        await transaction.revisionIdentity.create({
          data: {
            id: replacementId,
            kind: "MACHINE_PROFILE",
            digest: sha(
              `${scope}:machine-profile:${replacementId}:${productionArtifactFormat}`,
            ),
          },
        });
        await transaction.machineProfile.create({
          data: {
            id: replacementId,
            machineCapabilityId: compatibleProfile.machineCapabilityId,
            referenceProfileId: compatibleProfile.referenceProfileId,
            material: compatibleProfile.material,
            quality: compatibleProfile.quality,
            nozzleDiameterMicrometers:
              compatibleProfile.nozzleDiameterMicrometers,
            slicerEngine: compatibleProfile.slicerEngine,
            slicerVersion: compatibleProfile.slicerVersion,
            productionArtifactFormat,
            settings: compatibleProfile.settings as Prisma.InputJsonValue,
            state: "ACTIVE",
            activatedAt: observedAt,
          },
        });
      });
      return replacementId;
    };
    const incompatibleNozzle =
      compatibleMachine.installedNozzleMicrometers + 200;
    await prisma.$transaction(async (transaction) => {
      await transaction.machineCapability.create({
        data: {
          id: invalidCapabilityId,
          capabilityKey: `invalid-${scope}`,
          manufacturer: compatibleMachine.machineCapability.manufacturer,
          model: `${compatibleMachine.machineCapability.model}-invalid`,
          buildVolumeXMicrometers:
            compatibleMachine.machineCapability.buildVolumeXMicrometers,
          buildVolumeYMicrometers:
            compatibleMachine.machineCapability.buildVolumeYMicrometers,
          buildVolumeZMicrometers:
            compatibleMachine.machineCapability.buildVolumeZMicrometers,
          supportedNozzleMicrometers: [
            compatibleProfile.nozzleDiameterMicrometers,
            incompatibleNozzle,
          ],
          supportedMaterials:
            compatibleMachine.machineCapability.supportedMaterials,
        },
      });
      await transaction.revisionIdentity.create({
        data: {
          id: invalidProfileId,
          kind: "MACHINE_PROFILE",
          digest: sha(`${scope}:invalid-machine-profile`),
        },
      });
      await transaction.machineProfile.create({
        data: {
          id: invalidProfileId,
          machineCapabilityId: invalidCapabilityId,
          referenceProfileId: compatibleProfile.referenceProfileId,
          material: compatibleProfile.material,
          quality: compatibleProfile.quality,
          nozzleDiameterMicrometers:
            compatibleProfile.nozzleDiameterMicrometers,
          slicerEngine: compatibleProfile.slicerEngine,
          slicerVersion: compatibleProfile.slicerVersion,
          productionArtifactFormat: compatibleProfile.productionArtifactFormat,
          settings: compatibleProfile.settings as Prisma.InputJsonValue,
          state: "ACTIVE",
          activatedAt: new Date(),
        },
      });
      await transaction.machine.create({
        data: {
          id: invalidMachineId,
          nodeId: compatibleMachine.nodeId,
          machineCapabilityId: invalidCapabilityId,
          code: `invalid-${scope.slice(-12)}`,
          displayName: "Incompatible nozzle machine",
          status: "ACTIVE",
          installedNozzleMicrometers: incompatibleNozzle,
        },
      });
      await transaction.revisionIdentity.create({
        data: {
          id: invalidCalibrationId,
          kind: "MACHINE_CALIBRATION",
          digest: sha(`${scope}:invalid-calibration`),
        },
      });
      const calibration = compatibleMachine.calibrations[0];
      if (!calibration) throw new Error("expected an active calibration");
      await transaction.machineCalibration.create({
        data: {
          id: invalidCalibrationId,
          nodeId: compatibleMachine.nodeId,
          machineId: invalidMachineId,
          flowRatioPartsPerMillion: calibration.flowRatioPartsPerMillion,
          xyCompensationMicrometers: calibration.xyCompensationMicrometers,
          elephantFootCompensationMicrometers:
            calibration.elephantFootCompensationMicrometers,
          settings: calibration.settings as Prisma.InputJsonValue,
          state: "ACTIVE",
          activatedAt: new Date(),
        },
      });
      const inventory = compatibleMachine.inventories[0];
      if (!inventory) throw new Error("expected available inventory");
      await transaction.inventory.create({
        data: {
          nodeId: compatibleMachine.nodeId,
          machineId: invalidMachineId,
          sku: `${inventory.sku}-invalid-nozzle`,
          material: inventory.material,
          vendor: inventory.vendor,
          color: inventory.color,
          lotCode: inventory.lotCode,
          priceMinorUnitsNumerator: inventory.priceMinorUnitsNumerator,
          priceMinorUnitsDenominator: inventory.priceMinorUnitsDenominator,
          currency: inventory.currency,
          remainingMilligrams: 1_000_000n,
          status: "AVAILABLE",
        },
      });
      await transaction.node.create({
        data: {
          id: splitNodeId,
          code: `split-${scope.slice(-12)}`,
          name: "Split eligibility node",
          timeZone: "Europe/Prague",
          active: true,
        },
      });
      await transaction.machine.create({
        data: {
          id: splitMachineId,
          nodeId: splitNodeId,
          machineCapabilityId: compatibleMachine.machineCapabilityId,
          code: `split-${scope.slice(-12)}`,
          displayName: "Split eligibility machine",
          status: "ACTIVE",
          installedNozzleMicrometers:
            compatibleMachine.installedNozzleMicrometers,
        },
      });
      await transaction.revisionIdentity.create({
        data: {
          id: splitCalibrationId,
          kind: "MACHINE_CALIBRATION",
          digest: sha(`${scope}:split-calibration`),
        },
      });
      await transaction.machineCalibration.create({
        data: {
          id: splitCalibrationId,
          nodeId: splitNodeId,
          machineId: splitMachineId,
          flowRatioPartsPerMillion: calibration.flowRatioPartsPerMillion,
          xyCompensationMicrometers: calibration.xyCompensationMicrometers,
          elephantFootCompensationMicrometers:
            calibration.elephantFootCompensationMicrometers,
          settings: calibration.settings as Prisma.InputJsonValue,
          state: "ACTIVE",
          activatedAt: new Date(),
        },
      });
      await transaction.inventory.create({
        data: {
          nodeId: splitNodeId,
          machineId: splitMachineId,
          sku: `${inventory.sku}-split-node`,
          material: inventory.material,
          vendor: inventory.vendor,
          color: splitNodeColor,
          lotCode: inventory.lotCode,
          priceMinorUnitsNumerator: inventory.priceMinorUnitsNumerator,
          priceMinorUnitsDenominator: inventory.priceMinorUnitsDenominator,
          currency: inventory.currency,
          remainingMilligrams: 1_000_000n,
          status: "AVAILABLE",
        },
      });
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
                inspectedBody("body-a"),
                inspectedBody("body-b"),
                inspectedBody("body-c"),
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
      fitSensitive = false,
      color = quoteColor,
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
            color,
            infillPreset: "STANDARD",
            quantity,
            preferredPartsPerPlate: 1,
            fitSensitive,
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
      createSlice = true,
    ) => {
      const geometryHash = sha(`${scope}:geometry:${marker}`);
      const referenceProfile = await prisma.referenceProfile.findUniqueOrThrow({
        where: { id: draft.referenceProfileId },
      });
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
      if (createSlice) {
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
            slicerEngine: referenceProfile.slicerEngine,
            slicerVersion: referenceProfile.slicerVersion,
          },
        });
      }
      return { cacheKey, referenceProfile };
    };

    const immediateRough = await configure(0, "body-a", 1, "configure-stale");
    expect(immediateRough.response.status).toBe(200);
    expect(immediateRough.body.phase).toBe("REFERENCE_SLICES_PENDING");
    expect(immediateRough.body.roughEstimate).toMatchObject({
      kind: "ROUGH_ESTIMATE",
      currency: "CZK",
    });
    expect(immediateRough.body.bindingQuote).toBeNull();
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

    const canonicalAttemptOne = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        messageType: "slicing.model-inspection.requested",
        aggregateType: "ModelInspectionDispatch",
        payload: {
          path: ["job", "input", "operation", "mode"],
          equals: "canonicalize_selection",
        },
        AND: [
          { payload: { path: ["job", "correlationId"], equals: orderId } },
          { payload: { path: ["job", "attempt"], equals: 1 } },
        ],
      },
    });
    await prisma.outboxMessage.create({
      data: {
        deduplicationKey: `${scope}:canonical-retryable-result`,
        aggregateType: "SlicingDispatchResult",
        aggregateId: canonicalAttemptOne.id,
        messageType: "slicing.model_inspection.result-received",
        schemaVersion: 2,
        payload: {
          result: {
            outcome: {
              status: "failed",
              failureClass: "retryable_infrastructure",
              retryAfterMilliseconds: 1,
            },
          },
        },
      },
    });
    const canonicalRetryResponses = await Promise.all(
      ["canonical-retry-a", "canonical-retry-b"].map((command) =>
        api(`automatic-quote-sessions/${sessionId}/prepare`, {
          method: "POST",
          headers: capabilityHeaders(sessionToken, key(command)),
        }),
      ),
    );
    expect(
      canonicalRetryResponses.map(({ response }) => response.status),
    ).toEqual([200, 200]);
    const canonicalDispatches = await prisma.outboxMessage.findMany({
      where: {
        aggregateId: canonicalAttemptOne.aggregateId,
        aggregateType: "ModelInspectionDispatch",
        messageType: "slicing.model-inspection.requested",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(canonicalDispatches).toHaveLength(2);
    expect(
      canonicalDispatches.map(
        ({ payload }) => (payload as { job: { attempt: number } }).job.attempt,
      ),
    ).toEqual([1, 2]);
    const canonicalAttemptTwo = canonicalDispatches[1]!;
    expect(canonicalAttemptTwo.availableAt.getTime()).toBeGreaterThanOrEqual(
      canonicalAttemptOne.createdAt.getTime(),
    );
    await prisma.outboxMessage.create({
      data: {
        deduplicationKey: `${scope}:canonical-deterministic-result`,
        aggregateType: "SlicingDispatchResult",
        aggregateId: canonicalAttemptTwo.id,
        messageType: "slicing.model_inspection.result-received",
        schemaVersion: 2,
        payload: {
          result: {
            outcome: {
              status: "failed",
              failureClass: "deterministic_invalid",
              retryAfterMilliseconds: null,
            },
          },
        },
      },
    });
    const canonicalFailure = await api(
      `automatic-quote-sessions/${sessionId}`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );
    expect(canonicalFailure.response.status).toBe(200);
    expect(canonicalFailure.body.phase).toBe("HANDOFF_REQUIRED");
    expect(canonicalFailure.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["PREPROCESSING_FAILED"]),
    });

    const currentConfiguration = await configure(
      0,
      "body-b",
      1,
      "configure-current-0",
    );
    expect(currentConfiguration.response.status).toBe(200);
    expect(currentConfiguration.body.handoff).toBeNull();
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
      (await configure(1, "body-c", 2, "configure-current-1", true)).response
        .status,
    ).toBe(200);
    const currentZeroDraft = await draftItem(0);
    const currentZeroReference = await seedReference(
      currentZeroDraft,
      "body-b",
      "current-0",
      false,
    );
    await seedReference(await draftItem(1), "body-c", "current-1");
    const referenceAttemptOneResponse = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("reference-attempt-one")),
      },
    );
    expect(referenceAttemptOneResponse.response.status).toBe(200);
    const referenceAttemptOne = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        aggregateType: "ReferenceSliceDispatch",
        messageType: "slicing.reference-slice.requested",
        AND: [
          { payload: { path: ["job", "correlationId"], equals: orderId } },
          { payload: { path: ["job", "attempt"], equals: 1 } },
          {
            payload: {
              path: ["job", "input", "geometry", "modelGeometryId"],
              equals: currentZeroDraft.targetModelGeometryId,
            },
          },
        ],
      },
    });
    await prisma.outboxMessage.create({
      data: {
        deduplicationKey: `${scope}:reference-retryable-result`,
        aggregateType: "SlicingDispatchResult",
        aggregateId: referenceAttemptOne.id,
        messageType: "slicing.reference_slice.result-received",
        schemaVersion: 2,
        payload: {
          result: {
            outcome: {
              status: "failed",
              failureClass: "retryable_infrastructure",
              retryAfterMilliseconds: 1,
            },
          },
        },
      },
    });
    const referenceRetryResponses = await Promise.all(
      ["reference-retry-a", "reference-retry-b"].map((command) =>
        api(`automatic-quote-sessions/${sessionId}/prepare`, {
          method: "POST",
          headers: capabilityHeaders(sessionToken, key(command)),
        }),
      ),
    );
    expect(
      referenceRetryResponses.map(({ response }) => response.status),
    ).toEqual([200, 200]);
    const referenceDispatches = await prisma.outboxMessage.findMany({
      where: {
        aggregateId: referenceAttemptOne.aggregateId,
        aggregateType: "ReferenceSliceDispatch",
        messageType: "slicing.reference-slice.requested",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(
      referenceDispatches.map(
        ({ payload }) => (payload as { job: { attempt: number } }).job.attempt,
      ),
    ).toEqual([1, 2]);
    await prisma.outboxMessage.create({
      data: {
        deduplicationKey: `${scope}:reference-deterministic-result`,
        aggregateType: "SlicingDispatchResult",
        aggregateId: referenceDispatches[1]!.id,
        messageType: "slicing.reference_slice.result-received",
        schemaVersion: 2,
        payload: {
          result: {
            outcome: {
              status: "failed",
              failureClass: "deterministic_invalid",
              retryAfterMilliseconds: null,
            },
          },
        },
      },
    });
    const referenceFailure = await api(
      `automatic-quote-sessions/${sessionId}`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );
    expect(referenceFailure.response.status).toBe(200);
    expect(referenceFailure.body.phase).toBe("HANDOFF_REQUIRED");
    expect(referenceFailure.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["PREPROCESSING_FAILED"]),
    });
    await prisma.sliceResult.create({
      data: {
        kind: "REFERENCE",
        cacheKey: currentZeroReference.cacheKey,
        modelGeometryId: currentZeroDraft.targetModelGeometryId,
        printConfigRevisionId: currentZeroDraft.printConfigRevisionId,
        referenceProfileId: currentZeroDraft.referenceProfileId,
        partsPerPlate: 1,
        artifactObjectKey: `${scope}/reference/current-0.json`,
        artifactHash: sha(`${scope}:reference:current-0`),
        estimatedPrintSeconds: 60n,
        estimatedMaterialMilligrams: 60n,
        slicerEngine: currentZeroReference.referenceProfile.slicerEngine,
        slicerVersion: currentZeroReference.referenceProfile.slicerVersion,
      },
    });
    const unselectedSourceFinding = await prisma.preflightFinding.create({
      data: {
        modelFileId: currentZeroDraft.sourceModelFileId,
        modelGeometryId: null,
        inspectionRevision: sha(`${scope}:source-only-revision`),
        code: "UNSELECTED_BODY_INVALID_TOPOLOGY",
        severity: "BLOCKING",
        message: "An unselected source body is invalid",
        evidence: { bodyId: "unselected-body" },
      },
    });
    const selectedGeometryState = await api(
      `automatic-quote-sessions/${sessionId}`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );
    expect(selectedGeometryState.response.status).toBe(200);
    expect(
      (selectedGeometryState.body.items as Array<{ findings: unknown[] }>).some(
        ({ findings }) =>
          findings.some(
            (finding) =>
              (finding as { id?: string }).id === unselectedSourceFinding.id,
          ),
      ),
    ).toBe(false);
    expect(
      (
        selectedGeometryState.body.handoff as {
          reasons?: string[];
        } | null
      )?.reasons ?? [],
    ).not.toContain("BLOCKING_PREFLIGHT_FINDING");

    const fitHandoff = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("fit-handoff")),
      },
    );
    expect(fitHandoff.response.status).toBe(200);
    expect(fitHandoff.body.phase).toBe("HANDOFF_REQUIRED");
    expect(fitHandoff.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["FIT_SENSITIVE"]),
    });
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(0);
    expect(
      (await configure(1, "body-c", 2, "configure-fit-cleared")).response
        .status,
    ).toBe(200);

    const rough = await api(`automatic-quote-sessions/${sessionId}/prepare`, {
      method: "POST",
      headers: capabilityHeaders(sessionToken, key("rough")),
    });
    expect(rough.response.status).toBe(200);
    expect(rough.body.roughEstimate).toMatchObject({
      kind: "ROUGH_ESTIMATE",
      currency: "CZK",
    });
    const provisionalPrice = rough.body.roughEstimate as {
      totalMinor: number;
      components: Array<{ kind: string; amountMinor: number }>;
    };
    expect(
      provisionalPrice.components.some(({ kind }) => kind === "PAYMENT_FEE"),
    ).toBe(false);
    expect(
      provisionalPrice.components.reduce(
        (total, component) => total + component.amountMinor,
        0,
      ),
    ).toBe(provisionalPrice.totalMinor);
    expect(rough.body.bindingQuote).toBeNull();
    expect(rough.body.phase).toBe("DESTINATION_REQUIRED");
    expect(
      await prisma.outboxMessage.count({
        where: {
          messageType: "slicing.reference-slice.requested",
          payload: { path: ["job", "correlationId"], equals: orderId },
        },
      }),
    ).toBe(referenceDispatches.length);

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
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(0);
    expect(await prisma.orderPhase.count({ where: { orderId } })).toBe(0);
    expect(await prisma.fulfilmentSlot.count({ where: { orderId } })).toBe(0);
    expect(
      (await configure(0, "body-b", 1, "configure-after-incompatible")).response
        .status,
    ).toBe(200);

    const destination = await api(
      `automatic-quote-sessions/${sessionId}/delivery-destination`,
      {
        method: "PUT",
        headers: capabilityHeaders(sessionToken, key("destination")),
        body: JSON.stringify({
          providerEndpointId: "test-pickup",
          endpointType: "pickup_point",
          address: { country: "XX", city: "Client-forged address" },
        }),
      },
    );
    expect(destination.response.status).toBe(200);
    const selectedDestination =
      await prisma.deliveryDestination.findFirstOrThrow({
        where: { orderId, providerEndpointId: "test-pickup" },
      });
    expect(selectedDestination).toMatchObject({
      addressSnapshot: {
        country: "CZ",
        city: "Prague",
        label: "Test pickup",
      },
      capabilitySnapshot: {
        provider: "test",
        supportedCategoryIds: ["oversize", "pickup"],
      },
    });
    const destinationRevision = number(destination.body.configurationRevision);
    const configuredEndpoints = process.env.TAVEN_DELIVERY_ENDPOINTS_JSON;
    process.env.TAVEN_DELIVERY_ENDPOINTS_JSON = JSON.stringify([
      {
        providerEndpointId: "test-zbox",
        endpointType: "pickup_point",
        addressSnapshot: {
          country: "CZ",
          city: "Brno",
          label: "Test Z-BOX",
        },
        supportedCategoryIds: ["zbox"],
        provider: "test",
      },
    ]);
    try {
      const destinationReplay = await api(
        `automatic-quote-sessions/${sessionId}/delivery-destination`,
        {
          method: "PUT",
          headers: capabilityHeaders(sessionToken, key("destination")),
          body: JSON.stringify({
            providerEndpointId: "test-pickup",
            endpointType: "pickup_point",
          }),
        },
      );
      expect(destinationReplay.response.status).toBe(200);
      expect(number(destinationReplay.body.configurationRevision)).toBe(
        destinationRevision,
      );
      expect(
        await prisma.deliveryDestination.count({
          where: { orderId, providerEndpointId: "test-pickup" },
        }),
      ).toBe(1);
      await expect(
        prisma.deliveryDestination.findUniqueOrThrow({
          where: { id: selectedDestination.id },
        }),
      ).resolves.toMatchObject({
        addressSnapshot: selectedDestination.addressSnapshot,
        capabilitySnapshot: selectedDestination.capabilitySnapshot,
      });
    } finally {
      if (configuredEndpoints === undefined) {
        delete process.env.TAVEN_DELIVERY_ENDPOINTS_JSON;
      } else {
        process.env.TAVEN_DELIVERY_ENDPOINTS_JSON = configuredEndpoints;
      }
    }

    await prisma.inventory.updateMany({
      where: {
        machineId: compatibleMachine.id,
        color: quoteColor,
        status: "AVAILABLE",
      },
      data: { remainingMilligrams: 100n },
    });
    const splitResourceGate = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("split-resource-gate")),
      },
    );
    expect(splitResourceGate.response.status).toBe(200);
    expect(splitResourceGate.body.checkoutReady).toBe(false);
    expect(splitResourceGate.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["BUILD_LIMIT_EXCEEDED"]),
    });
    expect(await prisma.orderPriceBinding.count({ where: { orderId } })).toBe(
      0,
    );
    await prisma.inventory.updateMany({
      where: {
        machineId: compatibleMachine.id,
        color: quoteColor,
        status: "AVAILABLE",
      },
      data: { remainingMilligrams: 1_000_000n },
    });

    expect(
      (
        await configure(
          1,
          "body-c",
          1,
          "configure-split-node",
          false,
          splitNodeColor,
        )
      ).response.status,
    ).toBe(200);
    const splitNodeGate = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("split-node-gate")),
      },
    );
    expect(splitNodeGate.response.status).toBe(200);
    expect(splitNodeGate.body.checkoutReady).toBe(false);
    expect(splitNodeGate.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["BUILD_LIMIT_EXCEEDED"]),
    });
    expect(await prisma.orderPriceBinding.count({ where: { orderId } })).toBe(
      0,
    );
    expect(
      (
        await configure(
          1,
          "body-c",
          1,
          "configure-shared-node",
          false,
          quoteColor,
        )
      ).response.status,
    ).toBe(200);
    const bgcodeProfileId = await replaceCompatibleProfileFormat(
      compatibleProfile.id,
      "BGCODE",
    );
    const unsupportedArtifactGate = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(
          sessionToken,
          key("unsupported-artifact-gate"),
        ),
      },
    );
    expect(unsupportedArtifactGate.response.status).toBe(200);
    expect(unsupportedArtifactGate.body.checkoutReady).toBe(false);
    expect(await prisma.orderPriceBinding.count({ where: { orderId } })).toBe(
      0,
    );
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(0);
    const gcodeProfileId = await replaceCompatibleProfileFormat(
      bgcodeProfileId,
      "GCODE_3MF",
    );
    const expressCapacity = await api(
      `automatic-quote-sessions/${sessionId}/express`,
      {
        method: "PUT",
        headers: capabilityHeaders(sessionToken, key("express-capacity")),
        body: JSON.stringify({ requested: true }),
      },
    );
    expect(expressCapacity.response.status).toBe(200);
    expect(expressCapacity.body.express).toMatchObject({
      requested: true,
      eligible: true,
    });

    const recoveryPrintConfigId = randomUUID();
    const basePrintConfig = await prisma.printConfigRevision.findUniqueOrThrow({
      where: { id: foundation.printConfigRevisionId },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.revisionIdentity.create({
        data: {
          id: recoveryPrintConfigId,
          kind: "PRINT_CONFIG",
          digest: sha(`${scope}:capacity-recovery-print-config`),
        },
      });
      await transaction.printConfigRevision.create({
        data: {
          id: recoveryPrintConfigId,
          quality: basePrintConfig.quality,
          infillPercent: basePrintConfig.infillPercent,
          layerHeightMicrometers: basePrintConfig.layerHeightMicrometers,
          supportsEnabled: basePrintConfig.supportsEnabled,
          brimEnabled: basePrintConfig.brimEnabled,
          settings: basePrintConfig.settings as Prisma.InputJsonValue,
        },
      });
    });
    await prisma.inventory.updateMany({
      where: {
        machineId: compatibleMachine.id,
        color: quoteColor,
        status: "AVAILABLE",
      },
      data: { remainingMilligrams: 300_000n },
    });
    const recoveryCreated = await api("automatic-quote-sessions", {
      method: "POST",
      headers: jsonHeaders(key("capacity-recovery-create")),
      body: "{}",
    });
    const recoverySessionId = string(recoveryCreated.body.sessionId);
    const recoverySessionToken = string(recoveryCreated.body.sessionToken);
    const recoveryOrderId = string(recoveryCreated.body.orderId);
    expect(
      (
        await api(`automatic-quote-sessions/${recoverySessionId}/model-files`, {
          method: "POST",
          headers: capabilityHeaders(
            recoverySessionToken,
            key("capacity-recovery-attach"),
          ),
          body: JSON.stringify({ modelFileId: modelFile.id, uploadToken }),
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await api(
          `automatic-quote-sessions/${recoverySessionId}/items/0/configuration`,
          {
            method: "PUT",
            headers: capabilityHeaders(
              recoverySessionToken,
              key("capacity-recovery-configure"),
            ),
            body: JSON.stringify({
              modelFileId: modelFile.id,
              bodyIds: ["body-a", "body-b"],
              printConfigRevisionId: recoveryPrintConfigId,
              material: "PLA",
              color: quoteColor,
              infillPreset: "STANDARD",
              quantity: 4,
              preferredPartsPerPlate: 4,
              fitSensitive: false,
            }),
          },
        )
      ).response.status,
    ).toBe(200);
    const recoveryDraft = await prisma.automaticQuoteItemDraft.findFirstOrThrow(
      {
        where: { orderId: recoveryOrderId, ordinal: 0 },
      },
    );
    const recoveryGeometry = await prisma.modelGeometry.create({
      data: {
        id: recoveryDraft.targetModelGeometryId,
        sourceModelFileId: recoveryDraft.sourceModelFileId,
        sourceSelector: JSON.stringify({ bodyIds: ["body-a", "body-b"] }),
        canonicalObjectKey: `geometries/${recoveryDraft.targetModelGeometryId}/canonical`,
        geometryHash: sha(`${scope}:capacity-recovery-geometry`),
        canonicalizerRevision: "canonical-v1",
        volumeCubicMicrometers: 8_000_000_000_000_000n,
        boundsXMicrometers: 200_000n,
        boundsYMicrometers: 200_000n,
        boundsZMicrometers: 200_000n,
        triangleCount: 24,
      },
    });
    const recoveryReferenceProfile =
      await prisma.referenceProfile.findUniqueOrThrow({
        where: { id: recoveryDraft.referenceProfileId },
      });
    const recoveryPrimaryCacheKey = buildReferenceSliceCacheKey({
      geometryHash: Sha256Digest.parse(recoveryGeometry.geometryHash),
      modelGeometryId: recoveryGeometry.id,
      geometrySelectionHash: Sha256Digest.parse(recoveryDraft.selectionSha256),
      referenceProfileRevision: RevisionRef.create(
        "reference-profile",
        recoveryDraft.referenceProfileId,
      ),
      printConfigRevision: RevisionRef.create(
        "print-config",
        recoveryDraft.printConfigRevisionId,
      ),
      partsPerPlate: 4,
    });
    await prisma.sliceResult.create({
      data: {
        kind: "REFERENCE",
        cacheKey: recoveryPrimaryCacheKey,
        modelGeometryId: recoveryGeometry.id,
        printConfigRevisionId: recoveryDraft.printConfigRevisionId,
        referenceProfileId: recoveryDraft.referenceProfileId,
        partsPerPlate: 4,
        artifactObjectKey: `${scope}/reference/capacity-recovery-primary.json`,
        artifactHash: sha(`${scope}:reference:capacity-recovery-primary`),
        estimatedPrintSeconds: 60n,
        estimatedMaterialMilligrams: 320_000n,
        slicerEngine: recoveryReferenceProfile.slicerEngine,
        slicerVersion: recoveryReferenceProfile.slicerVersion,
      },
    });
    expect(
      (
        await api(
          `automatic-quote-sessions/${recoverySessionId}/delivery-destination`,
          {
            method: "PUT",
            headers: capabilityHeaders(
              recoverySessionToken,
              key("capacity-recovery-destination"),
            ),
            body: JSON.stringify({
              providerEndpointId: "test-zbox",
              endpointType: "pickup_point",
            }),
          },
        )
      ).response.status,
    ).toBe(200);
    expect(
      (
        await api(`automatic-quote-sessions/${recoverySessionId}/express`, {
          method: "PUT",
          headers: capabilityHeaders(
            recoverySessionToken,
            key("capacity-recovery-express"),
          ),
          body: JSON.stringify({ requested: true }),
        })
      ).response.status,
    ).toBe(200);
    const recoveryOccupancyPending = await api(
      `automatic-quote-sessions/${recoverySessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(
          recoverySessionToken,
          key("capacity-recovery-occupancy"),
        ),
      },
    );
    expect(recoveryOccupancyPending.response.status).toBe(200);
    expect(recoveryOccupancyPending.body.checkoutReady).toBe(false);
    expect(recoveryOccupancyPending.body.roughEstimate).toMatchObject({
      kind: "ROUGH_ESTIMATE",
      currency: "CZK",
    });
    const recoveryPendingPrice = recoveryOccupancyPending.body
      .roughEstimate as {
      totalMinor: number;
      components: Array<{ kind: string; amountMinor: number }>;
    };
    expect(
      recoveryPendingPrice.components.some(
        ({ kind }) => kind === "PAYMENT_FEE",
      ),
    ).toBe(true);
    expect(
      recoveryPendingPrice.components.reduce(
        (total, component) => total + component.amountMinor,
        0,
      ),
    ).toBe(recoveryPendingPrice.totalMinor);
    expect(
      await prisma.orderItem.count({ where: { orderId: recoveryOrderId } }),
    ).toBe(0);
    expect(
      await prisma.orderPhase.count({ where: { orderId: recoveryOrderId } }),
    ).toBe(0);
    expect(
      await prisma.fulfilmentSlot.count({
        where: { orderId: recoveryOrderId },
      }),
    ).toBe(0);
    expect(
      await prisma.orderPriceBinding.count({
        where: { orderId: recoveryOrderId },
      }),
    ).toBe(0);
    for (const partsPerPlate of [1, 3]) {
      const recoveryParcelReferenceDispatch =
        await prisma.outboxMessage.findFirstOrThrow({
          where: {
            aggregateType: "ReferenceSliceDispatch",
            messageType: "slicing.reference-slice.requested",
            AND: [
              {
                payload: {
                  path: ["job", "correlationId"],
                  equals: recoveryOrderId,
                },
              },
              {
                payload: {
                  path: ["job", "input", "partsPerPlate"],
                  equals: partsPerPlate,
                },
              },
            ],
          },
        });
      const recoveryParcelCacheKey = buildReferenceSliceCacheKey({
        geometryHash: Sha256Digest.parse(recoveryGeometry.geometryHash),
        modelGeometryId: recoveryGeometry.id,
        geometrySelectionHash: Sha256Digest.parse(
          recoveryDraft.selectionSha256,
        ),
        referenceProfileRevision: RevisionRef.create(
          "reference-profile",
          recoveryDraft.referenceProfileId,
        ),
        printConfigRevision: RevisionRef.create(
          "print-config",
          recoveryDraft.printConfigRevisionId,
        ),
        partsPerPlate,
      });
      await prisma.sliceResult.create({
        data: {
          kind: "REFERENCE",
          cacheKey: recoveryParcelCacheKey,
          modelGeometryId: recoveryGeometry.id,
          printConfigRevisionId: recoveryDraft.printConfigRevisionId,
          referenceProfileId: recoveryDraft.referenceProfileId,
          partsPerPlate,
          artifactObjectKey: `${scope}/reference/capacity-recovery-parcel-${partsPerPlate}.json`,
          artifactHash: sha(
            `${scope}:reference:capacity-recovery-parcel:${partsPerPlate}`,
          ),
          estimatedPrintSeconds: 60n,
          estimatedMaterialMilligrams: 60n * BigInt(partsPerPlate),
          slicerEngine: recoveryReferenceProfile.slicerEngine,
          slicerVersion: recoveryReferenceProfile.slicerVersion,
        },
      });
      await prisma.outboxMessage.create({
        data: {
          deduplicationKey: `${scope}:capacity-recovery-reference-result:${partsPerPlate}`,
          aggregateType: "SlicingDispatchResult",
          aggregateId: recoveryParcelReferenceDispatch.id,
          messageType: "slicing.reference_slice.result-received",
          schemaVersion: 2,
          payload: { result: { outcome: { status: "succeeded" } } },
        },
      });
    }
    type AutomaticQuoteDispatchHarness = {
      dispatchAutomaticCandidates(
        orderId: string,
        bindingId: string,
      ): Promise<void>;
    };
    const dispatchHarness =
      automaticQuotes as unknown as AutomaticQuoteDispatchHarness;
    const originalDispatch =
      dispatchHarness.dispatchAutomaticCandidates.bind(dispatchHarness);
    let gapBgcodeProfileId: string | undefined;
    const dispatchGap = vi
      .spyOn(dispatchHarness, "dispatchAutomaticCandidates")
      .mockImplementationOnce(async (candidateOrderId, bindingId) => {
        gapBgcodeProfileId = await replaceCompatibleProfileFormat(
          gcodeProfileId,
          "BGCODE",
        );
        await originalDispatch(candidateOrderId, bindingId);
      });
    const missingResourceHandoff = await api(
      `automatic-quote-sessions/${recoverySessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(
          recoverySessionToken,
          key("capacity-recovery-missing-resource"),
        ),
      },
    );
    dispatchGap.mockRestore();
    expect(missingResourceHandoff.response.status).toBe(200);
    expect(missingResourceHandoff.body).toMatchObject({
      phase: "HANDOFF_REQUIRED",
      checkoutReady: false,
      handoff: {
        reasons: expect.arrayContaining(["CANDIDATE_ESTIMATION_FAILED"]),
      },
    });
    const missingResourceBinding =
      await prisma.orderActivePriceBinding.findUniqueOrThrow({
        where: { orderId: recoveryOrderId },
      });
    expect(
      await prisma.outboxMessage.count({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          payload: {
            path: ["job", "correlationId"],
            equals: recoveryOrderId,
          },
        },
      }),
    ).toBe(0);
    await expect(
      prisma.outboxMessage.findFirstOrThrow({
        where: {
          aggregateType: "AutomaticQuoteEligibilityDisposition",
          aggregateId: missingResourceBinding.orderPriceBindingId,
          messageType: "automatic_quote.candidate-estimation.unusable",
          payload: {
            path: ["reason"],
            equals: "NO_DISPATCHABLE_CANDIDATE_RESOURCES",
          },
        },
      }),
    ).resolves.toBeTruthy();
    if (!gapBgcodeProfileId) {
      throw new Error("expected dispatch-gap profile replacement");
    }
    await replaceCompatibleProfileFormat(gapBgcodeProfileId, "GCODE_3MF");

    const recoveryStaged = await api(
      `automatic-quote-sessions/${recoverySessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(
          recoverySessionToken,
          key("capacity-recovery-stage"),
        ),
      },
    );
    expect(recoveryStaged.response.status).toBe(200);
    expect(recoveryStaged.body.checkoutReady).toBe(false);
    expect(recoveryStaged.body.phase).toBe("ELIGIBILITY_PENDING");
    const recoveryTopology = {
      itemIds: (
        await prisma.orderItem.findMany({
          where: { orderId: recoveryOrderId },
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map(({ id }) => id),
      phaseIds: (
        await prisma.orderPhase.findMany({
          where: { orderId: recoveryOrderId },
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map(({ id }) => id),
      slotIds: (
        await prisma.fulfilmentSlot.findMany({
          where: { orderId: recoveryOrderId },
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map(({ id }) => id),
    };
    const staleExpressBinding =
      await prisma.orderActivePriceBinding.findUniqueOrThrow({
        where: { orderId: recoveryOrderId },
      });
    const staleExpressPlanIds = new Set(
      (
        await prisma.shipmentPlan.findMany({
          where: {
            orderPriceBindingId: staleExpressBinding.orderPriceBindingId,
          },
          select: { id: true },
        })
      ).map(({ id }) => id),
    );
    expect(staleExpressPlanIds.size).toBe(2);
    const lateCapacityBase = Date.now() + 25 * 60 * 60 * 1_000;
    const lateExpressDispatches = (
      await prisma.outboxMessage.findMany({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          payload: {
            path: ["job", "correlationId"],
            equals: recoveryOrderId,
          },
        },
      })
    ).filter(({ payload }) =>
      staleExpressPlanIds.has(candidateJob(payload).input.shipmentPlanId),
    );
    expect(lateExpressDispatches.length).toBeGreaterThan(0);
    expect(
      new Set(
        lateExpressDispatches.map(
          ({ payload }) => candidateJob(payload).input.partsPerPlate,
        ),
      ),
    ).toEqual(new Set([1, 2, 3]));
    for (const [index, dispatch] of lateExpressDispatches.entries()) {
      const job = candidateJob(dispatch.payload);
      if (job.input.partsPerPlate > 1) {
        await candidates.ingest({
          result: deterministicCandidateArrangementResult(job),
        });
        continue;
      }
      const plateCount = Math.ceil(
        job.input.quantity / job.input.partsPerPlate,
      );
      const capacityWindows = Array.from({ length: plateCount }, (_, plate) => {
        const startsAt = new Date(
          lateCapacityBase + index * 600_000 + plate * 120_000,
        );
        return {
          startsAt,
          endsAt: new Date(startsAt.getTime() + 60_000),
        };
      });
      await candidates.ingest({
        result: successfulCandidateResult(job),
        capacityWindows,
        expiresAt: new Date(Date.now() + 26 * 60 * 60 * 1_000),
      });
    }
    const lateCapacityEndsAt = new Date(
      lateCapacityBase + lateExpressDispatches.length * 600_000,
    );
    const lateExpress = await api(
      `automatic-quote-sessions/${recoverySessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(
          recoverySessionToken,
          key("capacity-recovery-late-express"),
        ),
      },
    );
    expect(lateExpress.response.status).toBe(200);
    expect(lateExpress.body.checkoutReady).toBe(false);
    expect(lateExpress.body.bindingQuote).toBeNull();
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: recoveryOrderId } }),
    ).resolves.toMatchObject({ status: "DRAFT" });
    const recoveryFallback = await api(
      `automatic-quote-sessions/${recoverySessionId}/express`,
      {
        method: "PUT",
        headers: capabilityHeaders(
          recoverySessionToken,
          key("capacity-recovery-fallback"),
        ),
        body: JSON.stringify({ requested: false }),
      },
    );
    expect(recoveryFallback.response.status).toBe(200);
    expect(recoveryFallback.body.express).toMatchObject({ requested: false });
    expect(recoveryFallback.body.checkoutReady).toBe(false);
    expect(recoveryFallback.body.bindingQuote).toBeNull();
    const recoveryRestaged = await api(
      `automatic-quote-sessions/${recoverySessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(
          recoverySessionToken,
          key("capacity-recovery-restage"),
        ),
      },
    );
    expect(recoveryRestaged.response.status).toBe(200);
    expect(recoveryRestaged.body.checkoutReady).toBe(false);
    const standardRecoveryBinding =
      await prisma.orderActivePriceBinding.findUniqueOrThrow({
        where: { orderId: recoveryOrderId },
        include: { orderPriceBinding: { include: { priceSnapshot: true } } },
      });
    expect(standardRecoveryBinding.orderPriceBindingId).not.toBe(
      staleExpressBinding.orderPriceBindingId,
    );
    expect(
      (
        standardRecoveryBinding.orderPriceBinding.priceSnapshot
          .inputSnapshot as {
          automaticQuote: { expressRequested: boolean };
        }
      ).automaticQuote.expressRequested,
    ).toBe(false);
    await expect(
      prisma.orderPriceBinding.findUniqueOrThrow({
        where: { id: staleExpressBinding.orderPriceBindingId },
      }),
    ).resolves.toMatchObject({ invalidatedAt: expect.any(Date) });
    await expect(
      Promise.all([
        prisma.orderItem
          .findMany({
            where: { orderId: recoveryOrderId },
            select: { id: true },
            orderBy: { id: "asc" },
          })
          .then((items) => items.map(({ id }) => id)),
        prisma.orderPhase
          .findMany({
            where: { orderId: recoveryOrderId },
            select: { id: true },
            orderBy: { id: "asc" },
          })
          .then((phases) => phases.map(({ id }) => id)),
        prisma.fulfilmentSlot
          .findMany({
            where: { orderId: recoveryOrderId },
            select: { id: true },
            orderBy: { id: "asc" },
          })
          .then((slots) => slots.map(({ id }) => id)),
      ]),
    ).resolves.toEqual([
      recoveryTopology.itemIds,
      recoveryTopology.phaseIds,
      recoveryTopology.slotIds,
    ]);
    expect(
      (
        await api(`automatic-quote-sessions/${recoverySessionId}/express`, {
          method: "PUT",
          headers: capabilityHeaders(
            recoverySessionToken,
            key("capacity-recovery-reenable"),
          ),
          body: JSON.stringify({ requested: true }),
        })
      ).response.status,
    ).toBe(409);
    const standardRecoveryPlanIds = new Set(
      (
        await prisma.shipmentPlan.findMany({
          where: {
            orderPriceBindingId: standardRecoveryBinding.orderPriceBindingId,
          },
          select: { id: true },
        })
      ).map(({ id }) => id),
    );
    const standardRecoveryDispatches = (
      await prisma.outboxMessage.findMany({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          payload: {
            path: ["job", "correlationId"],
            equals: recoveryOrderId,
          },
        },
      })
    ).filter(({ payload }) =>
      standardRecoveryPlanIds.has(candidateJob(payload).input.shipmentPlanId),
    );
    expect(standardRecoveryDispatches.length).toBeGreaterThan(0);
    for (const [index, dispatch] of standardRecoveryDispatches.entries()) {
      const job = candidateJob(dispatch.payload);
      if (job.input.partsPerPlate > 1) {
        await candidates.ingest({
          result: deterministicCandidateArrangementResult(job),
        });
        continue;
      }
      const plateCount = Math.ceil(
        job.input.quantity / job.input.partsPerPlate,
      );
      const capacityWindows = Array.from({ length: plateCount }, (_, plate) => {
        const startsAt = new Date(
          lateCapacityEndsAt.getTime() +
            (index + 1) * 600_000 +
            plate * 120_000,
        );
        return {
          startsAt,
          endsAt: new Date(startsAt.getTime() + 60_000),
        };
      });
      await candidates.ingest({
        result: successfulCandidateResult(job, "60", "400000"),
        capacityWindows,
        expiresAt: new Date(Date.now() + 28 * 60 * 60 * 1_000),
      });
    }
    const candidateMaterialHandoff = await api(
      `automatic-quote-sessions/${recoverySessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(
          recoverySessionToken,
          key("capacity-recovery-candidate-material-handoff"),
        ),
      },
    );
    expect(candidateMaterialHandoff.response.status).toBe(200);
    expect(candidateMaterialHandoff.body.phase).toBe("HANDOFF_REQUIRED");
    expect(candidateMaterialHandoff.body.checkoutReady).toBe(false);
    expect(candidateMaterialHandoff.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["CANDIDATE_ESTIMATION_FAILED"]),
    });
    await expect(
      prisma.outboxMessage.findFirstOrThrow({
        where: {
          aggregateType: "AutomaticQuoteEligibilityDisposition",
          aggregateId: standardRecoveryBinding.orderPriceBindingId,
          messageType: "automatic_quote.candidate-estimation.unusable",
          status: "DELIVERED",
        },
      }),
    ).resolves.toMatchObject({
      payload: expect.objectContaining({
        reason: "NO_COMPLETE_RESOURCE_PLAN",
      }),
    });
    const standardRecoveryInventoryIds = [
      ...new Set(
        standardRecoveryDispatches.map(
          ({ payload }) => (payload as { inventoryId: string }).inventoryId,
        ),
      ),
    ];
    await prisma.inventory.updateMany({
      where: { id: { in: standardRecoveryInventoryIds } },
      data: { remainingMilligrams: 2_000_000n },
    });
    const recoveredCandidateFrontier = await api(
      `automatic-quote-sessions/${recoverySessionId}`,
      { headers: { authorization: `Bearer ${recoverySessionToken}` } },
    );
    expect(recoveredCandidateFrontier.response.status).toBe(200);
    expect(recoveredCandidateFrontier.body.phase).toBe("ELIGIBILITY_PENDING");
    expect(recoveredCandidateFrontier.body.handoff).toBeNull();
    const standardRecoveryReady = await api(
      `automatic-quote-sessions/${recoverySessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(
          recoverySessionToken,
          key("capacity-recovery-standard-ready"),
        ),
      },
    );
    expect(standardRecoveryReady.response.status).toBe(200);
    expect(standardRecoveryReady.body.phase).toBe("CHECKOUT_READY");
    expect(standardRecoveryReady.body.checkoutReady).toBe(true);
    expect(standardRecoveryReady.body.bindingQuote).toMatchObject({
      kind: "BINDING",
      currency: "CZK",
    });
    const expiredRecoveryClock = vi
      .spyOn(Date, "now")
      .mockReturnValue(
        new Date(string(standardRecoveryReady.body.expiresAt)).getTime() + 1,
      );
    try {
      const expiredRecovery = await api(
        `automatic-quote-sessions/${recoverySessionId}`,
        { headers: { authorization: `Bearer ${recoverySessionToken}` } },
      );
      expect(expiredRecovery.response.status).toBe(200);
      expect(expiredRecovery.body.phase).toBe("EXPIRED");
      expect(expiredRecovery.body.checkoutReady).toBe(false);
      expect(expiredRecovery.body.bindingQuote).toBeNull();
    } finally {
      expiredRecoveryClock.mockRestore();
    }
    const recoveryReservation =
      await prisma.phaseReservationSet.findFirstOrThrow({
        where: {
          phaseResourcePlan: {
            eligibilitySnapshot: {
              orderPhase: { orderId: recoveryOrderId },
            },
          },
          status: "RESERVED",
        },
      });
    await expect(
      resourceReservations.releaseBeforePrint(recoveryReservation.id),
    ).resolves.toBe(true);

    const riskDraft = await draftItem(0);
    const riskFinding = await prisma.preflightFinding.create({
      data: {
        modelFileId: riskDraft.sourceModelFileId,
        modelGeometryId: riskDraft.targetModelGeometryId,
        inspectionRevision: sha(`${scope}:binding-risk-revision`),
        code: "AUTOMATIC_BINDING_WARNING",
        severity: "WARNING",
        message: "binding risk warning",
        evidence: { acknowledgementKey: "binding-risk" },
      },
    });
    const acknowledgedRisk = await api(
      `automatic-quote-sessions/${sessionId}/risk-decisions`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("risk-acknowledge")),
        body: JSON.stringify({
          itemOrdinal: 0,
          findingId: riskFinding.id,
          acknowledgementKey: "binding-risk",
          decision: "ACKNOWLEDGED",
        }),
      },
    );
    expect(acknowledgedRisk.response.status).toBe(200);
    const acknowledgedRevision = number(
      acknowledgedRisk.body.configurationRevision,
    );
    const staged = await api(`automatic-quote-sessions/${sessionId}/prepare`, {
      method: "POST",
      headers: capabilityHeaders(sessionToken, key("stage")),
    });
    expect(staged.response.status).toBe(200);
    expect(staged.body.checkoutReady).toBe(false);
    expect(staged.body.bindingQuote).toBeNull();

    const staleRiskBinding =
      await prisma.orderActivePriceBinding.findUniqueOrThrow({
        where: { orderId },
      });
    const staleRiskPlanIds = new Set(
      (
        await prisma.shipmentPlan.findMany({
          where: {
            orderPriceBindingId: staleRiskBinding.orderPriceBindingId,
          },
          select: { id: true },
        })
      ).map(({ id }) => id),
    );
    const staleRiskDispatches = (
      await prisma.outboxMessage.findMany({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          payload: { path: ["job", "correlationId"], equals: orderId },
        },
      })
    ).filter(({ payload }) =>
      staleRiskPlanIds.has(candidateJob(payload).input.shipmentPlanId),
    );
    expect(staleRiskDispatches.length).toBeGreaterThan(0);
    const staleRiskCapacityBase = Date.now() + 60_000;
    for (const [index, dispatch] of staleRiskDispatches.entries()) {
      const startsAt = new Date(staleRiskCapacityBase + index * 120_000);
      await candidates.ingest({
        result: successfulCandidateResult(candidateJob(dispatch.payload)),
        capacityWindows: [
          { startsAt, endsAt: new Date(startsAt.getTime() + 60_000) },
        ],
        expiresAt: new Date(Date.now() + 25 * 60_000),
      });
    }
    const staleRiskCapacityEndsAt = new Date(
      staleRiskCapacityBase + staleRiskDispatches.length * 120_000,
    );
    const staleRiskDispatchesByNode = new Map<string, CandidateEstimateJob[]>();
    for (const dispatch of staleRiskDispatches) {
      const payload = dispatch.payload as unknown as {
        nodeId: string;
        job: CandidateEstimateJob;
      };
      const jobs = staleRiskDispatchesByNode.get(payload.nodeId) ?? [];
      jobs.push(payload.job);
      staleRiskDispatchesByNode.set(payload.nodeId, jobs);
    }
    const staleRiskNodeId = [...staleRiskDispatchesByNode].find(
      ([, jobs]) =>
        new Set(jobs.map((job) => job.input.geometry.modelGeometryId)).size ===
        2,
    )?.[0];
    if (!staleRiskNodeId) {
      throw new Error("expected a complete stale risk candidate node");
    }
    const staleRiskPhase = await prisma.orderPhase.findUniqueOrThrow({
      where: { orderId },
    });
    const staleRiskPlan = await eligibilityPlans.createCompletePlan({
      nodeId: staleRiskNodeId,
      orderPhaseId: staleRiskPhase.id,
      planKey: `${scope}:stale-risk-plan`,
    });
    const staleRiskReservation = await resourceReservations.reserve({
      nodeId: staleRiskNodeId,
      phaseResourcePlanId: staleRiskPlan.phaseResourcePlanId,
      reservationKey: `${scope}:stale-risk-reservation`,
    });
    const declinedRisk = await api(
      `automatic-quote-sessions/${sessionId}/risk-decisions`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("risk-decline")),
        body: JSON.stringify({
          itemOrdinal: 0,
          findingId: riskFinding.id,
          acknowledgementKey: "binding-risk",
          decision: "DECLINED",
        }),
      },
    );
    expect(declinedRisk.response.status).toBe(200);
    expect(declinedRisk.body.phase).toBe("HANDOFF_REQUIRED");
    expect(declinedRisk.body.checkoutReady).toBe(false);
    expect(declinedRisk.body.bindingQuote).toBeNull();
    expect(declinedRisk.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["RISK_DECLINED"]),
    });
    expect(number(declinedRisk.body.configurationRevision)).toBe(
      acknowledgedRevision + 1,
    );
    const declinedPrepare = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("risk-declined-prepare")),
      },
    );
    expect(declinedPrepare.response.status).toBe(200);
    expect(declinedPrepare.body.phase).toBe("HANDOFF_REQUIRED");
    expect(declinedPrepare.body.checkoutReady).toBe(false);
    expect(await prisma.orderPriceBinding.count({ where: { orderId } })).toBe(
      1,
    );
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    ).resolves.toMatchObject({ status: "DRAFT" });
    await expect(
      prisma.phaseReservationSet.findUniqueOrThrow({
        where: { id: staleRiskReservation.phaseReservationSetId },
      }),
    ).resolves.toMatchObject({ status: "RELEASED" });
    const reacknowledgedRisk = await api(
      `automatic-quote-sessions/${sessionId}/risk-decisions`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("risk-reacknowledge")),
        body: JSON.stringify({
          itemOrdinal: 0,
          findingId: riskFinding.id,
          acknowledgementKey: "binding-risk",
          decision: "ACKNOWLEDGED",
        }),
      },
    );
    expect(reacknowledgedRisk.response.status).toBe(200);
    const riskRestaged = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("risk-restage")),
      },
    );
    expect(riskRestaged.response.status).toBe(200);
    expect(riskRestaged.body.checkoutReady).toBe(false);
    const firstBinding = await prisma.orderActivePriceBinding.findUniqueOrThrow(
      {
        where: { orderId },
      },
    );
    expect(firstBinding.orderPriceBindingId).not.toBe(
      staleRiskBinding.orderPriceBindingId,
    );
    await expect(
      prisma.orderPriceBinding.findUniqueOrThrow({
        where: { id: staleRiskBinding.orderPriceBindingId },
      }),
    ).resolves.toMatchObject({ invalidatedAt: expect.any(Date) });
    const persistedSlots = await prisma.fulfilmentSlot.findMany({
      where: { orderId },
      orderBy: { packingUnitKey: "asc" },
    });
    const persistedPlans = await prisma.shipmentPlan.findMany({
      where: { orderPriceBindingId: firstBinding.orderPriceBindingId },
      include: { fulfilmentSlotAllocations: true },
      orderBy: { ordinal: "asc" },
    });
    const persistedPackingUnitKeys = persistedPlans.flatMap((plan) => {
      const snapshot = plan.allocationSnapshot as {
        packingUnitKeys: string[];
      };
      return snapshot.packingUnitKeys;
    });
    expect(persistedPackingUnitKeys.sort()).toEqual(
      persistedSlots.map(({ packingUnitKey }) => packingUnitKey).sort(),
    );
    expect(persistedPackingUnitKeys).not.toEqual(
      expect.arrayContaining(persistedSlots.map(({ id }) => id)),
    );
    expect(
      persistedPlans.flatMap((plan) => plan.fulfilmentSlotAllocations).length,
    ).toBe(persistedSlots.length);
    const persistedPlanIds = new Set(persistedPlans.map(({ id }) => id));
    const allCandidateDispatches = (
      await prisma.outboxMessage.findMany({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          payload: { path: ["job", "correlationId"], equals: orderId },
        },
        orderBy: { createdAt: "asc" },
      })
    ).filter(({ payload }) =>
      persistedPlanIds.has(candidateJob(payload).input.shipmentPlanId),
    );
    expect(
      allCandidateDispatches.some(
        ({ payload }) =>
          candidateJob(payload).input.machineId === invalidMachineId,
      ),
    ).toBe(false);
    expect(
      allCandidateDispatches.every(
        ({ payload }) =>
          candidateJob(payload).input.machineProfile
            .productionArtifactFormat === "gcode_3mf",
      ),
    ).toBe(true);
    const dispatchesByNode = new Map<
      string,
      Array<{
        dispatch: (typeof allCandidateDispatches)[number];
        inventoryId: string;
        job: CandidateEstimateJob;
      }>
    >();
    for (const dispatch of allCandidateDispatches) {
      const payload = dispatch.payload as unknown as {
        nodeId: string;
        inventoryId: string;
        job: CandidateEstimateJob;
      };
      const group = dispatchesByNode.get(payload.nodeId) ?? [];
      group.push({
        dispatch,
        inventoryId: payload.inventoryId,
        job: payload.job,
      });
      dispatchesByNode.set(payload.nodeId, group);
    }
    const hasBothItems = (
      dispatches: readonly { job: CandidateEstimateJob }[],
    ) =>
      new Set(dispatches.map(({ job }) => job.input.geometry.modelGeometryId))
        .size === 2;
    const foundationDispatches = dispatchesByNode.get(foundation.nodeId);
    const candidateDispatches =
      (foundationDispatches && hasBothItems(foundationDispatches)
        ? foundationDispatches
        : [...dispatchesByNode.values()].find(hasBothItems)) ?? [];
    expect(
      new Set(
        candidateDispatches.map(
          ({ job }) => job.input.geometry.modelGeometryId,
        ),
      ).size,
    ).toBe(2);
    await prisma.inventory.updateMany({
      where: {
        id: { in: candidateDispatches.map(({ inventoryId }) => inventoryId) },
      },
      data: { remainingMilligrams: 1_000_000n },
    });
    const capacityBase = staleRiskCapacityEndsAt.getTime() + 60_000;
    const retryCandidate = candidateDispatches[0];
    if (!retryCandidate) throw new Error("expected a candidate to retry");
    await candidates.ingest({
      result: retryableCandidateResult(retryCandidate.job),
    });
    for (const [index, { job }] of candidateDispatches.slice(1).entries()) {
      const startsAt = new Date(capacityBase + index * 120_000);
      const endsAt = new Date(startsAt.getTime() + 60_000);
      await candidates.ingest({
        result: successfulCandidateResult(job),
        capacityWindows: [{ startsAt, endsAt }],
        expiresAt: new Date(Date.now() + 25 * 60_000),
      });
    }

    const retryPrepares = await Promise.all(
      ["retry-candidate-a", "retry-candidate-b"].map((command) =>
        api(`automatic-quote-sessions/${sessionId}/prepare`, {
          method: "POST",
          headers: capabilityHeaders(sessionToken, key(command)),
        }),
      ),
    );
    expect(retryPrepares.map(({ response }) => response.status)).toEqual([
      200, 200,
    ]);
    const retryDispatches = await prisma.outboxMessage.findMany({
      where: {
        aggregateId: retryCandidate.job.jobId,
        aggregateType: "CandidateEstimateDispatch",
        messageType: "slicing.candidate-estimate.requested",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(retryDispatches).toHaveLength(2);
    const retryJob = candidateJob(retryDispatches[1]!.payload);
    expect(retryJob).toMatchObject({
      jobId: retryCandidate.job.jobId,
      idempotencyKey: retryCandidate.job.idempotencyKey,
      attempt: 2,
      inputFingerprintSha256: retryCandidate.job.inputFingerprintSha256,
    });
    const retryReceipt =
      await prisma.candidateEstimateTerminalResult.findUniqueOrThrow({
        where: { outboxMessageId: retryCandidate.dispatch.id },
      });
    expect(retryDispatches[1]!.availableAt.getTime()).toBeGreaterThanOrEqual(
      retryReceipt.createdAt.getTime() + 1_000,
    );
    const refreshableStartsAt = new Date(Date.now() + 2_000);
    const refreshable = await candidates.ingest({
      result: successfulCandidateResult(retryJob, "1"),
      capacityWindows: [
        {
          startsAt: refreshableStartsAt,
          endsAt: new Date(refreshableStartsAt.getTime() + 1_000),
        },
      ],
      expiresAt: new Date(Date.now() + 5_000),
    });
    if (refreshable.status !== "succeeded") {
      throw new Error("expected the retry candidate to succeed");
    }

    const shortLivedPending = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("short-lived-pending")),
      },
    );
    expect(shortLivedPending.response.status).toBe(200);
    expect(shortLivedPending.body.phase).toBe("ELIGIBILITY_PENDING");
    expect(shortLivedPending.body.checkoutReady).toBe(false);

    const refreshableEstimate =
      await prisma.candidateResourceEstimate.findUniqueOrThrow({
        where: { id: refreshable.candidateResourceEstimateId },
      });
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, refreshableEstimate.expiresAt.getTime() - Date.now() + 50),
      ),
    );
    const refreshPrepares = await Promise.all(
      ["refresh-candidate-a", "refresh-candidate-b"].map((command) =>
        api(`automatic-quote-sessions/${sessionId}/prepare`, {
          method: "POST",
          headers: capabilityHeaders(sessionToken, key(command)),
        }),
      ),
    );
    expect(refreshPrepares.map(({ response }) => response.status)).toEqual([
      200, 200,
    ]);
    const refreshedDispatches = (
      await prisma.outboxMessage.findMany({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          payload: { path: ["job", "correlationId"], equals: orderId },
        },
      })
    )
      .map((dispatch) => ({
        dispatch,
        job: candidateJob(dispatch.payload),
      }))
      .filter(
        ({ job }) =>
          job.jobId !== retryCandidate.job.jobId &&
          job.input.machineId === retryCandidate.job.input.machineId &&
          job.input.shipmentPlanId ===
            retryCandidate.job.input.shipmentPlanId &&
          job.input.geometry.modelGeometryId ===
            retryCandidate.job.input.geometry.modelGeometryId,
      );
    expect(refreshedDispatches).toHaveLength(1);
    const refreshedJob = refreshedDispatches[0]!.job;
    expect(refreshedJob).toMatchObject({
      attempt: 1,
      inputFingerprintSha256: retryCandidate.job.inputFingerprintSha256,
      input: retryCandidate.job.input,
    });
    expect(refreshedJob.jobId).not.toBe(retryCandidate.job.jobId);
    await candidates.ingest({
      result: successfulCandidateResult(refreshedJob, "1"),
      expiresAt: new Date(Date.now() + 25 * 60_000),
    });
    const refreshedReady = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("refresh-finalize")),
      },
    );
    expect(refreshedReady.response.status).toBe(200);
    expect(refreshedReady.body.phase).toBe("CHECKOUT_READY");
    expect(refreshedReady.body.checkoutReady).toBe(true);
    expect(refreshedReady.body.bindingQuote).toMatchObject({
      kind: "BINDING",
      currency: "CZK",
    });
    const binding = refreshedReady.body.bindingQuote as {
      totalMinor: number;
      components: Array<{ amountMinor: number }>;
    };
    expect(
      binding.components.reduce(
        (sum, component) => sum + component.amountMinor,
        0,
      ),
    ).toBe(binding.totalMinor);
    expect(
      await prisma.candidateResourceEstimate.count({
        where: {
          modelGeometryId: retryCandidate.job.input.geometry.modelGeometryId,
          shipmentPlanId: retryCandidate.job.input.shipmentPlanId,
          machineId: retryCandidate.job.input.machineId,
        },
      }),
    ).toBe(2);

    const replay = await api(`automatic-quote-sessions/${sessionId}/prepare`, {
      method: "POST",
      headers: capabilityHeaders(sessionToken, key("finalize-replay")),
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body.checkoutReady).toBe(true);
    expect(await prisma.orderPriceBinding.count({ where: { orderId } })).toBe(
      2,
    );
    expect(
      await prisma.phaseReservationSet.count({
        where: {
          phaseResourcePlan: {
            jobs: {
              some: {
                candidateResourceEstimate: {
                  shipmentPlan: {
                    orderPriceBindingId: firstBinding.orderPriceBindingId,
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe(1);
    expect(await prisma.orderPhase.count({ where: { orderId } })).toBe(1);
    expect(await prisma.fulfilmentSlot.count({ where: { orderId } })).toBe(2);
    const initialCandidateJobIds = [
      ...new Set(allCandidateDispatches.map(({ aggregateId }) => aggregateId)),
    ];
    expect(
      await prisma.outboxMessage.count({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          aggregateId: { in: initialCandidateJobIds },
        },
      }),
    ).toBe(initialCandidateJobIds.length + 1);
    const expiredReservation =
      await prisma.phaseReservationSet.findFirstOrThrow({
        where: {
          phaseResourcePlan: {
            jobs: {
              some: {
                candidateResourceEstimate: {
                  shipmentPlan: {
                    orderPriceBindingId: firstBinding.orderPriceBindingId,
                  },
                },
              },
            },
          },
        },
      });
    await prisma.$transaction(async (transaction) => {
      await transaction.inventoryReservation.updateMany({
        where: {
          productionReservation: {
            phaseReservationSetId: expiredReservation.id,
          },
          status: "RESERVED",
        },
        data: { status: "EXPIRED" },
      });
      await transaction.capacityReservation.updateMany({
        where: {
          productionReservation: {
            phaseReservationSetId: expiredReservation.id,
          },
          status: "RESERVED",
        },
        data: { status: "EXPIRED" },
      });
      await transaction.productionReservation.updateMany({
        where: {
          phaseReservationSetId: expiredReservation.id,
          status: "RESERVED",
        },
        data: { status: "EXPIRED" },
      });
      await transaction.phaseReservationSet.update({
        where: { id: expiredReservation.id },
        data: { status: "EXPIRED" },
      });
    });
    const recovered = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("recover-expired")),
      },
    );
    expect(recovered.response.status).toBe(200);
    expect(recovered.body.checkoutReady).toBe(true);
    const recoveredReplay = await api(
      `automatic-quote-sessions/${sessionId}/prepare`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("recover-expired-replay")),
      },
    );
    expect(recoveredReplay.response.status).toBe(200);
    expect(recoveredReplay.body.checkoutReady).toBe(true);
    const reservationSets = await prisma.phaseReservationSet.findMany({
      where: {
        phaseResourcePlan: {
          jobs: {
            some: {
              candidateResourceEstimate: {
                shipmentPlan: {
                  orderPriceBindingId: firstBinding.orderPriceBindingId,
                },
              },
            },
          },
        },
      },
    });
    expect(reservationSets).toHaveLength(2);
    expect(
      await prisma.phaseResourcePlan.count({
        where: {
          jobs: {
            some: {
              candidateResourceEstimate: {
                shipmentPlan: {
                  orderPriceBindingId: firstBinding.orderPriceBindingId,
                },
              },
            },
          },
        },
      }),
    ).toBe(2);
    expect(
      reservationSets.filter(({ status }) => status === "EXPIRED"),
    ).toHaveLength(1);
    const successorReservation = reservationSets.find(
      ({ status }) => status === "RESERVED",
    );
    expect(successorReservation).toBeDefined();

    const changed = await api(
      `automatic-quote-sessions/${sessionId}/delivery-destination`,
      {
        method: "PUT",
        headers: capabilityHeaders(sessionToken, key("destination-change")),
        body: JSON.stringify({
          providerEndpointId: "test-zbox",
          endpointType: "pickup_point",
        }),
      },
    );
    expect(changed.response.status).toBe(200);
    expect(changed.body.checkoutReady).toBe(false);
    expect(changed.body.bindingQuote).toBeNull();
    await expect(
      prisma.phaseReservationSet.findUniqueOrThrow({
        where: { id: successorReservation!.id },
      }),
    ).resolves.toMatchObject({ status: "RELEASED" });
    await expect(
      prisma.phaseReservationSet.findUniqueOrThrow({
        where: { id: expiredReservation.id },
      }),
    ).resolves.toMatchObject({ status: "EXPIRED" });

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

    const replacementShipmentPlanIds = (
      await prisma.shipmentPlan.findMany({
        where: { orderPriceBindingId: replacement.orderPriceBindingId },
        select: { id: true },
      })
    ).map(({ id }) => id);
    const replacementShipmentPlanIdSet = new Set(replacementShipmentPlanIds);
    const replacementDispatches = (
      await prisma.outboxMessage.findMany({
        where: {
          aggregateType: "CandidateEstimateDispatch",
          messageType: "slicing.candidate-estimate.requested",
          payload: { path: ["job", "correlationId"], equals: orderId },
        },
      })
    ).filter(({ payload }) =>
      replacementShipmentPlanIdSet.has(
        candidateJob(payload).input.shipmentPlanId,
      ),
    );
    const terminalTarget = replacementDispatches[0];
    if (!terminalTarget) {
      throw new Error("expected replacement candidate dispatches");
    }
    const terminalTargetJob = candidateJob(terminalTarget.payload);
    const terminalGroup = replacementDispatches.filter(({ payload }) => {
      const job = candidateJob(payload);
      return (
        job.input.shipmentPlanId === terminalTargetJob.input.shipmentPlanId &&
        job.input.geometry.modelGeometryId ===
          terminalTargetJob.input.geometry.modelGeometryId
      );
    });
    expect(terminalGroup.length).toBeGreaterThan(0);
    await prisma.outboxMessage.createMany({
      data: terminalGroup.map((dispatch) => ({
        deduplicationKey: `${scope}:candidate-dead-letter:${dispatch.id}`,
        aggregateType: "SlicingDispatchDeadLetter",
        aggregateId: dispatch.id,
        messageType: "slicing.candidate_estimate.dead-lettered",
        schemaVersion: 2,
        payload: { dispatchId: dispatch.id },
      })),
    });
    const candidateHandoff = await api(
      `automatic-quote-sessions/${sessionId}`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );
    expect(candidateHandoff.response.status).toBe(200);
    expect(candidateHandoff.body.phase).toBe("HANDOFF_REQUIRED");
    expect(candidateHandoff.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["CANDIDATE_ESTIMATION_FAILED"]),
    });

    const warningDraft = await draftItem(0);
    await prisma.preflightFinding.createMany({
      data: Array.from({ length: 4 }, (_, index) => ({
        modelFileId: warningDraft.sourceModelFileId,
        modelGeometryId: warningDraft.targetModelGeometryId,
        inspectionRevision: sha(`${scope}:warning-revision`),
        code: `AUTOMATIC_WARNING_${index + 1}`,
        severity: "WARNING" as const,
        message: `warning ${index + 1}`,
        evidence: { acknowledgementKey: `warning-risk-${index + 1}` },
      })),
    });
    const warningHandoff = await api(`automatic-quote-sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(warningHandoff.response.status).toBe(200);
    expect(warningHandoff.body.phase).toBe("HANDOFF_REQUIRED");
    expect(warningHandoff.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["RISK_ACKNOWLEDGEMENT_LIMIT_EXCEEDED"]),
    });
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
    const retainedSource = await prisma.modelFile.findUniqueOrThrow({
      where: { id: modelFile.id },
    });
    const sessionExpiry = new Date(string(created.body.expiresAt));
    expect(retainedSource.sourceDeleteAfter.getTime()).toBeGreaterThanOrEqual(
      sessionExpiry.getTime() +
        retainedSource.sourceRetentionDays * 24 * 60 * 60 * 1_000,
    );
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

  it("hands off a dead-lettered source inspection instead of staying pending", async () => {
    const modelFileId = randomUUID();
    const modelFile = await prisma.modelFile.create({
      data: {
        id: modelFileId,
        format: "STL",
        originalFilename: "dead-lettered.stl",
        storageObjectKey: `models/${modelFileId}/source`,
        contentHash: sha(`${scope}:dead-lettered-source`),
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
        originalFilename: modelFile.originalFilename,
        modelFormat: "STL",
        intendedAssetId: modelFile.id,
        expectedContentType: "model/stl",
        expectedSizeBytes: modelFile.sizeBytes,
        expectedContentHash: modelFile.contentHash,
        quarantineObjectKey: `${scope}/quarantine/dead-lettered.stl`,
        finalObjectKey: `${scope}/final/dead-lettered.stl`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        status: "CONFIRMED",
        confirmedModelFileId: modelFile.id,
        confirmedAt: new Date(),
      },
    });
    const created = await api("automatic-quote-sessions", {
      method: "POST",
      headers: jsonHeaders(key("dead-letter-create")),
      body: "{}",
    });
    const sessionId = string(created.body.sessionId);
    const sessionToken = string(created.body.sessionToken);
    const attached = await api(
      `automatic-quote-sessions/${sessionId}/model-files`,
      {
        method: "POST",
        headers: capabilityHeaders(sessionToken, key("dead-letter-attach")),
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
        aggregateType: "ModelInspectionDispatch",
        messageType: "slicing.model-inspection.requested",
      },
    });
    await prisma.outboxMessage.create({
      data: {
        deduplicationKey: `${scope}:source-inspection-dead-letter`,
        aggregateType: "SlicingDispatchDeadLetter",
        aggregateId: dispatch.id,
        messageType: "slicing.model_inspection.dead-lettered",
        schemaVersion: 2,
        payload: { dispatchId: dispatch.id },
      },
    });

    const failed = await api(`automatic-quote-sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(failed.response.status).toBe(200);
    expect(failed.body.phase).toBe("HANDOFF_REQUIRED");
    expect(failed.body.modelFiles).toEqual([
      expect.objectContaining({ inspectionStatus: "FAILED" }),
    ]);
    expect(failed.body.handoff).toMatchObject({
      reasons: expect.arrayContaining(["INSPECTION_FAILED"]),
    });
    expect(
      await prisma.outboxMessage.count({
        where: {
          aggregateId: automaticFile.inspectionJobId,
          aggregateType: "ModelInspectionDispatch",
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

function number(value: unknown): number {
  if (typeof value !== "number") throw new Error("expected a number");
  return value;
}

function candidateJob(value: unknown): CandidateEstimateJob {
  const payload = value as { job?: CandidateEstimateJob };
  if (!payload.job) throw new Error("expected a candidate job payload");
  return payload.job;
}

function retryableCandidateResult(
  job: CandidateEstimateJob,
): CandidateEstimateResult {
  return {
    ...job,
    engine: { name: "orca", version: "test", imageSha256: "b".repeat(64) },
    outcome: {
      status: "failed",
      failureClass: "retryable_infrastructure",
      code: "ENGINE_TIMEOUT",
      retryable: true,
      message: "engine timed out",
      retryAfterMilliseconds: 1_000,
    },
  };
}

function deterministicCandidateArrangementResult(
  job: CandidateEstimateJob,
): CandidateEstimateResult {
  return {
    ...job,
    engine: { name: "orca", version: "test", imageSha256: "b".repeat(64) },
    outcome: {
      status: "failed",
      failureClass: "deterministic_invalid",
      code: "INVALID_GEOMETRY",
      retryable: false,
      message: "Requested copies do not fit on the production plate",
      retryAfterMilliseconds: null,
    },
  };
}

function successfulCandidateResult(
  job: CandidateEstimateJob,
  estimatedPrintSeconds = "60",
  estimatedMaterialMilligrams = "60",
): CandidateEstimateResult {
  const plateCount = Math.ceil(job.input.quantity / job.input.partsPerPlate);
  const plateOccupancies = Array.from({ length: plateCount }, (_, index) =>
    index < plateCount - 1
      ? job.input.partsPerPlate
      : job.input.quantity - job.input.partsPerPlate * (plateCount - 1),
  );
  return {
    ...job,
    engine: { name: "orca", version: "test", imageSha256: "b".repeat(64) },
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
        topology: {
          watertight: true,
          manifold: true,
          normals: "consistent",
        },
        thinWallFeatureCount: 0,
        supportVolumeRatioPpm: 0,
        hasPaintAssignments: false,
        materialAssignmentCount: 0,
        estimatedPrintSeconds: (
          BigInt(estimatedPrintSeconds) * BigInt(plateCount)
        ).toString(),
        estimatedMaterialMilligrams: (
          BigInt(estimatedMaterialMilligrams) * BigInt(plateCount)
        ).toString(),
        plateCount,
      },
      plates: plateOccupancies.map((partsOnPlate, index) => ({
        plateOrdinal: index + 1,
        partsOnPlate,
        estimatedPrintSeconds,
        estimatedMaterialMilligrams,
      })),
      occupancySlices: job.input.occupancySliceTargets.map((target) => ({
        partsPerPlate: target.partsPerPlate,
        cacheIdentitySha256: target.cacheIdentitySha256,
        estimatedPrintSeconds,
        estimatedMaterialMilligrams,
        artifact: {
          objectKey: target.analysisObjectKey,
          sha256: sha(target.analysisObjectKey),
        },
      })),
    },
  };
}
