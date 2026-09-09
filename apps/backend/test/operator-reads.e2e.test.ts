import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { configureHttpBodyParsers } from "../src/http-body.config";
import { PrismaService } from "../src/prisma/prisma.service";
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
  let adminCookie: string;
  let adminCsrfToken: string;

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
    const viewerSession = await sessionCookie("VIEWER", nodeId);
    viewerCookie = viewerSession.cookie;
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

  async function read(path: string): Promise<Response> {
    return fetch(new URL(path, baseUrl), {
      headers: { cookie: viewerCookie },
    });
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
