import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
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
  slicerSettingsSnapshot,
} from "../src/modules/slicing/slicer-profile-snapshot.service";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../src/modules/storage/object-storage.port";
import {
  PersistenceFactory,
  type PersistenceFoundation,
} from "./support/persistence-factory";

const uploadClientHashKey = "operator-catalog-test-upload-client-hash-key-32";
const quoteCapabilityKey =
  "operator-catalog-test-quote-capability-key-with-at-least-32-characters";
const testScope = randomUUID();

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

  it("registers immutable capability, machine and supported print config with replay", async () => {
    const capabilityBody = {
      capabilityKey: `operator-${randomUUID()}`,
      manufacturer: "Operator test",
      model: "V0",
      buildVolumeXMicrometers: "220000",
      buildVolumeYMicrometers: "220000",
      buildVolumeZMicrometers: "250000",
      supportedNozzleMicrometers: [400],
      supportedMaterials: ["PLA", "PETG"],
    };
    const key = `catalog-capability-${randomUUID()}`;
    const capability = await responseBody(
      command("/admin/catalog/machine-capabilities", capabilityBody, key),
    );
    await expect(
      command("/admin/catalog/machine-capabilities", capabilityBody, key).then(
        (response) => response.json(),
      ),
    ).resolves.toEqual(capability);
    expect(
      (
        await command(
          "/admin/catalog/machine-capabilities",
          { ...capabilityBody, model: "V1" },
          key,
        )
      ).status,
    ).toBe(409);

    const machineBody = {
      machineCapabilityId: capability.id,
      code: `machine-${randomUUID()}`.slice(0, 50),
      displayName: "Operator test machine",
      installedNozzleMicrometers: 400,
    };
    const machine = await responseBody(
      command(
        `/admin/nodes/${fixture.nodeId}/machines`,
        machineBody,
        `catalog-machine-${randomUUID()}`,
      ),
    );
    await expect(
      prisma.machine.findUnique({ where: { id: machine.id } }),
    ).resolves.toMatchObject({
      nodeId: fixture.nodeId,
      machineCapabilityId: capability.id,
    });
    expect(
      (
        await command(
          `/admin/nodes/${fixture.nodeId}/machines`,
          { ...machineBody, installedNozzleMicrometers: 600 },
          `catalog-machine-${randomUUID()}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await command(
          `/admin/nodes/${randomUUID()}/machines`,
          machineBody,
          `catalog-machine-${randomUUID()}`,
        )
      ).status,
    ).toBe(404);

    const configBody = {
      quality: "STANDARD",
      infillPercent: 35,
      layerHeightMicrometers: 200,
      supportsEnabled: false,
      brimEnabled: false,
      settings: overrideBundle({ testScope, infill: 35 }),
    };
    const config = await responseBody(
      command(
        "/admin/catalog/print-config-revisions",
        configBody,
        `catalog-config-${randomUUID()}`,
      ),
    );
    await expect(
      prisma.revisionIdentity.findUnique({ where: { id: config.id } }),
    ).resolves.toMatchObject({ kind: "PRINT_CONFIG" });
    expect(
      (
        await command(
          "/admin/catalog/print-config-revisions",
          { ...configBody, settings: machineBundle() },
          `catalog-config-${randomUUID()}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await commandAs(
          viewerCookie,
          viewerCsrfToken,
          "/admin/catalog/machine-capabilities",
          capabilityBody,
          `catalog-viewer-${randomUUID()}`,
        )
      ).status,
    ).toBe(403);
  });

  it("creates a validated immutable price list without publishing it", async () => {
    const baseline = await prisma.priceList.findUniqueOrThrow({
      where: {
        currency_revision: { currency: "CZK", revision: "automatic-v0-czk" },
      },
    });
    const parameters = JSON.parse(JSON.stringify(baseline.parameters)) as {
      automaticQuote: Record<string, unknown>;
      sellerTaxPolicy: Record<string, unknown>;
    };
    const body = {
      currency: "CZK",
      revision: `operator-${randomUUID()}`,
      termsRevision: baseline.termsRevision,
      parameters,
    };
    const key = `catalog-price-${randomUUID()}`;
    const created = await responseBody(
      command("/admin/catalog/price-lists", body, key),
    );
    await expect(
      command("/admin/catalog/price-lists", body, key).then((response) =>
        response.json(),
      ),
    ).resolves.toEqual(created);
    await expect(
      prisma.priceList.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      currency: "CZK",
      revision: body.revision,
      parameters,
    });
    const detail = await fetch(
      new URL(`/admin/catalog/price-lists/${created.id}`, baseUrl),
      {
        headers: { cookie: adminCookie },
      },
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: created.id,
      parameters,
    });
    for (const revision of ["legacy-v0-czk", "legacy-v0-eur"]) {
      const legacy = await prisma.priceList.findFirstOrThrow({
        where: { revision },
      });
      const legacyDetail = await fetch(
        new URL(`/admin/catalog/price-lists/${legacy.id}`, baseUrl),
        { headers: { cookie: adminCookie } },
      );
      expect(legacyDetail.status).toBe(200);
      await expect(legacyDetail.json()).resolves.toMatchObject({
        id: legacy.id,
        parameters: {
          sellerTaxPolicy: {
            regime: "NON_VAT_PAYER",
            vatRateBasisPoints: 0,
          },
          balance_payment_days: 7,
          balance_timeout_earned_component_kinds: [
            "ITEM_PRODUCTION",
            "ITEM_QUANTITY",
            "ITEM_POSTPROCESSING",
          ],
        },
      });
    }
    const unsafe = {
      ...body,
      revision: `operator-${randomUUID()}`,
      parameters: {
        ...parameters,
        automaticQuote: {
          ...parameters.automaticQuote,
          expressMaximumPlateCount: "3",
        },
      },
    };
    expect(
      (
        await command(
          "/admin/catalog/price-lists",
          unsafe,
          `catalog-price-${randomUUID()}`,
        )
      ).status,
    ).toBe(400);
    for (const [index, automaticQuote] of [
      { minimumPrintPriceMinor: "9007199254740992" },
      { minimumPrintPriceMinor: "5000000000000000" },
      { paymentFeeFixedMinor: "9007199254740991" },
      {
        shipmentCategories: (
          parameters.automaticQuote.shipmentCategories as Record<
            string,
            unknown
          >[]
        ).map((category, index) =>
          index === 0
            ? { ...category, customerShippingRateMinor: "9007199254741" }
            : category,
        ),
      },
    ].entries()) {
      const rejected = await command(
        "/admin/catalog/price-lists",
        {
          ...body,
          revision: `unsafe-money-${randomUUID()}`,
          parameters: {
            ...parameters,
            automaticQuote: { ...parameters.automaticQuote, ...automaticQuote },
          },
        },
        `catalog-price-${randomUUID()}`,
      );
      expect(rejected.status, `unsafe monetary case ${index}`).toBe(400);
    }
    for (const feeRate of [9_000, 10_000]) {
      const rejected = await command(
        "/admin/catalog/price-lists",
        {
          ...body,
          revision: `unsustainable-fee-${randomUUID()}`,
          parameters: {
            ...parameters,
            sellerTaxPolicy: {
              regime: "VAT_PAYER",
              vatRateBasisPoints: 2_100,
            },
            automaticQuote: {
              ...parameters.automaticQuote,
              paymentFeeRateBasisPoints: feeRate,
            },
          },
        },
        `catalog-price-${randomUUID()}`,
      );
      expect(rejected.status, `unsafe fee rate ${feeRate}`).toBe(400);
    }
    const selectedBeforeUnsafeActivation =
      await prisma.commercialPolicySelection.findUniqueOrThrow({
        where: { currency: "CZK" },
      });
    for (const unsafeParameters of [
      {
        ...parameters,
        automaticQuote: {
          ...parameters.automaticQuote,
          minimumPrintPriceMinor: "9007199254740992",
        },
      },
      {
        ...parameters,
        sellerTaxPolicy: {
          regime: "VAT_PAYER",
          vatRateBasisPoints: 2_100,
        },
        automaticQuote: {
          ...parameters.automaticQuote,
          paymentFeeRateBasisPoints: 9_000,
        },
      },
    ]) {
      const persistedUnsafeList = await prisma.priceList.create({
        data: {
          revision: `persisted-unsafe-policy-${randomUUID()}`,
          termsRevision: baseline.termsRevision,
          currency: "CZK",
          parameters: unsafeParameters as Prisma.InputJsonObject,
        },
      });
      expect(
        (
          await command(
            `/admin/catalog/price-lists/${persistedUnsafeList.id}/activate`,
            {
              expectedSelectionVersion:
                selectedBeforeUnsafeActivation.selectionVersion,
              reason: "Reject unsafe persisted commercial configuration",
            },
            `catalog-unsafe-activation-${randomUUID()}`,
          )
        ).status,
      ).toBe(400);
    }
    await expect(
      prisma.commercialPolicySelection.findUniqueOrThrow({
        where: { currency: "CZK" },
      }),
    ).resolves.toMatchObject({
      priceListId: selectedBeforeUnsafeActivation.priceListId,
      selectionVersion: selectedBeforeUnsafeActivation.selectionVersion,
    });
    expect(
      (
        await command(
          "/admin/catalog/price-lists",
          {
            ...body,
            revision: `operator-${randomUUID()}`,
            parameters: { ...parameters, unsupported: true },
          },
          `catalog-price-${randomUUID()}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await commandAs(
          viewerCookie,
          viewerCsrfToken,
          "/admin/catalog/price-lists",
          body,
          `catalog-viewer-${randomUUID()}`,
        )
      ).status,
    ).toBe(403);
  });

  it("publishes one selected list with version CAS, replay, audit and a shared-row fence", async () => {
    const original = await prisma.commercialPolicySelection.findUniqueOrThrow({
      where: { currency: "CZK" },
      include: { priceList: true },
    });
    const body = {
      currency: "CZK",
      revision: `publication-${randomUUID()}`,
      termsRevision: original.priceList.termsRevision,
      parameters: original.priceList.parameters,
    };
    const created = await responseBody(
      command(
        "/admin/catalog/price-lists",
        body,
        `catalog-price-${randomUUID()}`,
      ),
    );
    const path = `/admin/catalog/price-lists/${created.id}/activate`;
    const input = {
      expectedSelectionVersion: original.selectionVersion,
      reason: "Publish tested commercial list",
    };
    const key = `commercial-activation-${randomUUID()}`;
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT currency FROM commercial_policy_selections
         WHERE currency = 'CZK' FOR SHARE`,
      );
      let settled = false;
      const activation = command(path, input, key).then(async (response) => {
        settled = true;
        expect(response.status).toBe(200);
        return response.json() as Promise<{
          priceListId: string;
          selectionVersion: number;
        }>;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      const result = await activation;
      expect(result).toMatchObject({
        priceListId: created.id,
        selectionVersion: original.selectionVersion + 1,
      });
      const selected = await prisma.commercialPolicySelection.findUniqueOrThrow(
        {
          where: { currency: "CZK" },
        },
      );
      expect(selected.priceListId).toBe(created.id);
      expect(selected.selectionVersion).toBe(original.selectionVersion + 1);
      const replay = await command(path, input, key);
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual(result);
      expect(
        (
          await prisma.commercialPolicySelection.findUniqueOrThrow({
            where: { currency: "CZK" },
          })
        ).selectionVersion,
      ).toBe(original.selectionVersion + 1);
      expect(
        await prisma.auditEvent.count({
          where: { eventType: "catalog.commercial-policy.activated" },
        }),
      ).toBeGreaterThan(0);
      expect(
        (await command(path, input, `commercial-stale-${randomUUID()}`)).status,
      ).toBe(409);
      expect(
        (
          await commandAs(
            viewerCookie,
            viewerCsrfToken,
            path,
            { ...input, expectedSelectionVersion: result.selectionVersion },
            `commercial-viewer-${randomUUID()}`,
          )
        ).status,
      ).toBe(403);
      const withoutCsrf = await fetch(new URL(path, baseUrl), {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
          "idempotency-key": `commercial-no-csrf-${randomUUID()}`,
          origin: "http://localhost:3002",
        },
        body: JSON.stringify({
          expectedSelectionVersion: result.selectionVersion,
          reason: "Missing CSRF proof",
        }),
      });
      expect(withoutCsrf.status).toBe(403);
      const eurList = await prisma.priceList.findUniqueOrThrow({
        where: {
          currency_revision: { currency: "EUR", revision: "legacy-v0-eur" },
        },
      });
      expect(
        (
          await command(
            `/admin/catalog/price-lists/${eurList.id}/activate`,
            {
              expectedSelectionVersion: result.selectionVersion,
              reason: "Wrong currency",
            },
            `commercial-wrong-currency-${randomUUID()}`,
          )
        ).status,
      ).toBe(400);
      const read = await fetch(
        new URL("/admin/catalog/commercial-policy-selections/CZK", baseUrl),
        { headers: { cookie: adminCookie } },
      );
      expect(read.status).toBe(200);
      await expect(read.json()).resolves.toMatchObject({
        currency: "CZK",
        priceListId: created.id,
        selectionVersion: result.selectionVersion,
      });
      const sameTarget = await command(
        path,
        {
          expectedSelectionVersion: result.selectionVersion,
          reason: "Confirm same revision",
        },
        `commercial-same-${randomUUID()}`,
      );
      expect(sameTarget.status).toBe(200);
      const same = (await sameTarget.json()) as { selectionVersion: number };
      expect(same.selectionVersion).toBe(result.selectionVersion + 1);
      const rollback = await command(
        `/admin/catalog/price-lists/${original.priceListId}/activate`,
        {
          expectedSelectionVersion: same.selectionVersion,
          reason: "Restore baseline policy after publication test",
        },
        `commercial-restore-${randomUUID()}`,
      );
      expect(rollback.status).toBe(200);
      await expect(rollback.json()).resolves.toMatchObject({
        priceListId: original.priceListId,
        selectionVersion: same.selectionVersion + 1,
      });
      const afterRollbackVersion = same.selectionVersion + 1;
      expect(
        (await command(path, input, `commercial-aba-stale-${randomUUID()}`))
          .status,
      ).toBe(409);
      const auditCountBeforeRace = await prisma.auditEvent.count({
        where: { eventType: "catalog.commercial-policy.activated" },
      });
      const competing = await Promise.all(
        ["first", "second"].map((suffix) =>
          command(
            `/admin/catalog/price-lists/${original.priceListId}/activate`,
            {
              expectedSelectionVersion: afterRollbackVersion,
              reason: `Concurrent publication ${suffix}`,
            },
            `commercial-concurrent-${randomUUID()}`,
          ),
        ),
      );
      expect(competing.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      expect(
        await prisma.auditEvent.count({
          where: { eventType: "catalog.commercial-policy.activated" },
        }),
      ).toBe(auditCountBeforeRace + 1);
      await expect(
        prisma.commercialPolicySelection.findUniqueOrThrow({
          where: { currency: "CZK" },
        }),
      ).resolves.toMatchObject({
        priceListId: original.priceListId,
        selectionVersion: afterRollbackVersion + 1,
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("receives and corrects a lot, mounts it, and publishes bounded machine availability", async () => {
    const receiptPath = `/admin/nodes/${fixture.nodeId}/inventory-receipts`;
    const receiptBody = {
      machineId: fixture.machineId,
      sku: `received-${randomUUID()}`,
      material: "PLA",
      vendor: "Original vendor",
      color: "blue",
      lotCode: "receipt-test",
      priceMinorUnitsNumerator: "7",
      priceMinorUnitsDenominator: "100",
      currency: "CZK",
      remainingMilligrams: "500",
      purchasedAt: new Date(Date.now() - 86_400_000).toISOString(),
    };
    const receiptKey = `catalog-receipt-${randomUUID()}`;
    const received = await responseBody(
      command(receiptPath, receiptBody, receiptKey),
    );
    expect(received.status).toBe("AVAILABLE");
    expect(
      await responseBody(command(receiptPath, receiptBody, receiptKey)),
    ).toEqual(received);
    const detailPath = `/admin/nodes/${fixture.nodeId}/inventories/${received.id}`;
    const detailResponse = await fetch(new URL(detailPath, baseUrl), {
      headers: { cookie: viewerCookie },
    });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      mountStatus: string;
      receiptCoverage: string;
      receipts: Array<{ id: string; kind: string; receivedMilligrams: string }>;
    };
    expect(detail).toMatchObject({
      mountStatus: "UNMOUNTED",
      receiptCoverage: "RECORDED",
    });
    expect(detail.receipts).toMatchObject([
      { kind: "INITIAL", receivedMilligrams: "500" },
    ]);
    const firstReceiptId = detail.receipts[0]?.id;
    if (!firstReceiptId) throw new Error("initial receipt was not returned");
    const correctionPath = `${detailPath}/receipt-corrections`;
    const correctionBody = {
      supersedesReceiptId: firstReceiptId,
      receivedMilligrams: "500",
      vendor: "Correct vendor",
      priceMinorUnitsNumerator: "8",
      priceMinorUnitsDenominator: "100",
      currency: "CZK",
      purchasedAt: receiptBody.purchasedAt,
      reason: "Correct purchase document",
    };
    expect(
      (
        await command(
          correctionPath,
          correctionBody,
          `catalog-correct-${randomUUID()}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(
          correctionPath,
          correctionBody,
          `catalog-correct-${randomUUID()}`,
        )
      ).status,
    ).toBe(409);
    const corrected = await prisma.inventory.findUniqueOrThrow({
      where: { id: received.id },
    });
    expect(corrected).toMatchObject({
      vendor: "Correct vendor",
      priceMinorUnitsNumerator: 8n,
      remainingMilligrams: 500n,
    });
    const legacy = await responseBody(
      command(
        `/admin/nodes/${fixture.nodeId}/inventories`,
        {
          ...receiptBody,
          sku: `legacy-${randomUUID()}`,
          remainingMilligrams: "300",
          purchasedAt: undefined,
        },
        `catalog-legacy-${randomUUID()}`,
      ),
    );
    const legacyDetail = await fetch(
      new URL(
        `/admin/nodes/${fixture.nodeId}/inventories/${legacy.id}`,
        baseUrl,
      ),
      {
        headers: { cookie: viewerCookie },
      },
    );
    expect(await legacyDetail.json()).toMatchObject({
      receiptCoverage: "UNKNOWN",
      mountStatus: "UNKNOWN",
    });
    const initialPath = `/admin/nodes/${fixture.nodeId}/inventories/${legacy.id}/initial-receipt`;
    const initialBody = {
      receivedMilligrams: "400",
      vendor: "Attested vendor",
      priceMinorUnitsNumerator: "5",
      priceMinorUnitsDenominator: "100",
      currency: "CZK",
      purchasedAt: receiptBody.purchasedAt,
      reason: "Original invoice located",
    };
    const initialKey = `catalog-initial-${randomUUID()}`;
    expect(
      (
        await command(
          initialPath,
          { ...initialBody, receivedMilligrams: "299" },
          `catalog-initial-${randomUUID()}`,
        )
      ).status,
    ).toBe(409);
    const attested = await responseBody(
      command(initialPath, initialBody, initialKey),
    );
    expect(
      await responseBody(command(initialPath, initialBody, initialKey)),
    ).toEqual(attested);
    expect(
      (
        await command(
          initialPath,
          initialBody,
          `catalog-initial-${randomUUID()}`,
        )
      ).status,
    ).toBe(409);
    await expect(
      prisma.inventory.findUnique({ where: { id: legacy.id } }),
    ).resolves.toMatchObject({
      vendor: "Attested vendor",
      priceMinorUnitsNumerator: 5n,
      remainingMilligrams: 300n,
    });
    const mountPath = `${detailPath}/mount`;
    expect(
      (
        await command(
          mountPath,
          { mountStatus: "MOUNTED", reason: "Loaded on machine" },
          `catalog-mount-${randomUUID()}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(
          mountPath,
          { mountStatus: "UNMOUNTED", reason: "Removed from machine" },
          `catalog-mount-${randomUUID()}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(
          `/admin/nodes/${randomUUID()}/inventories/${received.id}/mount`,
          { mountStatus: "MOUNTED", reason: "Wrong node" },
          `catalog-mount-${randomUUID()}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await commandAs(
          viewerCookie,
          viewerCsrfToken,
          mountPath,
          { mountStatus: "MOUNTED", reason: "Wrong role" },
          `catalog-mount-${randomUUID()}`,
        )
      ).status,
    ).toBe(403);

    const availabilityPath = `/admin/nodes/${fixture.nodeId}/machines/${fixture.machineId}/availability`;
    const start = new Date(Date.now() + 3_600_000);
    const stop = new Date(start.getTime() + 3_600_000);
    const availabilityBody = {
      expectedVersion: 1,
      reason: "Staffed print shift",
      windows: [{ startsAt: start.toISOString(), endsAt: stop.toISOString() }],
    };
    const availabilityKey = `catalog-availability-${randomUUID()}`;
    const published = await responseBody(
      command(availabilityPath, availabilityBody, availabilityKey),
    );
    expect(
      await responseBody(
        command(availabilityPath, availabilityBody, availabilityKey),
      ),
    ).toEqual(published);
    expect(
      (
        await command(
          availabilityPath,
          {
            ...availabilityBody,
            expectedVersion: 2,
            reason: "LEGACY_LIVE_RESERVATION_BOOTSTRAP",
          },
          `catalog-reserved-reason-${randomUUID()}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await command(
          availabilityPath,
          availabilityBody,
          `catalog-availability-${randomUUID()}`,
        )
      ).status,
    ).toBe(409);
    const read = await fetch(
      new URL(
        `${availabilityPath}?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(stop.toISOString())}`,
        baseUrl,
      ),
      {
        headers: { cookie: viewerCookie },
      },
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      machineId: fixture.machineId,
      revisionId: published.id,
      selectionVersion: 2,
      windows: [
        {
          ordinal: 0,
          startsAt: start.toISOString(),
          endsAt: stop.toISOString(),
        },
      ],
      occupiedIntervals: [],
    });
    expect(
      (
        await fetch(
          new URL(
            `${availabilityPath}?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(stop.toISOString())}&extra=1`,
            baseUrl,
          ),
          { headers: { cookie: viewerCookie } },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          new URL(
            `/admin/nodes/${randomUUID()}/machines/${fixture.machineId}/availability?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(stop.toISOString())}`,
            baseUrl,
          ),
          { headers: { cookie: viewerCookie } },
        )
      ).status,
    ).toBe(404);
  });

  it("writes revision and node catalog resources with idempotency and audit evidence", async () => {
    const referenceKey = `catalog-reference-${randomUUID()}`;
    const referenceBody = {
      material: "PLA",
      quality: "FINE",
      slicerEngine: "orca",
      slicerVersion: "2.1.0",
      settings: machineBundle({
        layerHeight: 120,
        profile: "operator-catalog",
        testScope,
      }),
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
          settings: overrideBundle({ testScope, zOffset: -5 }),
        },
        `catalog-calibration-${randomUUID()}`,
      ),
    );
    expect(calibration.state).toBe("DRAFT");
    await expect(
      prisma.revisionIdentity.findMany({
        where: {
          id: { in: [reference.id, machineProfile.id, calibration.id] },
        },
        select: { id: true, kind: true, digest: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reference.id,
          kind: "REFERENCE_PROFILE",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          id: machineProfile.id,
          kind: "MACHINE_PROFILE",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          id: calibration.id,
          kind: "MACHINE_CALIBRATION",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
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
      settings: machineBundle({ profile: "activation-gate", testScope }),
    };

    const createKey = `catalog-draft-only-${randomUUID()}`;
    const provision = vi.spyOn(snapshots, "provisionReferenceProfile");
    const draft = await responseBody(
      command(createPath, createBody, createKey),
    );
    expect(draft.state).toBe("DRAFT");
    expect(provision).not.toHaveBeenCalled();
    const draftNoticePage = await fetch(
      new URL("/admin/catalog/reference-profile-activation-notices", baseUrl),
      { headers: { cookie: viewerCookie } },
    );
    expect(draftNoticePage.status).toBe(200);
    const draftNotices = (await draftNoticePage.json()) as {
      items: Array<{ referenceProfileId: string }>;
    };
    expect(draftNotices.items).not.toContainEqual(
      expect.objectContaining({ referenceProfileId: draft.id }),
    );

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
          settings: machineBundle({
            é: "composed",
            "e\u0301": "decomposed",
            testScope,
          }),
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
          settings: machineBundle({
            testScope,
            "e\u0301": "decomposed",
            é: "composed",
          }),
        },
        unicodeOrderKey,
      ),
    );
    expect(unicodeOrderReplay).toEqual(unicodeOrderFirst);

    const concurrentKey = `catalog-concurrent-same-${randomUUID()}`;
    const concurrentBody = {
      ...createBody,
      settings: machineBundle({ profile: "concurrent-same", testScope }),
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

    const [priceListCount, outboxCount] = await Promise.all([
      prisma.priceList.count(),
      prisma.outboxMessage.count(),
    ]);
    const activated = await responseBody(
      command(
        `${createPath}/${draft.id}/activate`,
        { reason: "Verify immutable reference settings" },
        unavailableKey,
      ),
    );
    expect(activated).toMatchObject({
      id: draft.id,
      state: "ACTIVE",
      notice: {
        id: `reference-profile-activated:${draft.id.toLowerCase()}`,
        schemaVersion: 1,
        kind: "REFERENCE_PROFILE_ACTIVATED",
        referenceProfileId: draft.id,
        material: "PLA",
        quality: "FINE",
        activatedAt: expect.any(String),
        action: "REVIEW_PRICE_LIST",
      },
    });
    await expect(prisma.priceList.count()).resolves.toBe(priceListCount);
    await expect(prisma.outboxMessage.count()).resolves.toBe(outboxCount);
    const activationNotices = await fetch(
      new URL("/admin/catalog/reference-profile-activation-notices", baseUrl),
      { headers: { cookie: viewerCookie } },
    );
    expect(activationNotices.status).toBe(200);
    const activationNoticePage = (await activationNotices.json()) as {
      items: Array<{ id: string; referenceProfileId: string; action: string }>;
    };
    expect(activationNoticePage.items).toContainEqual(
      expect.objectContaining({
        id: `reference-profile-activated:${draft.id.toLowerCase()}`,
        referenceProfileId: draft.id,
        action: "REVIEW_PRICE_LIST",
      }),
    );
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
    const retiredNoticePage = await fetch(
      new URL("/admin/catalog/reference-profile-activation-notices", baseUrl),
      { headers: { cookie: viewerCookie } },
    );
    expect(retiredNoticePage.status).toBe(200);
    const retiredNotices = (await retiredNoticePage.json()) as {
      items: Array<{ id: string; referenceProfileId: string }>;
    };
    expect(retiredNotices.items).toContainEqual(
      expect.objectContaining({
        id: `reference-profile-activated:${draft.id.toLowerCase()}`,
        referenceProfileId: draft.id,
      }),
    );
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
          settings: machineBundle({
            profile: "activation-integrity",
            testScope,
          }),
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

  it("accepts initial UTF-16 reference-profile snapshot bytes and object keys", async () => {
    const settings = machineBundle({ a: 1, B: 2 });
    const snapshot = slicerSettingsSnapshot(settings);
    const objects = app.get<ObjectStorage>(OBJECT_STORAGE);
    await objects.putImmutableObject({
      objectKey: snapshot.objectKey,
      contentType: "application/json",
      contentHash: snapshot.contentSha256,
      bytes: snapshot.bytes,
    });
    const created = await responseBody(
      command(
        "/admin/catalog/reference-profiles",
        {
          material: "PLA",
          quality: "FINE",
          slicerEngine: "orca",
          slicerVersion: "2.1.0",
          settings,
        },
        `catalog-initial-snapshot-${randomUUID()}`,
      ),
    );
    await expect(
      prisma.referenceProfile.findUniqueOrThrow({ where: { id: created.id } }),
    ).resolves.toMatchObject({ settings, state: "DRAFT" });

    const activated = await responseBody(
      command(
        `/admin/catalog/reference-profiles/${created.id}/activate`,
        { reason: "Verify initial immutable snapshot" },
        `catalog-initial-snapshot-activate-${randomUUID()}`,
      ),
    );
    expect(activated).toMatchObject({ id: created.id, state: "ACTIVE" });
    await expect(
      objects.readObjectRange(snapshot.objectKey, 0, snapshot.bytes.byteLength),
    ).resolves.toEqual(new Uint8Array(snapshot.bytes));
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

    const incompatibleInventory = await command(
      `/admin/nodes/${fixture.nodeId}/inventories`,
      {
        machineId: fixture.machineId,
        sku: `catalog-incompatible-inventory-${randomUUID()}`,
        material: "PETG",
        vendor: "Taven test",
        priceMinorUnitsNumerator: "1",
        priceMinorUnitsDenominator: "1",
        currency: "EUR",
        remainingMilligrams: "1",
      },
      `catalog-incompatible-inventory-${randomUUID()}`,
    );
    expect(incompatibleInventory.status).toBe(409);

    const incompatibleReference = await responseBody(
      command(
        "/admin/catalog/reference-profiles",
        {
          material: "PETG",
          quality: "FINE",
          slicerEngine: "orca",
          slicerVersion: "2.1.0",
          settings: machineBundle({ profile: "incompatible", testScope }),
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
        settings: machineBundle({ profile: "incompatible" }),
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
        settings: machineBundle(nestedSettings(65)),
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

  it("rejects availability publication that would strand a live reservation", async () => {
    const client = await pool.connect();
    let nodeId: string;
    let machineId: string;
    let planId: string;
    try {
      await client.query("BEGIN");
      const fixtures = new PersistenceFactory(
        client,
        `availability-live-${randomUUID()}`,
      );
      const foundation = await fixtures.createFoundation("availability-live");
      const now = Date.now();
      const production = await fixtures.planProduction(
        foundation,
        "availability-live-production",
        {
          startsAt: new Date(now + 3_600_000),
          endsAt: new Date(now + 7_200_000),
        },
      );
      await client.query(
        "UPDATE inventories SET remaining_milligrams = 1000 WHERE id = $1",
        [foundation.inventoryId],
      );
      await fixtures.createResourcePlan(foundation, [production]);
      await client.query("COMMIT");
      nodeId = foundation.nodeId;
      machineId = foundation.machineId;
      planId = foundation.phaseResourcePlanId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await pool.query(
      "SELECT * FROM taven_create_phase_reservation($1, $2, $3)",
      [nodeId, planId, `availability-live-${randomUUID()}`],
    );
    const live = await pool.query<{ id: string }>(
      `SELECT id FROM capacity_reservations WHERE machine_id = $1
         AND status IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')`,
      [machineId],
    );
    const path = `/admin/nodes/${nodeId}/machines/${machineId}/availability`;
    const scopedAdmin = await sessionCookie("ADMIN", nodeId);
    const response = await commandAs(
      scopedAdmin.cookie,
      scopedAdmin.csrfToken,
      path,
      {
        expectedVersion: 1,
        reason: "Pause all future work",
        windows: [],
      },
      `availability-shrink-${randomUUID()}`,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      conflictReservationIds: live.rows.map(({ id }) => id),
    });
    await expect(
      prisma.machineAvailabilitySelection.findUnique({
        where: { machineId_nodeId: { machineId, nodeId } },
      }),
    ).resolves.toMatchObject({ selectionVersion: 1 });
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

async function responseBody(response: Promise<Response>): Promise<{
  id: string;
  status?: string;
  state?: string;
  notice?: Record<string, unknown>;
}> {
  const resolved = await response;
  expect(resolved.status).toBe(200);
  return resolved.json() as Promise<{
    id: string;
    status?: string;
    state?: string;
    notice?: Record<string, unknown>;
  }>;
}

function nestedSettings(depth: number): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (let index = 1; index < depth; index += 1) {
    result = { nested: result };
  }
  return result;
}
