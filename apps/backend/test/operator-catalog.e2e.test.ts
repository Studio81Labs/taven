import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { configureHttpBodyParsers } from "../src/http-body.config";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  SlicerProfileSnapshotIntegrityError,
  SlicerProfileSnapshotService,
  SlicerProfileSnapshotUnavailableError,
} from "../src/modules/slicing/slicer-profile-snapshot.service";
import {
  PersistenceFactory,
  type PersistenceFoundation,
} from "./support/persistence-factory";

const uploadClientHashKey = "operator-catalog-test-upload-client-hash-key-32";
const quoteCapabilityKey =
  "operator-catalog-test-quote-capability-key-with-at-least-32-characters";
const testScope = randomUUID();
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
process.env.TAVEN_REDIS_URL ??= "redis://127.0.0.1:6381";

describe("operator catalog commands", () => {
  let app: NestExpressApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let pool: Pool;
  let fixture: PersistenceFoundation;
  let adminCookie: string;
  let adminCsrfToken: string;
  let adminOperatorId: string;
  let secondAdminCookie: string;
  let secondAdminCsrfToken: string;
  let viewerCookie: string;
  let viewerCsrfToken: string;

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
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required for e2e tests");
    pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = new PersistenceFactory(
        client,
        `operator-catalog-${randomUUID()}`,
      );
      fixture = await fixtures.createFoundation("operator-catalog");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const admin = await sessionCookie("ADMIN", fixture.nodeId);
    adminCookie = admin.cookie;
    adminCsrfToken = admin.csrfToken;
    adminOperatorId = admin.operatorId;
    const secondAdmin = await sessionCookie("ADMIN", fixture.nodeId);
    secondAdminCookie = secondAdmin.cookie;
    secondAdminCsrfToken = secondAdmin.csrfToken;
    const viewer = await sessionCookie("VIEWER", fixture.nodeId);
    viewerCookie = viewer.cookie;
    viewerCsrfToken = viewer.csrfToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("writes revision and node catalog resources with idempotency and audit evidence", async () => {
    const referenceKey = `catalog-reference-${randomUUID()}`;
    const referenceBody = {
      material: "PLA",
      quality: "FINE",
      slicerEngine: "orca",
      slicerVersion: "2.1.0",
      settings: {
        layerHeight: 120,
        profile: "operator-catalog",
        testScope,
      },
    };
    const snapshots = app.get(SlicerProfileSnapshotService);
    const createdReferenceProvision = vi.spyOn(
      snapshots,
      "provisionReferenceProfile",
    );
    const createdMachineProvision = vi.spyOn(
      snapshots,
      "provisionMachineProfile",
    );
    const createdCalibrationProvision = vi.spyOn(
      snapshots,
      "provisionMachineCalibration",
    );
    const referenceResponse = await command(
      "/admin/catalog/reference-profiles",
      referenceBody,
      referenceKey,
    );
    expect(referenceResponse.status).toBe(200);
    const reference = (await referenceResponse.json()) as {
      id: string;
      state: string;
    };
    expect(reference).toMatchObject({ state: "DRAFT" });
    await expect(
      prisma.referenceProfile.findUnique({ where: { id: reference.id } }),
    ).resolves.toMatchObject({
      settings: referenceBody.settings,
      state: "DRAFT",
    });

    expect(createdReferenceProvision).not.toHaveBeenCalled();
    createdReferenceProvision.mockRestore();
    const provisionSettings = vi
      .spyOn(snapshots, "provisionReferenceProfile")
      .mockRejectedValue(new Error("storage must not be called for replay"));
    const replayAt = new Date(Date.now() + 31 * 86_400_000);
    vi.useFakeTimers();
    let replay: Response | undefined;
    try {
      vi.setSystemTime(replayAt);
      replay = await command(
        "/admin/catalog/reference-profiles",
        referenceBody,
        referenceKey,
      );
      expect(provisionSettings).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    provisionSettings.mockRestore();
    expect(replay?.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(reference);
    await expect(
      prisma.auditEvent.count({
        where: {
          correlationId: reference.id,
          eventType: "catalog.reference-profile.created",
        },
      }),
    ).resolves.toBe(1);

    const mismatchedProvision = vi
      .spyOn(snapshots, "provisionReferenceProfile")
      .mockRejectedValue(new Error("storage must not be called for mismatch"));
    const mismatchedReplay = await command(
      "/admin/catalog/reference-profiles",
      { ...referenceBody, slicerVersion: "2.1.1" },
      referenceKey,
    );
    expect(mismatchedReplay.status).toBe(409);
    expect(mismatchedProvision).not.toHaveBeenCalled();
    mismatchedProvision.mockRestore();

    const machine = await prisma.machine.findUniqueOrThrow({
      where: { id: fixture.machineId },
      select: { machineCapabilityId: true },
    });
    const machineProfile = await responseBody(
      command(
        "/admin/catalog/machine-profiles",
        {
          ...referenceBody,
          machineCapabilityId: machine.machineCapabilityId,
          referenceProfileId: reference.id,
          nozzleDiameterMicrometers: 400,
          productionArtifactFormat: "GCODE_3MF",
        },
        `catalog-machine-profile-${randomUUID()}`,
      ),
    );
    expect(machineProfile.state).toBe("DRAFT");

    const calibration = await responseBody(
      command(
        `/admin/nodes/${fixture.nodeId}/calibrations`,
        {
          machineId: fixture.machineId,
          flowRatioPartsPerMillion: 1_000_000,
          xyCompensationMicrometers: 10,
          elephantFootCompensationMicrometers: -5,
          settings: { testScope, zOffset: -5 },
        },
        `catalog-calibration-${randomUUID()}`,
      ),
    );
    expect(calibration.state).toBe("DRAFT");
    expect(createdMachineProvision).not.toHaveBeenCalled();
    expect(createdCalibrationProvision).not.toHaveBeenCalled();
    createdMachineProvision.mockRestore();
    createdCalibrationProvision.mockRestore();

    const inventory = await responseBody(
      command(
        `/admin/nodes/${fixture.nodeId}/inventories`,
        {
          machineId: fixture.machineId,
          sku: `catalog-${randomUUID()}`,
          material: "PLA",
          vendor: "Taven test",
          color: "blue",
          lotCode: "lot-42",
          priceMinorUnitsNumerator: "9007199254740993",
          priceMinorUnitsDenominator: "1000",
          currency: "EUR",
          remainingMilligrams: "500",
        },
        `catalog-inventory-${randomUUID()}`,
      ),
    );
    await expect(
      prisma.inventory.findUnique({ where: { id: inventory.id } }),
    ).resolves.toMatchObject({
      priceMinorUnitsNumerator: 9_007_199_254_740_993n,
      priceMinorUnitsDenominator: 1000n,
      remainingMilligrams: 500n,
    });

    for (const [path, body] of [
      [
        `/admin/catalog/reference-profiles/${reference.id}/activate`,
        { reason: "Verified reference profile" },
      ],
      [
        `/admin/catalog/machine-profiles/${machineProfile.id}/activate`,
        { reason: "Verified machine profile" },
      ],
      [
        `/admin/nodes/${fixture.nodeId}/calibrations/${fixture.machineCalibrationId}/retire`,
        { reason: "Superseded fixture calibration" },
      ],
      [
        `/admin/nodes/${fixture.nodeId}/calibrations/${calibration.id}/activate`,
        { reason: "Verified machine calibration" },
      ],
      [
        `/admin/nodes/${fixture.nodeId}/machines/${fixture.machineId}/status`,
        { status: "MAINTENANCE", reason: "Scheduled maintenance" },
      ],
      [
        `/admin/nodes/${fixture.nodeId}/inventories/${inventory.id}/status`,
        { status: "DEPLETED", reason: "Container is empty" },
      ],
      [
        `/admin/nodes/${fixture.nodeId}/calibrations/${calibration.id}/retire`,
        { reason: "Superseded calibration" },
      ],
      [
        `/admin/catalog/machine-profiles/${machineProfile.id}/retire`,
        { reason: "Superseded machine profile" },
      ],
      [
        `/admin/catalog/reference-profiles/${reference.id}/retire`,
        { reason: "Superseded reference profile" },
      ],
    ] as const) {
      const response = await command(
        path,
        body,
        `catalog-transition-${randomUUID()}`,
      );
      expect(response.status, path).toBe(200);
    }

    const adjustmentKey = `catalog-adjustment-${randomUUID()}`;
    const adjustmentPath = `/admin/nodes/${fixture.nodeId}/inventories/${fixture.inventoryId}/adjustments`;
    const adjustmentBody = {
      deltaMilligrams: "11",
      reason: "Receiving correction",
    };
    const adjustment = await responseBody(
      command(adjustmentPath, adjustmentBody, adjustmentKey),
    );
    const adjustmentReplay = await responseBody(
      command(
        `/admin/nodes/${fixture.nodeId.toUpperCase()}/inventories/${fixture.inventoryId.toUpperCase()}/adjustments`,
        adjustmentBody,
        adjustmentKey,
      ),
    );
    expect(adjustmentReplay).toEqual(adjustment);
    await expect(
      prisma.inventory.findUnique({ where: { id: fixture.inventoryId } }),
    ).resolves.toMatchObject({ remainingMilligrams: 111n });
    await expect(
      prisma.auditEvent.count({
        where: {
          correlationId: fixture.inventoryId,
          eventType: "catalog.inventory.adjusted",
        },
      }),
    ).resolves.toBe(1);
    const auditResponse = await fetch(
      new URL(
        `/admin/audit-events?eventType=catalog.inventory.adjusted`,
        baseUrl,
      ),
      { headers: { cookie: adminCookie } },
    );
    expect(auditResponse.status).toBe(200);
    const auditPage = (await auditResponse.json()) as {
      items: Array<{
        correlationId?: string;
        payload: Record<string, unknown>;
      }>;
    };
    expect(auditPage.items).toContainEqual(
      expect.objectContaining({
        correlationId: fixture.inventoryId,
        payload: expect.objectContaining({ deltaMilligrams: "11" }),
      }),
    );
  });

  it("creates snapshots only at activation and preserves cross-operator command effects", async () => {
    const snapshots = app.get(SlicerProfileSnapshotService);
    const createPath = "/admin/catalog/reference-profiles";
    const createBody = {
      material: "PLA",
      quality: "FINE",
      slicerEngine: "orca",
      slicerVersion: "2.1.0",
      settings: { profile: "activation-gate", testScope },
    };

    const createKey = `catalog-draft-only-${randomUUID()}`;
    const provision = vi.spyOn(snapshots, "provisionReferenceProfile");
    const draft = await responseBody(
      command(createPath, createBody, createKey),
    );
    expect(draft.state).toBe("DRAFT");
    expect(provision).not.toHaveBeenCalled();

    const crossOperatorReplay = await responseBody(
      commandAs(
        secondAdminCookie,
        secondAdminCsrfToken,
        createPath,
        createBody,
        createKey,
      ),
    );
    expect(crossOperatorReplay).toEqual(draft);
    expect(provision).not.toHaveBeenCalled();
    provision.mockRestore();
    await expect(
      prisma.auditEvent.findMany({
        where: {
          correlationId: draft.id,
          eventType: "catalog.reference-profile.created",
        },
        select: { operatorIdentityId: true },
      }),
    ).resolves.toEqual([{ operatorIdentityId: adminOperatorId }]);

    const unicodeOrderKey = `catalog-unicode-order-${randomUUID()}`;
    const unicodeOrderFirst = await responseBody(
      command(
        createPath,
        {
          ...createBody,
          settings: {
            é: "composed",
            "e\u0301": "decomposed",
            testScope,
          },
        },
        unicodeOrderKey,
      ),
    );
    const unicodeOrderReplay = await responseBody(
      commandAs(
        secondAdminCookie,
        secondAdminCsrfToken,
        createPath,
        {
          ...createBody,
          settings: {
            testScope,
            "e\u0301": "decomposed",
            é: "composed",
          },
        },
        unicodeOrderKey,
      ),
    );
    expect(unicodeOrderReplay).toEqual(unicodeOrderFirst);

    const concurrentKey = `catalog-concurrent-same-${randomUUID()}`;
    const concurrentBody = {
      ...createBody,
      settings: { profile: "concurrent-same", testScope },
    };
    const concurrentResponses = await Promise.all([
      command(createPath, concurrentBody, concurrentKey),
      commandAs(
        secondAdminCookie,
        secondAdminCsrfToken,
        createPath,
        concurrentBody,
        concurrentKey,
      ),
    ]);
    expect(concurrentResponses.map(({ status }) => status)).toEqual([200, 200]);
    const concurrentResults = (await Promise.all(
      concurrentResponses.map((response) => response.json()),
    )) as Array<{ id: string; state: string }>;
    expect(concurrentResults[0]).toEqual(concurrentResults[1]);
    const concurrentResult = concurrentResults[0];
    if (!concurrentResult) {
      throw new Error("expected a concurrent command result");
    }
    await expect(
      prisma.auditEvent.count({
        where: {
          correlationId: concurrentResult.id,
          eventType: "catalog.reference-profile.created",
        },
      }),
    ).resolves.toBe(1);

    const mismatchKey = `catalog-concurrent-mismatch-${randomUUID()}`;
    const mismatchResponses = await Promise.all([
      command(createPath, concurrentBody, mismatchKey),
      commandAs(
        secondAdminCookie,
        secondAdminCsrfToken,
        createPath,
        { ...concurrentBody, slicerVersion: "2.1.1" },
        mismatchKey,
      ),
    ]);
    expect(mismatchResponses.map(({ status }) => status).sort()).toEqual([
      200, 409,
    ]);
    const mismatchSuccess = mismatchResponses.find(
      ({ status }) => status === 200,
    );
    if (!mismatchSuccess) {
      throw new Error("expected one successful concurrent command");
    }
    const mismatchResult = (await mismatchSuccess.json()) as {
      id: string;
      state: string;
    };
    await expect(
      prisma.auditEvent.count({
        where: {
          correlationId: mismatchResult.id,
          eventType: "catalog.reference-profile.created",
        },
      }),
    ).resolves.toBe(1);

    const unavailableKey = `catalog-activation-unavailable-${randomUUID()}`;
    const unavailable = vi
      .spyOn(snapshots, "provisionReferenceProfile")
      .mockRejectedValue(new SlicerProfileSnapshotUnavailableError());
    const unavailableActivation = await command(
      `${createPath}/${draft.id}/activate`,
      { reason: "Verify immutable reference settings" },
      unavailableKey,
    );
    expect(unavailableActivation.status).toBe(503);
    await expect(
      prisma.referenceProfile.findUniqueOrThrow({ where: { id: draft.id } }),
    ).resolves.toMatchObject({ state: "DRAFT" });
    await expect(
      prisma.auditEvent.count({
        where: {
          correlationId: draft.id,
          eventType: "catalog.reference-profile.activated",
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.idempotencyRecord.count({
        where: {
          namespace: `cat:reference-profile:${draft.id}:activate`,
          idempotencyKey: unavailableKey,
        },
      }),
    ).resolves.toBe(0);
    unavailable.mockRestore();

    const activated = await responseBody(
      command(
        `${createPath}/${draft.id}/activate`,
        { reason: "Verify immutable reference settings" },
        unavailableKey,
      ),
    );
    expect(activated).toMatchObject({ id: draft.id, state: "ACTIVE" });
    const replayProvision = vi
      .spyOn(snapshots, "provisionReferenceProfile")
      .mockRejectedValue(
        new Error("storage must not be called for activation replay"),
      );
    const activatedReplay = await responseBody(
      commandAs(
        secondAdminCookie,
        secondAdminCsrfToken,
        `${createPath}/${draft.id}/activate`,
        { reason: "Verify immutable reference settings" },
        unavailableKey,
      ),
    );
    expect(activatedReplay).toEqual(activated);
    expect(replayProvision).not.toHaveBeenCalled();
    replayProvision.mockRestore();
    await expect(
      prisma.auditEvent.findMany({
        where: {
          correlationId: draft.id,
          eventType: "catalog.reference-profile.activated",
        },
        select: { operatorIdentityId: true },
      }),
    ).resolves.toEqual([{ operatorIdentityId: adminOperatorId }]);

    const retired = await responseBody(
      command(
        `${createPath}/${draft.id}/retire`,
        { reason: "Preserve activation replay evidence" },
        `catalog-activation-replay-retire-${randomUUID()}`,
      ),
    );
    expect(retired).toMatchObject({ id: draft.id, state: "RETIRED" });
    const afterAdvanceProvision = vi
      .spyOn(snapshots, "provisionReferenceProfile")
      .mockRejectedValue(
        new Error("storage must not be called for lifecycle-advanced replay"),
      );
    const replayAfterAdvance = await responseBody(
      commandAs(
        secondAdminCookie,
        secondAdminCsrfToken,
        `${createPath}/${draft.id}/activate`,
        { reason: "Verify immutable reference settings" },
        unavailableKey,
      ),
    );
    expect(replayAfterAdvance).toEqual(activated);
    expect(afterAdvanceProvision).not.toHaveBeenCalled();
    afterAdvanceProvision.mockRestore();

    const integrityDraft = await responseBody(
      command(
        createPath,
        {
          ...createBody,
          settings: { profile: "activation-integrity", testScope },
        },
        `catalog-activation-integrity-create-${randomUUID()}`,
      ),
    );
    const integrity = vi
      .spyOn(snapshots, "provisionReferenceProfile")
      .mockRejectedValue(
        new SlicerProfileSnapshotIntegrityError("snapshot metadata mismatches"),
      );
    const integrityActivation = await command(
      `${createPath}/${integrityDraft.id}/activate`,
      { reason: "Verify immutable reference settings" },
      `catalog-activation-integrity-${randomUUID()}`,
    );
    expect(integrityActivation.status).toBe(409);
    integrity.mockRestore();
    await expect(
      prisma.referenceProfile.findUniqueOrThrow({
        where: { id: integrityDraft.id },
      }),
    ).resolves.toMatchObject({ state: "DRAFT" });
    await expect(
      prisma.auditEvent.count({
        where: {
          correlationId: integrityDraft.id,
          eventType: "catalog.reference-profile.activated",
        },
      }),
    ).resolves.toBe(0);
  });

  it("rejects malformed command bodies, untrusted nodes, and catalog-write access", async () => {
    const noBodyPaths = [
      "/admin/catalog/reference-profiles",
      "/admin/catalog/machine-profiles",
      `/admin/catalog/reference-profiles/${randomUUID()}/activate`,
      `/admin/catalog/reference-profiles/${randomUUID()}/retire`,
      `/admin/catalog/machine-profiles/${fixture.machineProfileId}/activate`,
      `/admin/catalog/machine-profiles/${fixture.machineProfileId}/retire`,
      `/admin/nodes/${fixture.nodeId}/calibrations`,
      `/admin/nodes/${fixture.nodeId}/calibrations/${fixture.machineCalibrationId}/activate`,
      `/admin/nodes/${fixture.nodeId}/calibrations/${fixture.machineCalibrationId}/retire`,
      `/admin/nodes/${fixture.nodeId}/inventories`,
      `/admin/nodes/${fixture.nodeId}/machines/${fixture.machineId}/status`,
      `/admin/nodes/${fixture.nodeId}/inventories/${fixture.inventoryId}/status`,
      `/admin/nodes/${fixture.nodeId}/inventories/${fixture.inventoryId}/adjustments`,
    ];
    for (const path of noBodyPaths) {
      const response = await commandWithoutBody(
        path,
        `catalog-no-body-${randomUUID()}`,
      );
      expect(response.status, path).toBe(400);
    }

    const noReason = await command(
      `/admin/nodes/${fixture.nodeId}/machines/${fixture.machineId}/status`,
      { status: "ACTIVE" },
      `catalog-no-reason-${randomUUID()}`,
    );
    expect(noReason.status).toBe(400);

    const tooLong = await command(
      "/admin/catalog/reference-profiles",
      {
        material: "PLA",
        quality: "FINE",
        slicerEngine: "x".repeat(101),
        slicerVersion: "2.1.0",
        settings: { testScope },
      },
      `catalog-long-text-${randomUUID()}`,
    );
    expect(tooLong.status).toBe(400);

    const unicodeSku = `${"🧵".repeat(50)}-${randomUUID()}`;
    expect(Array.from(unicodeSku)).toHaveLength(87);
    expect(unicodeSku).toHaveLength(137);
    const unicodeSkuResponse = await command(
      `/admin/nodes/${fixture.nodeId}/inventories`,
      {
        machineId: fixture.machineId,
        sku: unicodeSku,
        material: "PLA",
        vendor: "Taven test",
        priceMinorUnitsNumerator: "1",
        priceMinorUnitsDenominator: "1",
        currency: "EUR",
        remainingMilligrams: "1",
      },
      `catalog-unicode-sku-${randomUUID()}`,
    );
    expect(unicodeSkuResponse.status).toBe(200);

    const unicodeReason = "🧵".repeat(600);
    expect(Array.from(unicodeReason)).toHaveLength(600);
    expect(unicodeReason).toHaveLength(1_200);
    const unicodeReasonResponse = await command(
      `/admin/nodes/${fixture.nodeId}/machines/${fixture.machineId}/status`,
      { status: "ACTIVE", reason: unicodeReason },
      `catalog-unicode-reason-${randomUUID()}`,
    );
    expect(unicodeReasonResponse.status).toBe(200);

    for (const [path, body] of [
      [
        `/admin/nodes/${fixture.nodeId}/inventories`,
        {
          machineId: fixture.machineId,
          sku: "catalog\u0000sku",
          material: "PLA",
          vendor: "Taven test",
          priceMinorUnitsNumerator: "1",
          priceMinorUnitsDenominator: "1",
          currency: "EUR",
          remainingMilligrams: "1",
        },
      ],
      [
        `/admin/nodes/${fixture.nodeId}/machines/${fixture.machineId}/status`,
        { status: "ACTIVE", reason: "repair\u0000note" },
      ],
      [
        `/admin/nodes/${fixture.nodeId}/inventories`,
        {
          machineId: fixture.machineId,
          sku: "catalog\ud800",
          material: "PLA",
          vendor: "Taven test",
          priceMinorUnitsNumerator: "1",
          priceMinorUnitsDenominator: "1",
          currency: "EUR",
          remainingMilligrams: "1",
        },
      ],
      [
        `/admin/nodes/${fixture.nodeId}/machines/${fixture.machineId}/status`,
        { status: "ACTIVE", reason: "repair\ud800" },
      ],
      [
        "/admin/catalog/reference-profiles",
        {
          material: "PLA",
          quality: "FINE",
          slicerEngine: "orca",
          slicerVersion: "2.1.0",
          settings: { note: "catalog\u0000setting" },
        },
      ],
      [
        "/admin/catalog/reference-profiles",
        {
          material: "PLA",
          quality: "FINE",
          slicerEngine: "orca",
          slicerVersion: "2.1.0",
          settings: { note: "catalog\ud800" },
        },
      ],
      [
        "/admin/catalog/reference-profiles",
        {
          material: "PLA",
          quality: "FINE",
          slicerEngine: "orca\ud800",
          slicerVersion: "2.1.0",
          settings: { testScope },
        },
      ],
    ] as const) {
      const response = await command(
        path,
        body,
        `catalog-invalid-text-${randomUUID()}`,
      );
      expect(response.status, path).toBe(400);
    }

    const intOverflow = await command(
      `/admin/nodes/${fixture.nodeId}/calibrations`,
      {
        machineId: fixture.machineId,
        flowRatioPartsPerMillion: 2_147_483_648,
        xyCompensationMicrometers: 0,
        elephantFootCompensationMicrometers: 0,
        settings: { testScope },
      },
      `catalog-int-overflow-${randomUUID()}`,
    );
    expect(intOverflow.status).toBe(400);

    const overflow = await command(
      `/admin/nodes/${fixture.nodeId}/inventories/${fixture.inventoryId}/adjustments`,
      {
        deltaMilligrams: "9223372036854775808",
        reason: "Invalid oversized correction",
      },
      `catalog-overflow-${randomUUID()}`,
    );
    expect(overflow.status).toBe(400);

    const balanceOverflow = await command(
      `/admin/nodes/${fixture.nodeId}/inventories/${fixture.inventoryId}/adjustments`,
      {
        deltaMilligrams: "9223372036854775807",
        reason: "Invalid balance overflow correction",
      },
      `catalog-balance-overflow-${randomUUID()}`,
    );
    expect(balanceOverflow.status).toBe(400);

    for (const deltaMilligrams of ["0", "-0"]) {
      const zeroAdjustment = await command(
        `/admin/nodes/${fixture.nodeId}/inventories/${fixture.inventoryId}/adjustments`,
        {
          deltaMilligrams,
          reason: "Invalid zero correction",
        },
        `catalog-zero-adjustment-${deltaMilligrams}-${randomUUID()}`,
      );
      expect(zeroAdjustment.status).toBe(400);
    }

    const snapshots = app.get(SlicerProfileSnapshotService);
    const invalidCalibrationProvision = vi
      .spyOn(snapshots, "provisionMachineCalibration")
      .mockRejectedValue(
        new Error("storage must not be called for invalid machine"),
      );
    const invalidCalibration = await command(
      `/admin/nodes/${fixture.nodeId}/calibrations`,
      {
        machineId: randomUUID(),
        flowRatioPartsPerMillion: 1_000_000,
        xyCompensationMicrometers: 0,
        elephantFootCompensationMicrometers: 0,
        settings: { testScope, invalidMachine: true },
      },
      `catalog-invalid-machine-${randomUUID()}`,
    );
    expect(invalidCalibration.status).toBe(404);
    expect(invalidCalibrationProvision).not.toHaveBeenCalled();
    invalidCalibrationProvision.mockRestore();

    const wrongNode = await command(
      `/admin/nodes/${randomUUID()}/inventories`,
      {
        machineId: fixture.machineId,
        sku: `catalog-wrong-node-${randomUUID()}`,
        material: "PLA",
        vendor: "Taven test",
        priceMinorUnitsNumerator: "1",
        priceMinorUnitsDenominator: "1",
        currency: "EUR",
        remainingMilligrams: "1",
      },
      `catalog-wrong-node-${randomUUID()}`,
    );
    expect(wrongNode.status).toBe(404);

    const incompatibleReference = await responseBody(
      command(
        "/admin/catalog/reference-profiles",
        {
          material: "PETG",
          quality: "FINE",
          slicerEngine: "orca",
          slicerVersion: "2.1.0",
          settings: { profile: "incompatible", testScope },
        },
        `catalog-incompatible-reference-${randomUUID()}`,
      ),
    );
    const machine = await prisma.machine.findUniqueOrThrow({
      where: { id: fixture.machineId },
      select: { machineCapabilityId: true },
    });
    const incompatibleProvision = vi
      .spyOn(snapshots, "provisionMachineProfile")
      .mockRejectedValue(
        new Error(
          "storage must not be called for incompatible machine profile",
        ),
      );
    const incompatibleProfile = await command(
      "/admin/catalog/machine-profiles",
      {
        machineCapabilityId: machine.machineCapabilityId,
        referenceProfileId: incompatibleReference.id,
        material: "PETG",
        quality: "FINE",
        slicerEngine: "orca",
        slicerVersion: "2.1.0",
        nozzleDiameterMicrometers: 400,
        productionArtifactFormat: "GCODE_3MF",
        settings: { profile: "incompatible" },
      },
      `catalog-incompatible-${randomUUID()}`,
    );
    expect(incompatibleProfile.status).toBe(409);
    expect(incompatibleProvision).not.toHaveBeenCalled();
    incompatibleProvision.mockRestore();

    const deepSettings = await command(
      "/admin/catalog/reference-profiles",
      {
        material: "PLA",
        quality: "FINE",
        slicerEngine: "orca",
        slicerVersion: "2.1.0",
        settings: nestedSettings(65),
      },
      `catalog-deep-settings-${randomUUID()}`,
    );
    expect(deepSettings.status).toBe(400);
    await expect(deepSettings.json()).resolves.toMatchObject({
      message: "settings must not exceed 64 levels",
    });

    const forbidden = await fetch(
      new URL(`/admin/nodes/${fixture.nodeId}/inventories`, baseUrl),
      {
        method: "POST",
        headers: {
          cookie: viewerCookie,
          "content-type": "application/json",
          "idempotency-key": `catalog-viewer-${randomUUID()}`,
          origin: "http://localhost:3002",
          "x-csrf-token": viewerCsrfToken,
        },
        body: JSON.stringify({}),
      },
    );
    expect(forbidden.status).toBe(403);
  });

  async function command(
    path: string,
    body: object,
    idempotencyKey: string,
  ): Promise<Response> {
    return commandAs(adminCookie, adminCsrfToken, path, body, idempotencyKey);
  }

  async function commandAs(
    cookie: string,
    csrfToken: string,
    path: string,
    body: object,
    idempotencyKey: string,
  ): Promise<Response> {
    return fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        origin: "http://localhost:3002",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify(body),
    });
  }

  async function commandWithoutBody(
    path: string,
    idempotencyKey: string,
  ): Promise<Response> {
    return fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        origin: "http://localhost:3002",
        "x-csrf-token": adminCsrfToken,
      },
    });
  }

  async function sessionCookie(
    role: "VIEWER" | "ADMIN",
    nodeId: string,
  ): Promise<{ cookie: string; csrfToken: string; operatorId: string }> {
    const identity = await prisma.operatorIdentity.create({
      data: {
        email: `operator-catalog-${randomUUID()}@example.test`,
        role,
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
        tokenHash: createHash("sha256").update(token).digest("hex"),
        csrfHash: createHash("sha256").update(csrfToken).digest("hex"),
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
});

async function responseBody(
  response: Promise<Response>,
): Promise<{ id: string; status?: string; state?: string }> {
  const resolved = await response;
  expect(resolved.status).toBe(200);
  return resolved.json() as Promise<{
    id: string;
    status?: string;
    state?: string;
  }>;
}

function nestedSettings(depth: number): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (let index = 1; index < depth; index += 1) {
    result = { nested: result };
  }
  return result;
}
