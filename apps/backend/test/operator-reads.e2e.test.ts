import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { configureHttpBodyParsers } from "../src/http-body.config";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  OBJECT_STORAGE,
  type StoredObjectMetadata,
} from "../src/modules/storage/object-storage.port";
import {
  PersistenceFactory,
  testTimes,
  type PersistenceFoundation,
  type ProductionReservationFixture,
} from "./support/persistence-factory";

const uploadClientHashKey = "operator-reads-test-upload-client-hash-key-32";
const quoteCapabilityKey =
  "operator-reads-test-quote-capability-key-with-at-least-32-characters";
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

describe("operator read contracts", () => {
  let app: NestExpressApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let pool: Pool;
  let nodeId: string;
  let fixture: PersistenceFoundation;
  let fixtureJob: ProductionReservationFixture;
  let viewerCookie: string;
  let viewerCsrfToken: string;
  let foreignCookie: string;
  let foreignAdminCookie: string;
  let foreignAdminCsrfToken: string;
  let adminCookie: string;
  let adminCsrfToken: string;
  const storedObjects = new Map<string, StoredObjectMetadata>();
  const headObject = vi.fn(
    async (key: string) => storedObjects.get(key) ?? null,
  );
  const putImmutableObject = vi.fn(
    async (input: {
      objectKey: string;
      bytes: Uint8Array;
      contentHash: string;
      contentType: string;
    }) => {
      storedObjects.set(input.objectKey, {
        contentType: input.contentType,
        contentLength: input.bytes.byteLength,
        contentHash: input.contentHash,
      });
    },
  );
  const createDownloadUrl = vi.fn(
    async ({ expiresAt }: { objectKey: string; expiresAt: Date }) => ({
      url: "https://storage.example.test/signed?token=opaque",
      method: "GET" as const,
      requiredHeaders: {},
      expiresAt,
    }),
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OBJECT_STORAGE)
      .useValue({ headObject, putImmutableObject, createDownloadUrl })
      .compile();
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
        `operator-reads-${randomUUID()}`,
      );
      fixture = await fixtures.createFoundation("operator-reads");
      fixtureJob = await fixtures.planProduction(
        fixture,
        "operator-reads-job",
        { startsAt: testTimes.capacityStart, endsAt: testTimes.capacityEnd },
      );
      await fixtures.createResourcePlan(fixture, [fixtureJob]);
      await client.query(
        "UPDATE inventories SET remaining_milligrams = 1000 WHERE id = $1",
        [fixture.inventoryId],
      );
      const reserved = await client.query<{ phase_reservation_set_id: string }>(
        "SELECT * FROM taven_create_phase_reservation($1, $2, $3)",
        [
          fixture.nodeId,
          fixture.phaseResourcePlanId,
          `operator-reads-${randomUUID()}`,
        ],
      );
      const reservationSetId = reserved.rows[0]?.phase_reservation_set_id;
      if (!reservationSetId) {
        throw new Error("fixture reservation was not created");
      }
      const reservation = await client.query<{ id: string }>(
        `SELECT id FROM production_reservations
         WHERE phase_reservation_set_id = $1
           AND phase_resource_plan_job_id = $2`,
        [reservationSetId, fixtureJob.phaseResourcePlanJobId],
      );
      const productionReservationId = reservation.rows[0]?.id;
      if (!productionReservationId) {
        throw new Error("fixture production reservation was not created");
      }
      await client.query(
        "UPDATE inventory_reservations SET status = 'HELD' WHERE production_reservation_id = $1",
        [productionReservationId],
      );
      await client.query(
        "UPDATE capacity_reservations SET status = 'HELD' WHERE production_reservation_id = $1",
        [productionReservationId],
      );
      await fixtures.createJob(fixture, fixtureJob);
      await client.query(
        "UPDATE production_reservations SET status = 'HELD', job_id = $2 WHERE id = $1",
        [productionReservationId, fixtureJob.jobId],
      );
      await client.query(
        "UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1",
        [reservationSetId],
      );
      await fixtures.activatePayment(fixture);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    nodeId = fixture.nodeId;
    const source = await prisma.modelFile.findUniqueOrThrow({
      where: { id: fixture.modelFileId },
    });
    storedObjects.set(source.storageObjectKey, {
      contentType: "model/stl",
      contentLength: Number(source.sizeBytes),
      contentHash: source.contentHash,
    });
    const viewerSession = await sessionCookie("VIEWER", nodeId);
    viewerCookie = viewerSession.cookie;
    viewerCsrfToken = viewerSession.csrfToken;
    const foreignNode = await prisma.node.create({
      data: {
        code: `foreign-${randomBytes(8).toString("hex")}`,
        name: "Foreign test node",
        timeZone: "Europe/Prague",
      },
    });
    foreignCookie = (await sessionCookie("VIEWER", foreignNode.id)).cookie;
    const foreignAdminSession = await sessionCookie("ADMIN", foreignNode.id);
    foreignAdminCookie = foreignAdminSession.cookie;
    foreignAdminCsrfToken = foreignAdminSession.csrfToken;
    const adminSession = await sessionCookie("ADMIN", nodeId);
    adminCookie = adminSession.cookie;
    adminCsrfToken = adminSession.csrfToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("exposes global catalog and node-scoped pages to operations readers", async () => {
    for (const path of [
      "/admin/catalog/reference-profiles?limit=1",
      "/admin/catalog/reference-profile-activation-notices?limit=1",
      "/admin/catalog/machine-profiles?limit=1",
      "/admin/catalog/print-config-revisions?limit=1",
      "/admin/catalog/price-lists?limit=1",
      "/admin/catalog/machine-capabilities?limit=1",
      `/admin/nodes/${nodeId}/machines?limit=1`,
      `/admin/nodes/${nodeId}/inventories?limit=1`,
      `/admin/nodes/${nodeId}/calibrations?limit=1`,
      `/admin/nodes/${nodeId}/capacity-reservations?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z&limit=1`,
    ]) {
      const response = await read(path);
      expect(response.status, path).toBe(200);
      await expect(response.json(), path).resolves.toMatchObject({
        items: expect.any(Array),
      });
    }
  });

  it("recovers an open handling timer and pages its completed allocations within node scope", async () => {
    const start = await fetch(
      new URL("/admin/handling-sessions/start", baseUrl),
      {
        method: "POST",
        headers: {
          cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "idempotency-key": randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ component: "HANDLING_ORDER_FIX" }),
      },
    );
    expect(start.status).toBe(200);
    const started = (await start.json()) as { id: string; status: string };
    expect(started.status).toBe("OPEN");

    const open = await read(
      "/admin/handling-sessions?lifecycle=OPEN&limit=100",
    );
    expect(open.status).toBe(200);
    await expect(open.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: started.id, lifecycle: "OPEN" }),
      ]),
    });
    const detail = await read(`/admin/handling-sessions/${started.id}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: started.id,
      lifecycle: "OPEN",
      allocations: [],
      laborRatePolicyVersion: expect.any(String),
    });
    expect(
      (
        await fetch(
          new URL(`/admin/handling-sessions/${started.id}`, baseUrl),
          { headers: { cookie: foreignCookie } },
        )
      ).status,
    ).toBe(404);

    const stop = await fetch(
      new URL(`/admin/handling-sessions/${started.id}/stop`, baseUrl),
      {
        method: "POST",
        headers: {
          cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "idempotency-key": randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          allocations: [{ orderId: fixture.orderId, servedUnitCount: "1" }],
        }),
      },
    );
    expect(stop.status).toBe(200);
    const page = await read(
      `/admin/handling-sessions?lifecycle=COMPLETED&orderId=${fixture.orderId}&limit=1`,
    );
    expect(page.status).toBe(200);
    await expect(page.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: started.id,
          lifecycle: "COMPLETED",
          allocations: [
            expect.objectContaining({
              orderId: fixture.orderId,
              allocatedDurationMilliseconds: expect.any(String),
              allocatedCostMinor: expect.any(String),
            }),
          ],
        }),
      ],
    });
    const completed = (await (
      await read(`/admin/handling-sessions/${started.id}`)
    ).json()) as {
      durationMilliseconds: string;
      totalCostMinor: string;
      allocations: Array<{
        allocatedDurationMilliseconds: string;
        allocatedCostMinor: string;
      }>;
    };
    expect(completed.allocations).toHaveLength(1);
    expect(completed.allocations[0]?.allocatedDurationMilliseconds).toBe(
      completed.durationMilliseconds,
    );
    expect(completed.allocations[0]?.allocatedCostMinor).toBe(
      completed.totalCostMinor,
    );
    const allocationPage = await read(
      `/admin/handling-sessions/${started.id}/allocations?limit=1`,
    );
    expect(allocationPage.status).toBe(200);
    await expect(allocationPage.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ orderId: fixture.orderId })],
    });
    expect(
      (
        await fetch(
          new URL(
            `/admin/handling-sessions?orderId=${fixture.orderId}`,
            baseUrl,
          ),
          { headers: { cookie: foreignCookie } },
        )
      ).status,
    ).toBe(404);
    expect(
      (await read("/admin/handling-sessions?lifecycle=INVALID")).status,
    ).toBe(400);
  });

  it("keeps an open-session cursor valid when that timer completes", async () => {
    const secondAdmin = await sessionCookie("ADMIN", nodeId);
    const start = async (auth: { cookie: string; csrfToken: string }) => {
      const response = await fetch(
        new URL("/admin/handling-sessions/start", baseUrl),
        {
          method: "POST",
          headers: {
            cookie: auth.cookie,
            origin: "http://localhost:3002",
            "x-csrf-token": auth.csrfToken,
            "idempotency-key": randomUUID(),
            "content-type": "application/json",
          },
          body: JSON.stringify({ component: "HANDLING_ORDER_FIX" }),
        },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { id: string };
    };
    const first = await start({
      cookie: adminCookie,
      csrfToken: adminCsrfToken,
    });
    const second = await start(secondAdmin);
    const response = await read(
      "/admin/handling-sessions?lifecycle=OPEN&limit=1",
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(page.items[0]?.id);
    const cursor = page.nextCursor;
    const cursorAuth =
      cursor === first.id
        ? { cookie: adminCookie, csrfToken: adminCsrfToken }
        : secondAdmin;
    const stop = await fetch(
      new URL(`/admin/handling-sessions/${cursor}/stop`, baseUrl),
      {
        method: "POST",
        headers: {
          cookie: cursorAuth.cookie,
          origin: "http://localhost:3002",
          "x-csrf-token": cursorAuth.csrfToken,
          "idempotency-key": randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          allocations: [{ orderId: fixture.orderId, servedUnitCount: "1" }],
        }),
      },
    );
    expect(stop.status).toBe(200);
    const continuation = await read(
      `/admin/handling-sessions?lifecycle=OPEN&limit=1&cursor=${cursor}`,
    );
    expect(continuation.status).toBe(200);
    await expect(continuation.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: cursor === first.id ? second.id : first.id,
          lifecycle: "OPEN",
        }),
      ],
    });
    const remainingId = cursor === first.id ? second.id : first.id;
    const remainingAuth =
      cursor === first.id
        ? secondAdmin
        : { cookie: adminCookie, csrfToken: adminCsrfToken };
    const cleanup = await fetch(
      new URL(`/admin/handling-sessions/${remainingId}/stop`, baseUrl),
      {
        method: "POST",
        headers: {
          cookie: remainingAuth.cookie,
          origin: "http://localhost:3002",
          "x-csrf-token": remainingAuth.csrfToken,
          "idempotency-key": randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          allocations: [{ orderId: fixture.orderId, servedUnitCount: "1" }],
        }),
      },
    );
    expect(cleanup.status).toBe(200);
  });

  it("returns exact catalog settings and scoped inventory purchase evidence", async () => {
    const machine = await prisma.machine.findUniqueOrThrow({
      where: { id: fixture.machineId },
    });
    const profile = await prisma.machineProfile.findUniqueOrThrow({
      where: { id: fixture.machineProfileId },
    });
    const details = [
      [
        `/admin/catalog/reference-profiles/${profile.referenceProfileId}`,
        "settings",
      ],
      [
        `/admin/catalog/machine-profiles/${fixture.machineProfileId}`,
        "settings",
      ],
      [
        `/admin/catalog/print-config-revisions/${fixture.printConfigRevisionId}`,
        "settings",
      ],
      [
        `/admin/catalog/machine-capabilities/${machine.machineCapabilityId}`,
        "capabilityKey",
      ],
      [
        `/admin/nodes/${nodeId}/inventories/${fixture.inventoryId}`,
        "priceMinorUnitsNumerator",
      ],
    ] as const;
    for (const [path, field] of details) {
      const response = await read(path);
      expect(response.status, path).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body[field], path).toBeDefined();
    }
    const inventory = (await (
      await read(`/admin/nodes/${nodeId}/inventories/${fixture.inventoryId}`)
    ).json()) as Record<string, unknown>;
    expect(inventory).toMatchObject({
      nodeId,
      machineId: fixture.machineId,
      vendor: expect.any(String),
      priceMinorUnitsNumerator: expect.any(String),
      priceMinorUnitsDenominator: expect.any(String),
      currency: expect.any(String),
    });
    expect(
      (
        await read(
          `/admin/nodes/${randomUUID()}/inventories/${fixture.inventoryId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await read(`/admin/nodes/${nodeId}/inventories/${randomUUID()}`)).status,
    ).toBe(404);
    expect(
      (await read(`/admin/catalog/reference-profiles/${randomUUID()}`)).status,
    ).toBe(404);
  });

  it("recovers scoped actual-cost and platform spend correction evidence", async () => {
    const source = `read-cost-${randomUUID()}`;
    const oldCost = await prisma.orderActualCost.create({
      data: {
        orderId: fixture.orderId,
        category: "MATERIAL",
        amountMinor: 120n,
        currency: "CZK",
        occurredAt: new Date(),
        source: "MANUAL",
        sourceKey: source,
        sourceEntityType: "OPERATOR_ENTRY",
        reason: "Measured invoice",
      },
    });
    const correctedCost = await prisma.orderActualCost.create({
      data: {
        orderId: fixture.orderId,
        category: "MATERIAL",
        amountMinor: 125n,
        currency: "CZK",
        occurredAt: new Date(),
        source: "MANUAL",
        sourceKey: `${source}-correction`,
        sourceEntityType: "OPERATOR_ENTRY",
        supersedesId: oldCost.id,
        reason: "Correct invoice amount",
      },
    });
    const costPath = `/admin/orders/${fixture.orderId}/actual-costs`;
    const costPage = await fetch(new URL(`${costPath}?limit=1`, baseUrl), {
      headers: { cookie: adminCookie },
    });
    expect(costPage.status).toBe(200);
    const first = (await costPage.json()) as {
      items: Array<{
        id: string;
        amountMinor: string;
        isCurrent: boolean;
        successorId: string | null;
      }>;
      nextCursor: string;
    };
    expect(first.items).toHaveLength(1);
    const second = await fetch(
      new URL(`${costPath}?limit=1&cursor=${first.nextCursor}`, baseUrl),
      { headers: { cookie: adminCookie } },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as typeof first;
    expect([...first.items, ...secondBody.items]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: oldCost.id,
          amountMinor: "120",
          isCurrent: false,
          successorId: correctedCost.id,
        }),
        expect.objectContaining({
          id: correctedCost.id,
          amountMinor: "125",
          isCurrent: true,
        }),
      ]),
    );
    expect(
      (
        await fetch(new URL(costPath, baseUrl), {
          headers: { cookie: viewerCookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(new URL(costPath, baseUrl), {
          headers: { cookie: foreignAdminCookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(new URL(`${costPath}?cursor=${randomUUID()}`, baseUrl), {
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(400);

    const spendSource = `read-spend-${randomUUID()}`;
    const oldSpend = await prisma.acquisitionSpend.create({
      data: {
        channel: "PAID",
        periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2026-02-01T00:00:00Z"),
        amountMinor: 5_000n,
        currency: "CZK",
        sourceKey: spendSource,
        sourceEntityType: "OPERATOR_ENTRY",
      },
    });
    const currentSpend = await prisma.acquisitionSpend.create({
      data: {
        channel: "PAID",
        periodStart: oldSpend.periodStart,
        periodEnd: oldSpend.periodEnd,
        amountMinor: 4_500n,
        currency: "CZK",
        sourceKey: `${spendSource}-correction`,
        sourceEntityType: "OPERATOR_ENTRY",
        supersedesId: oldSpend.id,
        reason: "Correct campaign invoice",
      },
    });
    const spendPage = await fetch(
      new URL("/admin/acquisition-spend?channel=PAID&limit=100", baseUrl),
      { headers: { cookie: adminCookie } },
    );
    expect(spendPage.status).toBe(200);
    const spend = (await spendPage.json()) as {
      scope: string;
      items: Array<{
        id: string;
        isCurrent: boolean;
        successorId: string | null;
      }>;
    };
    expect(spend.scope).toBe("PLATFORM");
    expect(spend.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: oldSpend.id,
          isCurrent: false,
          successorId: currentSpend.id,
        }),
        expect.objectContaining({ id: currentSpend.id, isCurrent: true }),
      ]),
    );
    expect(
      (
        await fetch(new URL("/admin/acquisition-spend", baseUrl), {
          headers: { cookie: viewerCookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          new URL("/admin/acquisition-spend?channel=INVALID", baseUrl),
          { headers: { cookie: adminCookie } },
        )
      ).status,
    ).toBe(400);
  });

  it("does not warn about an expired RESERVED interval as a live conflict", async () => {
    const client = await pool.connect();
    let warningNodeId: string;
    let planned: ProductionReservationFixture;
    let reservationExpiresAt: Date;
    try {
      await client.query("BEGIN");
      const factory = new PersistenceFactory(
        client,
        `warning-expiry-${randomUUID()}`,
      );
      const timing = {
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1_000),
        expiresAt: new Date(Date.now() + 10_000),
      };
      reservationExpiresAt = timing.expiresAt;
      const interval = {
        startsAt: testTimes.capacityStart,
        endsAt: testTimes.capacityEnd,
      };
      const graph = await factory.createReservationGraph(
        "warning-expiry",
        [interval],
        {},
        {},
        timing,
      );
      const foundation = graph.foundation;
      const production = graph.productions[0];
      if (!production) throw new Error("reservation graph is missing a job");
      planned = production;
      await client.query(
        "INSERT INTO inventory_reservations (id, node_id, production_reservation_id, inventory_id, reserved_milligrams, expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          timing.expiresAt,
          timing.createdAt,
          timing.createdAt,
        ],
      );
      await client.query(
        "INSERT INTO capacity_reservations (id, node_id, production_reservation_id, candidate_capacity_interval_id, machine_id, starts_at, ends_at, expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          randomUUID(),
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          interval.startsAt,
          interval.endsAt,
          timing.expiresAt,
          timing.createdAt,
          timing.createdAt,
        ],
      );
      await client.query(
        "UPDATE inventories SET reserved_milligrams = 60 WHERE id = $1",
        [foundation.inventoryId],
      );
      await client.query(
        "UPDATE phase_reservation_sets SET status = 'RESERVED' WHERE id = $1",
        [foundation.phaseReservationSetId],
      );
      warningNodeId = foundation.nodeId;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const warningCookie = (await sessionCookie("ADMIN", warningNodeId)).cookie;
    const source = await prisma.candidateResourceEstimate.findUniqueOrThrow({
      where: { id: planned.candidateResourceEstimateId },
      include: { capacityIntervals: true },
    });
    const interval = source.capacityIntervals[0];
    if (!interval) throw new Error("candidate interval fixture is missing");
    const candidateId = randomUUID();
    await prisma.candidateResourceEstimate.create({
      data: {
        id: candidateId,
        nodeId: source.nodeId,
        estimateKey: `warning-conflict-${candidateId}`,
        modelGeometryId: source.modelGeometryId,
        primarySliceResultId: source.primarySliceResultId,
        tailSliceResultId: source.tailSliceResultId,
        printConfigRevisionId: source.printConfigRevisionId,
        machineProfileId: source.machineProfileId,
        machineCalibrationId: source.machineCalibrationId,
        machineId: source.machineId,
        machineAvailabilityRevisionId: source.machineAvailabilityRevisionId,
        machineAvailabilitySelectionVersion:
          source.machineAvailabilitySelectionVersion,
        inventoryId: source.inventoryId,
        shipmentPlanId: source.shipmentPlanId,
        arrangementRevisionId: source.arrangementRevisionId,
        quantity: source.quantity,
        partsPerPlate: source.partsPerPlate,
        requiredMaterialMilligrams: source.requiredMaterialMilligrams,
        requiredMachineSeconds: source.requiredMachineSeconds,
        resourceSnapshot: source.resourceSnapshot as Prisma.InputJsonObject,
        calculatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        capacityIntervals: {
          create: [
            {
              id: randomUUID(),
              intervalIndex: 0,
              startsAt: interval.startsAt,
              endsAt: interval.endsAt,
            },
          ],
        },
      },
    });
    const warningCodes = async () => {
      const response = await fetch(
        new URL("/admin/warnings?limit=100", baseUrl),
        {
          headers: { cookie: warningCookie },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<{ code: string; sourceId: string }>;
      };
      return body.items.filter((item) => item.sourceId === candidateId);
    };
    await expect(warningCodes()).resolves.toEqual([
      expect.objectContaining({ code: "RESERVATION_CONFLICT" }),
    ]);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, reservationExpiresAt.getTime() - Date.now() + 250),
      ),
    );
    await expect(warningCodes()).resolves.toEqual([]);
  }, 30_000);

  it("reports a retention job whose processing lease has expired", async () => {
    const leaseUntil = new Date(Date.now() - 1_000);
    const job = await prisma.retentionDeletionJob.create({
      data: {
        assetKind: "MODEL_FILE",
        assetId: fixture.modelFileId,
        expectedDeleteAfter: new Date(Date.now() - 60_000),
        status: "PROCESSING",
        availableAt: new Date(Date.now() - 60_000),
        leaseUntil,
        leaseToken: randomBytes(32).toString("hex"),
      },
    });
    const response = await fetch(
      new URL("/admin/warnings?limit=100", baseUrl),
      {
        headers: { cookie: adminCookie },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          code: "RETENTION_DUE",
          sourceId: job.id,
          status: "PROCESSING",
          dueAt: leaseUntil.toISOString(),
        }),
      ]),
    });
  });

  it("warns about missing profiles only for usable inventory", async () => {
    const originalMachine = await prisma.machine.findUniqueOrThrow({
      where: { id: fixture.machineId },
    });
    const machine = await prisma.machine.create({
      data: {
        nodeId,
        machineCapabilityId: originalMachine.machineCapabilityId,
        code: `warning-${randomBytes(8).toString("hex")}`,
        displayName: "Warning profile fixture",
        installedNozzleMicrometers: 600,
      },
    });
    const lot = await prisma.inventory.create({
      data: {
        nodeId,
        machineId: machine.id,
        sku: `warning-profile-${randomUUID()}`,
        material: "PLA",
        color: "Black",
        vendor: "Test vendor",
        priceMinorUnitsNumerator: 1n,
        priceMinorUnitsDenominator: 1n,
        currency: "CZK",
        remainingMilligrams: 100n,
      },
    });
    const warningsForLot = async () => {
      const response = await fetch(
        new URL("/admin/warnings?limit=100", baseUrl),
        { headers: { cookie: adminCookie } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<{ code: string; sourceId: string }>;
      };
      return body.items.filter((item) => item.sourceId === lot.id);
    };
    await expect(warningsForLot()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROFILE_UNAVAILABLE" }),
      ]),
    );
    await prisma.inventory.update({
      where: { id: lot.id },
      data: { status: "DEPLETED", remainingMilligrams: 0n },
    });
    const depleted = await warningsForLot();
    expect(depleted.some((item) => item.code === "PROFILE_UNAVAILABLE")).toBe(
      false,
    );
    expect(depleted.some((item) => item.code === "INVENTORY_UNAVAILABLE")).toBe(
      true,
    );
  });

  it("enforces the trusted node scope and capacity query boundary", async () => {
    const unavailableNode = await read(`/admin/nodes/${randomUUID()}/machines`);
    expect(unavailableNode.status).toBe(404);

    const missingRange = await read(
      `/admin/nodes/${nodeId}/capacity-reservations`,
    );
    expect(missingRange.status).toBe(400);

    for (const path of [
      "/admin/catalog/reference-profile-activation-notices?unknown=true",
      "/admin/catalog/reference-profile-activation-notices?limit=1&limit=2",
      "/admin/catalog/reference-profile-activation-notices?cursor=invalid",
    ]) {
      const response = await read(path);
      expect(response.status, path).toBe(400);
    }
  });

  it("returns an exact job detail and an explicit missing preview", async () => {
    const response = await read(`/admin/jobs/${fixtureJob.jobId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      id: fixtureJob.jobId,
      nodeId,
      orderId: fixture.orderId,
      shipmentPlanId: fixture.shipmentPlanId,
      shipmentId: null,
      status: "CREATED",
      slots: [
        {
          fulfilmentSlotId: fixture.fulfilmentSlotId,
          orderItemId: fixture.orderItemId,
          sourceModelFileId: fixture.modelFileId,
          modelGeometryId: fixture.modelGeometryId,
          boundsXMicrometers: expect.any(String),
          volumeCubicMicrometers: expect.any(String),
          geometrySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          acceptedRisks: expect.any(Array),
        },
      ],
      estimate: {
        candidateResourceEstimateId: fixtureJob.candidateResourceEstimateId,
        machineId: fixture.machineId,
        partsPerPlate: expect.any(Number),
        plateCount: expect.any(Number),
        provenance: "CANDIDATE_RESOURCE_ESTIMATE",
      },
      deadline: { date: null, provenance: "NO_PROMISED_DATE" },
      artifacts: {
        sourceModel: { available: true, reason: null },
        preview: { available: false, reason: "NOT_GENERATED" },
        production: { available: false, reason: "NOT_READY" },
      },
      actions: [
        expect.objectContaining({
          action: "DOWNLOAD_SOURCE_MODEL",
          targetId: fixtureJob.jobId,
          enabled: true,
        }),
      ],
    });
    const adminResponse = await fetch(
      new URL(`/admin/jobs/${fixtureJob.jobId}`, baseUrl),
      { headers: { cookie: adminCookie } },
    );
    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({ action: "ACCEPT_JOB", enabled: true }),
      ]),
    });
  });

  it("enforces session, node, kind, CSRF and download audit boundaries", async () => {
    const path = `/admin/jobs/${fixtureJob.jobId}`;
    expect((await fetch(new URL(path, baseUrl))).status).toBe(401);
    expect(
      (
        await fetch(new URL(path, baseUrl), {
          headers: { cookie: foreignCookie },
        })
      ).status,
    ).toBe(404);
    expect((await read(`/admin/jobs/${randomUUID()}`)).status).toBe(404);
    expect((await read("/admin/jobs/invalid")).status).toBe(400);
    expect((await download("BOGUS")).status).toBe(400);
    expect((await download("SOURCE_MODEL", false)).status).toBe(403);
    expect((await download("PREVIEW")).status).toBe(409);
    expect((await download("PRODUCTION")).status).toBe(409);

    const response = await download("SOURCE_MODEL");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      downloadUrl: "https://storage.example.test/signed?token=opaque",
      expiresAt: expect.any(String),
      contentType: "model/stl",
      contentLength: "1",
      sha256: "a".repeat(64),
    });
    expect(createDownloadUrl).toHaveBeenCalledTimes(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: {
        orderId: fixture.orderId,
        eventType: "job.artifact_download_issued",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.nodeId).toBe(nodeId);
    expect(JSON.stringify(audit.payload)).not.toContain("signed");
    expect(JSON.stringify(audit.payload)).not.toContain("models/");
  });

  it("fails closed for missing, mismatched and unavailable source storage", async () => {
    const source = await prisma.modelFile.findUniqueOrThrow({
      where: { id: fixture.modelFileId },
    });
    const metadata = storedObjects.get(source.storageObjectKey)!;
    storedObjects.delete(source.storageObjectKey);
    try {
      expect((await download("SOURCE_MODEL")).status).toBe(410);
      storedObjects.set(source.storageObjectKey, {
        ...metadata,
        contentHash: "b".repeat(64),
      });
      expect((await download("SOURCE_MODEL")).status).toBe(409);
      storedObjects.set(source.storageObjectKey, metadata);
      headObject.mockRejectedValueOnce(new Error("storage unavailable"));
      expect((await download("SOURCE_MODEL")).status).toBe(503);
    } finally {
      storedObjects.set(source.storageObjectKey, metadata);
    }
    expect(createDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it("uses bounded, opaque pagination for operational and assisted-work reads", async () => {
    for (const path of ["/admin/orders?limit=100", "/admin/jobs?limit=100"]) {
      const response = await read(path);
      expect(response.status, path).toBe(200);
      await expect(response.json(), path).resolves.toMatchObject({
        items: expect.any(Array),
      });
    }

    const unrelatedFindingCode = `HISTORICAL_${randomBytes(6).toString("hex")}`;
    await prisma.preflightFinding.create({
      data: {
        modelFileId: fixture.modelFileId,
        modelGeometryId: fixture.modelGeometryId,
        inspectionRevision: `historical-${randomBytes(8).toString("hex")}`,
        code: unrelatedFindingCode,
        severity: "WARNING",
        message: "Not accepted for the ordered configuration",
      },
    });

    const cancellation = await cancelOrder();
    expect(cancellation.status).toBe(200);
    const cancellationResult = (await cancellation.json()) as {
      status: string;
      result: { refundIds: string[] };
    };
    expect(cancellationResult).toMatchObject({ status: "ORDER_CANCELLED" });
    expect(cancellationResult.result.refundIds).toHaveLength(1);
    const cancellationRefundId = cancellationResult.result.refundIds[0]!;

    const order = await read(`/admin/orders/${fixture.orderId}`);
    expect(order.status).toBe(200);
    const orderDetail = (await order.json()) as {
      items: Array<{ id: string; preflightFindings: string[] }>;
      timeline: Array<{
        eventType: string;
        actorKind: string;
        occurredAt: string;
      }>;
    };
    expect(orderDetail).toMatchObject({
      id: fixture.orderId,
      items: [
        {
          id: fixture.orderItemId,
          primaryReferenceSlice: {
            id: fixture.referenceSliceResultId,
            estimatedPrintSeconds: expect.any(String),
            estimatedMaterialMilligrams: expect.any(String),
            slicerEngine: expect.any(String),
            slicerVersion: expect.any(String),
          },
          tailReferenceSlice: null,
        },
      ],
      financial: {
        settlements: expect.any(Array),
        payments: [
          {
            id: fixture.paymentId,
            orderPriceBindingId: fixture.orderPriceBindingId,
            priceSnapshotId: fixture.priceSnapshotId,
            status: expect.any(String),
            requestedAmountMinor: expect.any(String),
            refunds: [
              {
                id: cancellationRefundId,
                claimId: null,
                priceAdjustmentId: null,
                amountMinor: expect.any(String),
                reason: "CUSTOMER_CANCELLATION",
                status: "PENDING",
                requestedAt: expect.any(String),
                completedAt: null,
              },
            ],
          },
        ],
      },
      fulfilment: { jobs: expect.any(Array), shipments: expect.any(Array) },
      shipmentPlans: [
        expect.objectContaining({
          id: fixture.shipmentPlanId,
          slots: [
            expect.objectContaining({
              fulfilmentSlotId: fixture.fulfilmentSlotId,
            }),
          ],
        }),
      ],
      slotLineage: [
        expect.objectContaining({
          fulfilmentSlotId: fixture.fulfilmentSlotId,
          jobIds: expect.arrayContaining([fixtureJob.jobId]),
        }),
      ],
      fulfilmentNextCursors: {},
      legalAcceptances: expect.any(Array),
      blockingCodes: expect.arrayContaining(["REFUND_UNRESOLVED"]),
      actions: [],
    });
    expect(orderDetail.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "order.quoted",
          actorKind: "SYSTEM",
          occurredAt: expect.any(String),
        }),
      ]),
    );
    expect(orderDetail).toHaveProperty("acceptedClaimPolicyRevision");
    const adminOrder = await fetch(
      new URL(`/admin/orders/${fixture.orderId}`, baseUrl),
      { headers: { cookie: adminCookie } },
    );
    expect(adminOrder.status).toBe(200);
    const adminDetail = (await adminOrder.json()) as {
      actions: Array<{ action: string }>;
      blockingCodes: string[];
    };
    expect(adminDetail.blockingCodes).toContain("REFUND_UNRESOLVED");
    expect(adminDetail.actions.map((action) => action.action)).not.toContain(
      "CANCEL_ORDER",
    );
    const paymentPage = await read(
      `/admin/orders/${fixture.orderId}/payments?limit=1`,
    );
    expect(paymentPage.status).toBe(200);
    await expect(paymentPage.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: fixture.paymentId })],
    });
    const refundPage = await read(
      `/admin/orders/${fixture.orderId}/refunds?limit=1`,
    );
    expect(refundPage.status).toBe(200);
    await expect(refundPage.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: cancellationRefundId,
          paymentId: fixture.paymentId,
        }),
      ],
    });
    const settlementPage = await read(
      `/admin/orders/${fixture.orderId}/settlements?limit=1`,
    );
    expect(settlementPage.status).toBe(200);
    await expect(settlementPage.json()).resolves.toMatchObject({
      items: expect.any(Array),
    });
    const jobHistory = await read(
      `/admin/orders/${fixture.orderId}/fulfilment-history/jobs?limit=1`,
    );
    expect(jobHistory.status).toBe(200);
    await expect(jobHistory.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: fixtureJob.jobId })],
    });
    expect(
      (
        await read(
          `/admin/orders/${fixture.orderId}/fulfilment-history/jobs?cursor=${randomUUID()}`,
        )
      ).status,
    ).toBe(400);
    const absentClaimId = randomUUID();
    expect(
      (
        await read(
          `/admin/orders/${fixture.orderId}/fulfilment-history/claims/${absentClaimId}/refunds`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await read(
          `/admin/orders/${fixture.orderId}/fulfilment-history/claims/${absentClaimId}/invalid`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          new URL(
            `/admin/orders/${fixture.orderId}/fulfilment-history/claims/${absentClaimId}/refunds`,
            baseUrl,
          ),
          { headers: { cookie: foreignCookie } },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          new URL(
            `/admin/orders/${fixture.orderId}/fulfilment-history/jobs`,
            baseUrl,
          ),
          { headers: { cookie: foreignCookie } },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          new URL(`/admin/orders/${fixture.orderId}/refunds`, baseUrl),
          { headers: { cookie: foreignCookie } },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await read(
          `/admin/orders/${fixture.orderId}/payments?cursor=${randomUUID()}`,
        )
      ).status,
    ).toBe(400);
    expect(
      orderDetail.items.find((item) => item.id === fixture.orderItemId)
        ?.preflightFindings,
    ).toEqual([]);

    const jobs = await read(
      `/admin/jobs?machineId=${fixture.machineId}&limit=1`,
    );
    expect(jobs.status).toBe(200);
    await expect(jobs.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: fixtureJob.jobId })],
    });

    await expect(
      findQuoteRequestPageItem(
        { status: "QUOTED", sla: "MET" },
        fixture.quoteRequestId,
      ),
    ).resolves.toMatchObject({ slaBreached: false });
    await expect(
      findQuoteRequestPageItem(
        { status: "QUOTED", sla: "PENDING" },
        fixture.quoteRequestId,
      ),
    ).resolves.toBeUndefined();

    const invalidCursor = await read(
      "/admin/quote-requests/page?cursor=invalid",
    );
    expect(invalidCursor.status).toBe(400);

    const legacy = await read("/admin/quote-requests");
    expect(legacy.status).toBe(200);
    await expect(legacy.json()).resolves.toEqual(expect.any(Array));
  });

  it("bounds order history and rejects foreign or unrelated timeline cursors", async () => {
    await prisma.auditEvent.createMany({
      data: Array.from({ length: 27 }, (_, index) => ({
        orderId: fixture.orderId,
        nodeId,
        eventType: "operator_reads.pagination_test",
        payload: { index },
        createdAt: new Date(Date.now() - 1000),
      })),
    });
    const detail = await read(`/admin/orders/${fixture.orderId}`);
    expect(detail.status).toBe(200);
    const order = (await detail.json()) as {
      timeline: Array<{ id: string }>;
      timelineNextCursor: string;
    };
    expect(order.timeline).toHaveLength(25);
    expect(order.timelineNextCursor).toBe(order.timeline[24]?.id);

    const first = await read(
      `/admin/orders/${fixture.orderId}/timeline?limit=20`,
    );
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(firstPage.items).toHaveLength(20);
    const second = await read(
      `/admin/orders/${fixture.orderId}/timeline?limit=20&cursor=${firstPage.nextCursor}`,
    );
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as {
      items: Array<{ id: string }>;
    };
    expect(secondPage.items.length).toBeGreaterThan(0);
    expect(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.id))
        .size,
    ).toBe(firstPage.items.length + secondPage.items.length);
    expect(
      (
        await read(
          `/admin/orders/${fixture.orderId}/timeline?cursor=${randomUUID()}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          new URL(`/admin/orders/${fixture.orderId}/timeline`, baseUrl),
          { headers: { cookie: foreignCookie } },
        )
      ).status,
    ).toBe(404);
  });

  async function read(path: string): Promise<Response> {
    return fetch(new URL(path, baseUrl), {
      headers: { cookie: viewerCookie },
    });
  }

  it("guards refund recovery commands before target replay or lookup", async () => {
    const refundId = randomUUID();
    const routes = [
      {
        path: `/admin/orders/${fixture.orderId}/fulfilment/refunds/${refundId}/provider-results`,
        body: {
          outcome: "FAILED",
          expectedStatus: "PENDING",
          expectedProviderResultEventId: null,
          providerIntentId: "intent-not-looked-up",
          requestReference: "request-not-looked-up",
          amountMinor: "1",
          currency: "CZK",
          evidenceKind: "PROVIDER_SUPPORT",
          evidenceReference: "case-exact-attempt",
          occurredAt: new Date().toISOString(),
          reason: "final non-execution confirmed",
          finalOutcomeConfirmed: true,
        },
      },
      {
        path: `/admin/orders/${fixture.orderId}/fulfilment/refunds/${refundId}/retry`,
        body: {
          expectedFailureProviderEventId: randomUUID(),
          reason: "verified failed transfer",
        },
      },
    ];
    for (const route of routes) {
      const request = (cookie?: string, csrf?: string) =>
        fetch(new URL(route.path, baseUrl), {
          method: "POST",
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(csrf ? { "x-csrf-token": csrf } : {}),
            "content-type": "application/json",
            "idempotency-key": `refund-auth-${randomUUID()}`,
            origin: "http://localhost:3002",
          },
          body: JSON.stringify(route.body),
        });
      expect((await request()).status).toBe(401);
      expect((await request(viewerCookie, viewerCsrfToken)).status).toBe(403);
      expect((await request(adminCookie)).status).toBe(403);
      expect(
        (await request(foreignAdminCookie, foreignAdminCsrfToken)).status,
      ).toBe(404);
      expect((await request(adminCookie, adminCsrfToken)).status).toBe(404);
    }
  });

  async function download(kind: string, withCsrf = true): Promise<Response> {
    return fetch(
      new URL(
        `/admin/jobs/${fixtureJob.jobId}/artifacts/${kind}/download`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          cookie: viewerCookie,
          origin: "http://localhost:3002",
          ...(withCsrf ? { "x-csrf-token": viewerCsrfToken } : {}),
        },
      },
    );
  }

  async function cancelOrder(): Promise<Response> {
    return fetch(
      new URL(`/admin/orders/${fixture.orderId}/fulfilment/cancel`, baseUrl),
      {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
          "idempotency-key": `operator-reads-cancel-${randomUUID()}`,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
        },
        body: JSON.stringify({ reason: "Operator detail refund projection" }),
      },
    );
  }

  async function findQuoteRequestPageItem(
    filters: Record<string, string>,
    requestId: string,
  ): Promise<{ requestId: string; slaBreached: boolean } | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page < 32; page += 1) {
      const query = new URLSearchParams({ ...filters, limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await read(`/admin/quote-requests/page?${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<{ requestId: string; slaBreached: boolean }>;
        nextCursor: string | null;
      };
      const item = body.items.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (item) return item;
      cursor = body.nextCursor ?? undefined;
      if (!cursor) return undefined;
    }
    throw new Error("quote request was not found within the page bound");
  }

  async function sessionCookie(
    role: "VIEWER" | "ADMIN",
    grantedNodeId: string,
  ): Promise<{ cookie: string; csrfToken: string }> {
    const identity = await prisma.operatorIdentity.create({
      data: {
        email: `operator-reads-${randomUUID()}@example.test`,
        role,
        nodeGrants: { create: { nodeId: grantedNodeId } },
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
    return { cookie: `taven_admin=${token}`, csrfToken };
  }
});
