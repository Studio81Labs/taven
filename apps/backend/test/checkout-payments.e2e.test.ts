import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  DELIVERY_CAPABILITY,
  type ResolvedDeliveryCapability,
} from "../src/modules/automatic-quotes/delivery-capability.port";
import {
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
} from "../src/modules/payments/payment-provider.port";
import { PaymentsModule } from "../src/modules/payments/payments.module";
import { SandboxPaymentProviderAdapter } from "../src/modules/payments/sandbox-payment-provider.adapter";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PersistenceFactory,
  testTimes,
  type PersistenceFoundation,
  type ProductionReservationFixture,
} from "./support/persistence-factory";

process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION ??= "us-east-1";
process.env.TAVEN_S3_BUCKET ??= "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID ??= "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??=
  "checkout-e2e-upload-client-hash-key-32";

const databaseUrl = process.env.DATABASE_URL;
const scope = `checkout-payments-${randomUUID()}`;
let pool: Pool;

async function rollback<T>(
  name: string,
  work: (client: PoolClient, fixtures: PersistenceFactory) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    return await work(
      client,
      new PersistenceFactory(client, `${scope}:${name}`, {
        publicTokenHash: createHash("sha256")
          .update(`${scope}:${name}:checkout-token`)
          .digest("hex"),
      }),
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function prepareReservedFoundation(
  client: PoolClient,
  fixtures: PersistenceFactory,
  name: string,
) {
  const foundation = await fixtures.createFoundation(name);
  const productions: ProductionReservationFixture[] = [];
  for (const [index] of foundation.fulfilmentSlotIds.entries()) {
    productions.push(
      await fixtures.planProduction(
        foundation,
        `${name}:production:${index}`,
        {
          startsAt: new Date(
            testTimes.capacityStart.getTime() + index * 7_200_000,
          ),
          endsAt: new Date(
            testTimes.capacityStart.getTime() + index * 7_200_000 + 3_600_000,
          ),
        },
        60,
        60,
        1,
        index,
      ),
    );
  }
  const reservationCreatedAt = new Date();
  const reservationExpiresAt = new Date(
    reservationCreatedAt.getTime() + 15 * 60 * 1_000,
  );
  await fixtures.createResourcePlan(
    foundation,
    productions,
    new Date(reservationCreatedAt.getTime() + 30 * 60 * 1_000),
  );
  await client.query(
    `UPDATE inventories SET remaining_milligrams = 1000 WHERE id = $1`,
    [foundation.inventoryId],
  );
  await fixtures.createPhaseReservationSet(
    foundation,
    reservationExpiresAt,
    "BUILDING",
    reservationCreatedAt,
  );
  for (const [index, production] of productions.entries()) {
    await fixtures.createProductionReservation(
      foundation,
      production,
      "RESERVED",
      {},
      null,
      reservationExpiresAt,
      reservationCreatedAt,
    );
    await client.query(
      `INSERT INTO inventory_reservations
         (id, node_id, production_reservation_id, inventory_id,
          reserved_milligrams, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [
        production.inventoryReservationId,
        foundation.nodeId,
        production.productionReservationId,
        foundation.inventoryId,
        production.requiredMaterialMilligrams,
        reservationExpiresAt,
        reservationCreatedAt,
      ],
    );
    await client.query(
      `INSERT INTO capacity_reservations
         (id, node_id, production_reservation_id,
          candidate_capacity_interval_id, machine_id, starts_at, ends_at,
          expires_at, created_at, updated_at)
       SELECT $1,$2,$3,$4,$5,starts_at,ends_at,$6,$7,$7
       FROM candidate_capacity_intervals WHERE id = $4`,
      [
        fixtures.id(`${name}:capacity:${index}`),
        foundation.nodeId,
        production.productionReservationId,
        production.candidateCapacityIntervalId,
        foundation.machineId,
        reservationExpiresAt,
        reservationCreatedAt,
      ],
    );
  }
  await client.query(
    `UPDATE phase_reservation_sets SET status = 'RESERVED' WHERE id = $1`,
    [foundation.phaseReservationSetId],
  );
  return foundation;
}

async function preparePayment(
  client: PoolClient,
  fixtures: PersistenceFactory,
  name: string,
  captureExpiresAt = new Date(Date.now() + 60 * 60 * 1_000),
  shortCaptureMilliseconds?: number,
) {
  const foundation = await prepareReservedFoundation(client, fixtures, name);
  const providerIntentId = `sandbox-${foundation.paymentId}`;
  const effectiveCaptureExpiresAt = shortCaptureMilliseconds
    ? new Date(Date.now() + shortCaptureMilliseconds)
    : captureExpiresAt;
  await fixtures.finalizePayment(
    foundation,
    effectiveCaptureExpiresAt,
    providerIntentId,
    "sandbox",
    new Date(effectiveCaptureExpiresAt.getTime() - 60 * 60 * 1_000),
  );
  return { foundation, providerIntentId };
}

async function eventEvidence(
  client: PoolClient,
  foundation: PersistenceFoundation,
) {
  const row = (
    await client.query<{ amount_minor: string; currency: string }>(
      `SELECT requested_amount_minor::text AS amount_minor, currency
       FROM payments WHERE id = $1`,
      [foundation.paymentId],
    )
  ).rows[0];
  if (!row) throw new Error("payment evidence is missing");
  return row;
}

describe("checkout payment capture protocol", () => {
  beforeAll(() => {
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for payment E2E tests");
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("atomically captures, activates the order, and creates exactly one Job", async () => {
    await rollback("success", async (client, fixtures) => {
      const { foundation, providerIntentId } = await preparePayment(
        client,
        fixtures,
        "success",
      );
      const evidence = await eventEvidence(client, foundation);
      const result = await client.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', $1, $2, 'PAYMENT_CAPTURED', $3, $4, clock_timestamp(),
           '{"source":"e2e"}'::jsonb
         ) AS outcome`,
        [
          "success-event",
          providerIntentId,
          evidence.amount_minor,
          evidence.currency,
        ],
      );
      expect(result.rows).toEqual([{ outcome: "CAPTURED" }]);
      expect(
        (
          await client.query(
            `SELECT target_order.status::text AS order_status,
                    payment.status::text AS payment_status,
                    phase.status::text AS phase_status,
                    reservation_set.status::text AS set_status,
                    (SELECT count(*)::int FROM jobs
                     WHERE order_id = target_order.id) AS job_count,
                    (SELECT count(*)::int FROM outbox_messages
                     WHERE message_type = 'void_payment'
                       AND aggregate_id = payment.id) AS void_commands
             FROM orders target_order
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN phase_resource_plans plan ON plan.order_phase_id = phase.id
             JOIN phase_reservation_sets reservation_set
               ON reservation_set.phase_resource_plan_id = plan.id
             WHERE target_order.id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "CONFIRMED",
          payment_status: "CAPTURED",
          phase_status: "ACTIVE",
          set_status: "HELD",
          job_count: 1,
          void_commands: 0,
        },
      ]);
    });
  });

  it("records decline once and makes duplicate or out-of-order events harmless", async () => {
    await rollback("decline", async (client, fixtures) => {
      const { foundation, providerIntentId } = await preparePayment(
        client,
        fixtures,
        "decline",
      );
      const evidence = await eventEvidence(client, foundation);
      const apply = () =>
        client.query<{ outcome: string }>(
          `SELECT taven_apply_checkout_payment_event(
             'sandbox', $1, $2, 'PAYMENT_FAILED', $3, $4,
             clock_timestamp(), '{}'::jsonb
           ) AS outcome`,
          [
            "decline-event",
            providerIntentId,
            evidence.amount_minor,
            evidence.currency,
          ],
        );
      expect((await apply()).rows).toEqual([{ outcome: "FAILED" }]);
      expect((await apply()).rows).toEqual([{ outcome: "DUPLICATE" }]);
      expect(
        (
          await client.query(
            `SELECT status::text, capture_authorized,
                    (SELECT count(*)::int FROM payment_provider_events
                     WHERE payment_id = payments.id) AS event_count
             FROM payments WHERE id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        { status: "FAILED", capture_authorized: false, event_count: 1 },
      ]);
    });
  });

  it("expires an abandoned payment and fully compensates a delayed capture", async () => {
    await rollback("late-capture", async (client, fixtures) => {
      const { foundation, providerIntentId } = await preparePayment(
        client,
        fixtures,
        "late-capture",
        undefined,
        300,
      );
      const evidence = await eventEvidence(client, foundation);
      await client.query(`SELECT pg_sleep(0.4)`);
      expect(
        (
          await client.query(
            `SELECT taven_close_initial_checkout_payment(
               $1, 'CHECKOUT_EXPIRED'
             )::text AS status`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([{ status: "VOIDED" }]);
      const capture = await client.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', $1, $2, 'PAYMENT_CAPTURED', $3, $4,
           clock_timestamp(), '{}'::jsonb
         ) AS outcome`,
        [
          "late-event",
          providerIntentId,
          evidence.amount_minor,
          evidence.currency,
        ],
      );
      expect(capture.rows).toEqual([{ outcome: "REFUND_PENDING" }]);
      expect(
        (
          await client.query(
            `SELECT target_order.status::text AS order_status,
                    payment.status::text AS payment_status,
                    refund.status::text AS refund_status,
                    refund.reason::text AS refund_reason,
                    refund.amount_minor::text AS refund_amount,
                    (SELECT count(*)::int FROM jobs
                     WHERE order_id = target_order.id) AS job_count,
                    (SELECT count(*)::int FROM outbox_messages
                     WHERE message_type = 'refund_payment'
                       AND aggregate_id = refund.id) AS refund_commands,
                    (SELECT count(*)::int FROM outbox_messages
                     WHERE message_type = 'void_payment'
                       AND aggregate_id = payment.id) AS void_commands
             FROM orders target_order
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE target_order.id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "EXPIRED",
          payment_status: "REFUND_PENDING",
          refund_status: "PENDING",
          refund_reason: "LATE_CAPTURE_COMPENSATION",
          refund_amount: evidence.amount_minor,
          job_count: 0,
          refund_commands: 1,
          void_commands: 1,
        },
      ]);
      const refund = (
        await client.query<{ id: string }>(
          `SELECT id FROM refund_transactions WHERE payment_id = $1`,
          [foundation.paymentId],
        )
      ).rows[0];
      if (!refund) throw new Error("late compensation was not created");
      await client.query(`SELECT taven_claim_refund_dispatch($1)`, [refund.id]);
      expect(
        (
          await client.query<{ applied: boolean }>(
            `SELECT taven_apply_checkout_refund_success(
               $1, 'sandbox-refund-1', 'refund-success-1', clock_timestamp(),
               '{"source":"e2e"}'::jsonb
             ) AS applied`,
            [refund.id],
          )
        ).rows,
      ).toEqual([{ applied: true }]);
      expect(
        (
          await client.query(
            `SELECT payment.status::text AS payment_status,
                    refund.status::text AS refund_status
             FROM payments payment
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE refund.id = $1`,
            [refund.id],
          )
        ).rows,
      ).toEqual([{ payment_status: "REFUNDED", refund_status: "SUCCEEDED" }]);
    });
  });

  it("persists authenticated pending evidence without changing checkout state", async () => {
    await rollback("pending", async (client, fixtures) => {
      const { foundation, providerIntentId } = await preparePayment(
        client,
        fixtures,
        "pending",
      );
      const evidence = await eventEvidence(client, foundation);
      const apply = () =>
        client.query<{ outcome: string }>(
          `SELECT taven_apply_checkout_payment_event(
             'sandbox', 'pending-event', $1, 'PAYMENT_PENDING', $2, $3,
             clock_timestamp(), '{"source":"e2e"}'::jsonb
           ) AS outcome`,
          [providerIntentId, evidence.amount_minor, evidence.currency],
        );
      expect((await apply()).rows).toEqual([{ outcome: "PENDING" }]);
      expect((await apply()).rows).toEqual([{ outcome: "DUPLICATE" }]);
      expect(
        (
          await client.query(
            `SELECT status::text,
                    (SELECT count(*)::int FROM payment_provider_events
                     WHERE payment_id = payments.id) AS event_count
             FROM payments WHERE id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([{ status: "PENDING", event_count: 1 }]);
    });
  });

  it("fully compensates capture when delivery capability is stale", async () => {
    await rollback("stale-delivery", async (client, fixtures) => {
      const { foundation, providerIntentId } = await preparePayment(
        client,
        fixtures,
        "stale-delivery",
      );
      const evidence = await eventEvidence(client, foundation);
      const capture = await client.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', 'stale-delivery-capture', $1, 'PAYMENT_CAPTURED', $2, $3,
           clock_timestamp(), '{"source":"e2e"}'::jsonb, false
         ) AS outcome`,
        [providerIntentId, evidence.amount_minor, evidence.currency],
      );
      expect(capture.rows).toEqual([{ outcome: "REFUND_PENDING" }]);
      expect(
        (
          await client.query(
            `SELECT target_order.status::text AS order_status,
                    payment.status::text AS payment_status,
                    refund.reason::text AS refund_reason,
                    (SELECT count(*)::int FROM jobs
                     WHERE order_id = target_order.id) AS job_count
             FROM orders target_order
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE target_order.id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "CANCELLED",
          payment_status: "REFUND_PENDING",
          refund_reason: "LATE_CAPTURE_COMPENSATION",
          job_count: 0,
        },
      ]);
    });
  });

  it("matches and compensates a returned intent after cancellation won persistence", async () => {
    await rollback("returned-intent-race", async (client, fixtures) => {
      const foundation = await prepareReservedFoundation(
        client,
        fixtures,
        "returned-intent-race",
      );
      const providerIntentId = `returned-${foundation.paymentId}`;
      const paymentCreatedAt = new Date();
      const checkoutCaptureExpiresAt = new Date(
        paymentCreatedAt.getTime() + 60 * 60 * 1_000,
      );
      await fixtures.acceptCheckoutTerms(foundation, paymentCreatedAt);
      await client.query(
        `INSERT INTO payments
           (id, order_id, price_snapshot_id, order_price_binding_id,
            payment_schedule_id, role, provider, requested_amount_minor,
            currency, status, checkout_capture_expires_at, created_at,
            updated_at)
         SELECT $1, $2, $3, $4, schedule.id, schedule.role, 'sandbox',
                schedule.gross_amount_minor, snapshot.currency, 'CREATED',
                $6, $5, $5
         FROM payment_schedules schedule
         JOIN price_snapshots snapshot ON snapshot.id = schedule.price_snapshot_id
         WHERE schedule.id = $7`,
        [
          foundation.paymentId,
          foundation.orderId,
          foundation.priceSnapshotId,
          foundation.orderPriceBindingId,
          paymentCreatedAt,
          checkoutCaptureExpiresAt,
          foundation.paymentScheduleId,
        ],
      );
      const evidence = await eventEvidence(client, foundation);
      await client.query(
        `SELECT taven_close_initial_checkout_payment(
           $1, 'CUSTOMER_CANCELLED'
         )`,
        [foundation.paymentId],
      );
      await client.query(
        `INSERT INTO outbox_messages
           (id, deduplication_key, aggregate_type, aggregate_id, message_type,
            schema_version, payload, status, attempts, available_at,
            created_at, updated_at)
         VALUES ($1, $2, 'Payment', $3, 'void_payment', 1, $4::jsonb,
                 'PENDING', 0, clock_timestamp(), clock_timestamp(),
                 clock_timestamp())`,
        [
          randomUUID(),
          `void_payment:v1:${foundation.paymentId}`,
          foundation.paymentId,
          JSON.stringify({
            paymentId: foundation.paymentId,
            provider: "sandbox",
            providerIntentId,
            action: "void_payment",
          }),
        ],
      );

      expect(
        (
          await client.query<{ outcome: string }>(
            `SELECT taven_apply_checkout_payment_event(
               'sandbox', 'returned-intent-capture', $1,
               'PAYMENT_CAPTURED', $2, $3, clock_timestamp(), '{}'::jsonb,
               false
             ) AS outcome`,
            [providerIntentId, evidence.amount_minor, evidence.currency],
          )
        ).rows,
      ).toEqual([{ outcome: "REFUND_PENDING" }]);
      expect(
        (
          await client.query(
            `SELECT payment.status::text AS payment_status,
                    count(refund.id)::int AS refund_count,
                    (SELECT count(*)::int FROM jobs
                     WHERE order_id = payment.order_id) AS job_count
             FROM payments payment
             LEFT JOIN refund_transactions refund
               ON refund.payment_id = payment.id
             WHERE payment.id = $1
             GROUP BY payment.id`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          payment_status: "REFUND_PENDING",
          refund_count: 1,
          job_count: 0,
        },
      ]);
    });
  });

  it("drives intent creation and authenticated sandbox capture through HTTP", async () => {
    const token = randomBytes(32).toString("base64url");
    const publicTokenHash = createHash("sha256").update(token).digest("hex");
    const outageToken = randomBytes(32).toString("base64url");
    const outagePublicTokenHash = createHash("sha256")
      .update(outageToken)
      .digest("hex");
    const setupClient = await pool.connect();
    let foundation: PersistenceFoundation;
    let outageFoundation: PersistenceFoundation;
    let customerEmail: string;
    let outageCustomerEmail: string;
    let destination: ResolvedDeliveryCapability;
    let outageDestination: ResolvedDeliveryCapability;
    try {
      await setupClient.query("BEGIN");
      const fixtures = new PersistenceFactory(
        setupClient,
        `${scope}:http-sandbox`,
        { publicTokenHash },
      );
      foundation = await prepareReservedFoundation(
        setupClient,
        fixtures,
        "http-sandbox",
      );
      customerEmail = (
        await setupClient.query<{ email: string }>(
          "SELECT email FROM customers WHERE id = $1",
          [foundation.customerId],
        )
      ).rows[0]!.email;
      const destinationRow = (
        await setupClient.query<{
          provider_endpoint_id: string;
          endpoint_type: string;
          address_snapshot: Record<string, unknown>;
          capability_snapshot: Record<string, unknown>;
        }>(
          `SELECT provider_endpoint_id, endpoint_type, address_snapshot,
                  capability_snapshot
           FROM delivery_destinations WHERE id = $1`,
          [foundation.deliveryDestinationId],
        )
      ).rows[0]!;
      destination = {
        providerEndpointId: destinationRow.provider_endpoint_id,
        endpointType: destinationRow.endpoint_type,
        addressSnapshot:
          destinationRow.address_snapshot as Prisma.InputJsonObject,
        capabilitySnapshot:
          destinationRow.capability_snapshot as Prisma.InputJsonObject,
        supportedCategoryIds: ["standard"],
      };
      const outageFixtures = new PersistenceFactory(
        setupClient,
        `${scope}:http-outage`,
        { publicTokenHash: outagePublicTokenHash },
      );
      outageFoundation = await prepareReservedFoundation(
        setupClient,
        outageFixtures,
        "http-outage",
      );
      outageCustomerEmail = (
        await setupClient.query<{ email: string }>(
          "SELECT email FROM customers WHERE id = $1",
          [outageFoundation.customerId],
        )
      ).rows[0]!.email;
      const outageDestinationRow = (
        await setupClient.query<{
          provider_endpoint_id: string;
          endpoint_type: string;
          address_snapshot: Record<string, unknown>;
          capability_snapshot: Record<string, unknown>;
        }>(
          `SELECT provider_endpoint_id, endpoint_type, address_snapshot,
                  capability_snapshot
           FROM delivery_destinations WHERE id = $1`,
          [outageFoundation.deliveryDestinationId],
        )
      ).rows[0]!;
      outageDestination = {
        providerEndpointId: outageDestinationRow.provider_endpoint_id,
        endpointType: outageDestinationRow.endpoint_type,
        addressSnapshot:
          outageDestinationRow.address_snapshot as Prisma.InputJsonObject,
        capabilitySnapshot:
          outageDestinationRow.capability_snapshot as Prisma.InputJsonObject,
        supportedCategoryIds: ["standard"],
      };
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }

    const previousEnvironment = {
      gate: process.env.TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED,
      provider: process.env.TAVEN_PAYMENT_PROVIDER,
      secret: process.env.TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET,
      providerUrl: process.env.TAVEN_PAYMENT_SANDBOX_PUBLIC_URL,
      siteUrl: process.env.TAVEN_PUBLIC_SITE_URL,
    };
    const signingSecret = "e2e-sandbox-payment-signing-secret-32";
    process.env.TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED = "true";
    process.env.TAVEN_PAYMENT_PROVIDER = "sandbox";
    process.env.TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET = signingSecret;
    process.env.TAVEN_PAYMENT_SANDBOX_PUBLIC_URL = "http://sandbox.local";
    process.env.TAVEN_PUBLIC_SITE_URL = "https://taven.cz";
    const sandbox = new SandboxPaymentProviderAdapter({
      provider: "sandbox",
      publicBaseUrl: "http://sandbox.local",
      webhookSigningSecret: signingSecret,
    });
    let providerAvailable = true;
    let sandboxCheckoutBaseUrl = "http://sandbox.local";
    const provider: PaymentProviderPort = {
      providerName: () => sandbox.providerName(),
      capabilities: () => sandbox.capabilities(),
      refundRetrySafety: () => sandbox.refundRetrySafety(),
      createIntent: async (input) => {
        if (!providerAvailable) throw new Error("simulated provider outage");
        const intent = await sandbox.createIntent(input);
        return {
          ...intent,
          checkoutUrl: new URL(
            `/payments/sandbox/${encodeURIComponent(intent.providerIntentId)}`,
            sandboxCheckoutBaseUrl,
          ).toString(),
        };
      },
      verifyEvent: (input) => sandbox.verifyEvent(input),
      cancelIntent: (providerIntentId) =>
        sandbox.cancelIntent(providerIntentId),
      refund: (input) => sandbox.refund(input),
    };
    let app: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [PaymentsModule],
      })
        .overrideProvider(DELIVERY_CAPABILITY)
        .useValue({
          list: async () => [],
          resolve: async (input: {
            providerEndpointId: string;
            endpointType: string;
          }) =>
            input.providerEndpointId === destination.providerEndpointId
              ? destination
              : outageDestination,
        })
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(provider)
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(0, "127.0.0.1");
      const baseUrl = new URL(await app.getUrl());
      sandboxCheckoutBaseUrl = baseUrl.origin;

      const createPayment = () =>
        fetch(
          new URL(
            `/automatic-quote-sessions/${foundation.quoteSessionId}/checkout/payments`,
            baseUrl,
          ),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": "sandbox-http-create-1",
            },
            body: JSON.stringify({
              email: customerEmail,
              fullName: "Sandbox Customer",
              method: "CARD",
              acceptTerms: true,
              acceptClaimPolicy: true,
              acknowledgeWithdrawalException: true,
            }),
          },
        );
      const createdResponse = await createPayment();
      expect(createdResponse.status).toBe(200);
      const created = (await createdResponse.json()) as {
        paymentId: string;
        amountMinor: number;
        currency: string;
        status: string;
        checkoutUrl: string;
      };
      expect(created).toMatchObject({
        status: "PENDING",
        currency: "EUR",
        checkoutUrl: `${baseUrl.origin}/payments/sandbox/sandbox-${created.paymentId}`,
      });

      const checkoutPageResponse = await fetch(created.checkoutUrl);
      expect(checkoutPageResponse.status).toBe(200);
      expect(await checkoutPageResponse.text()).toContain(
        "TAVEN. sandbox checkout",
      );

      const prisma = app.get(PrismaService);
      await prisma.$queryRaw`
        SELECT taven_release_phase_reservation_set(
          ${foundation.phaseReservationSetId}::uuid
        )
      `;

      const event = {
        providerEventId: `sandbox-http-capture-${created.paymentId}`,
        providerTransactionId: `sandbox-${created.paymentId}`,
        status: "CAPTURED",
        amountMinor: String(created.amountMinor),
        currency: created.currency,
        occurredAt: new Date().toISOString(),
      };
      const unsignedResponse = await fetch(
        new URL("/payments/webhooks/sandbox", baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-taven-sandbox-signature": "sha256=00",
          },
          body: JSON.stringify(event),
        },
      );
      expect(unsignedResponse.status).toBe(401);

      const sendSandboxOutcome = (outcome: string) =>
        fetch(`${created.checkoutUrl}/${outcome}`, { method: "POST" });
      const capturedResponse = await sendSandboxOutcome("capture");
      expect(capturedResponse.status).toBe(200);
      expect(await capturedResponse.text()).toContain(
        "Webhook outcome: <strong>CAPTURED</strong>",
      );
      const duplicateResponse = await sendSandboxOutcome("capture");
      expect(duplicateResponse.status).toBe(200);
      expect(await duplicateResponse.text()).toContain(
        "Webhook outcome: <strong>DUPLICATE</strong>",
      );

      await expect(
        prisma.order.findUniqueOrThrow({
          where: { id: foundation.orderId },
          select: { status: true, jobs: { select: { id: true } } },
        }),
      ).resolves.toMatchObject({
        status: "CONFIRMED",
        jobs: [{ id: expect.any(String) }],
      });
      await expect(
        prisma.payment.findUniqueOrThrow({
          where: { id: created.paymentId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "CAPTURED" });
      await expect(
        prisma.phaseReservationSet.findMany({
          where: {
            phaseResourcePlan: { orderPhaseId: foundation.orderPhaseId },
          },
          orderBy: { createdAt: "asc" },
          select: { status: true },
        }),
      ).resolves.toEqual([{ status: "RELEASED" }, { status: "HELD" }]);

      const replayResponse = await createPayment();
      expect(replayResponse.status).toBe(200);
      await expect(replayResponse.json()).resolves.toEqual(created);

      providerAvailable = false;
      const outageResponse = await fetch(
        new URL(
          `/automatic-quote-sessions/${outageFoundation.quoteSessionId}/checkout/payments`,
          baseUrl,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${outageToken}`,
            "content-type": "application/json",
            "idempotency-key": "sandbox-http-outage-1",
          },
          body: JSON.stringify({
            email: outageCustomerEmail,
            fullName: "Outage Customer",
            method: "BANK_TRANSFER",
            acceptTerms: true,
            acceptClaimPolicy: true,
            acknowledgeWithdrawalException: true,
          }),
        },
      );
      expect(outageResponse.status).toBe(502);
      await expect(
        prisma.payment.findFirstOrThrow({
          where: { orderId: outageFoundation.orderId },
          select: {
            status: true,
            intentCreationFailureResultId: true,
          },
        }),
      ).resolves.toMatchObject({
        status: "FAILED",
        intentCreationFailureResultId: expect.any(String),
      });
    } finally {
      await app?.close();
      restoreEnvironment(
        "TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED",
        previousEnvironment.gate,
      );
      restoreEnvironment(
        "TAVEN_PAYMENT_PROVIDER",
        previousEnvironment.provider,
      );
      restoreEnvironment(
        "TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET",
        previousEnvironment.secret,
      );
      restoreEnvironment(
        "TAVEN_PAYMENT_SANDBOX_PUBLIC_URL",
        previousEnvironment.providerUrl,
      );
      restoreEnvironment("TAVEN_PUBLIC_SITE_URL", previousEnvironment.siteUrl);
    }
  });

  it("turns a capture after customer cancellation into one compensation", async () => {
    await rollback("cancel-race", async (client, fixtures) => {
      const { foundation, providerIntentId } = await preparePayment(
        client,
        fixtures,
        "cancel-race",
      );
      const evidence = await eventEvidence(client, foundation);
      await client.query(
        `SELECT taven_close_initial_checkout_payment($1, 'CUSTOMER_CANCELLED')`,
        [foundation.paymentId],
      );
      const first = await client.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', 'cancel-race-capture', $1, 'PAYMENT_CAPTURED', $2, $3,
           clock_timestamp(), '{}'::jsonb
         ) AS outcome`,
        [providerIntentId, evidence.amount_minor, evidence.currency],
      );
      expect(first.rows).toEqual([{ outcome: "REFUND_PENDING" }]);
      const duplicate = await client.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', 'cancel-race-capture', $1, 'PAYMENT_CAPTURED', $2, $3,
           clock_timestamp(), '{}'::jsonb
         ) AS outcome`,
        [providerIntentId, evidence.amount_minor, evidence.currency],
      );
      expect(duplicate.rows).toEqual([{ outcome: "DUPLICATE" }]);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM refund_transactions
             WHERE payment_id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    });
  });

  it("serializes a real capture-versus-cancel race without unmatched money", async () => {
    const name = `concurrent-race-${randomUUID().slice(0, 8)}`;
    const setupClient = await pool.connect();
    let foundation: PersistenceFoundation;
    let providerIntentId: string;
    try {
      await setupClient.query("BEGIN");
      const fixtures = new PersistenceFactory(setupClient, `${scope}:${name}`, {
        publicTokenHash: createHash("sha256")
          .update(`${scope}:${name}:checkout-token`)
          .digest("hex"),
      });
      ({ foundation, providerIntentId } = await preparePayment(
        setupClient,
        fixtures,
        name,
      ));
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }
    const evidence = (
      await pool.query<{ amount_minor: string; currency: string }>(
        `SELECT requested_amount_minor::text AS amount_minor, currency
         FROM payments WHERE id = $1`,
        [foundation.paymentId],
      )
    ).rows[0]!;
    const eventId = `race-${foundation.paymentId}`;
    const [close, capture] = await Promise.all([
      pool.query<{ status: string }>(
        `SELECT taven_close_initial_checkout_payment(
           $1, 'CUSTOMER_CANCELLED'
         )::text AS status`,
        [foundation.paymentId],
      ),
      pool.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', $1, $2, 'PAYMENT_CAPTURED', $3, $4,
           clock_timestamp(), '{"source":"race-e2e"}'::jsonb
         ) AS outcome`,
        [eventId, providerIntentId, evidence.amount_minor, evidence.currency],
      ),
    ]);
    expect(["CAPTURED", "VOIDED"]).toContain(close.rows[0]?.status);
    expect(["CAPTURED", "REFUND_PENDING"]).toContain(capture.rows[0]?.outcome);
    const final = (
      await pool.query<{
        order_status: string;
        payment_status: string;
        job_count: number;
        refund_count: number;
        active_set_count: number;
      }>(
        `SELECT target_order.status::text AS order_status,
                payment.status::text AS payment_status,
                (SELECT count(*)::int FROM jobs
                 WHERE order_id = target_order.id) AS job_count,
                (SELECT count(*)::int FROM refund_transactions
                 WHERE payment_id = payment.id) AS refund_count,
                (SELECT count(*)::int
                 FROM phase_reservation_sets reservation_set
                 JOIN phase_resource_plans resource_plan
                   ON resource_plan.id = reservation_set.phase_resource_plan_id
                 WHERE resource_plan.order_phase_id = $2
                   AND reservation_set.status IN ('RESERVED', 'HELD'))
                   AS active_set_count
         FROM orders target_order
         JOIN payments payment ON payment.order_id = target_order.id
         WHERE target_order.id = $1`,
        [foundation.orderId, foundation.orderPhaseId],
      )
    ).rows[0]!;
    expect(["CAPTURED", "REFUND_PENDING"]).toContain(final.payment_status);
    if (final.payment_status === "CAPTURED") {
      expect(final).toEqual({
        order_status: "CONFIRMED",
        payment_status: "CAPTURED",
        job_count: 1,
        refund_count: 0,
        active_set_count: 1,
      });
    } else {
      expect(final).toEqual({
        order_status: "CANCELLED",
        payment_status: "REFUND_PENDING",
        job_count: 0,
        refund_count: 1,
        active_set_count: 0,
      });
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
