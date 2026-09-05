import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  DELIVERY_CAPABILITY,
  type ResolvedDeliveryCapability,
} from "../src/modules/automatic-quotes/delivery-capability.port";
import {
  PAYMENT_PROVIDER,
  PaymentIntentCreationError,
  type PaymentProviderPort,
} from "../src/modules/payments/payment-provider.port";
import { PaymentsModule } from "../src/modules/payments/payments.module";
import {
  SandboxPaymentProviderAdapter,
  sandboxEventSignature,
} from "../src/modules/payments/sandbox-payment-provider.adapter";
import { PrismaService } from "../src/prisma/prisma.service";
import { EligibilityPlanService } from "../src/modules/resources/eligibility-plan.service";
import { ResourceReservationService } from "../src/modules/resources/resource-reservation.service";
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

type InteractiveTransaction = (
  work: (transaction: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

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
  customerOwned = true,
) {
  const foundation = await fixtures.createFoundation(
    name,
    {},
    undefined,
    undefined,
    undefined,
    1,
    undefined,
    "QUOTED",
    undefined,
    {},
    "AUTOMATIC",
    true,
    customerOwned,
  );
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

async function waitForDatabaseLock(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE application_name = $1
           AND state = 'active'
           AND wait_event_type = 'Lock'
       ) AS waiting`,
      [applicationName],
    );
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("concurrent checkout event did not reach its lock wait");
}

const captureResourceInvalidations = [
  ["inactive node", `UPDATE nodes SET active = false WHERE id = $1`, "nodeId"],
  [
    "maintenance machine",
    `UPDATE machines SET status = 'MAINTENANCE' WHERE id = $1`,
    "machineId",
  ],
  [
    "retired inventory",
    `UPDATE inventories SET status = 'RETIRED' WHERE id = $1`,
    "inventoryId",
  ],
  [
    "retired machine profile",
    `UPDATE machine_profiles
     SET state = 'RETIRED', retired_at = clock_timestamp()
     WHERE id = $1`,
    "machineProfileId",
  ],
  [
    "retired machine calibration",
    `UPDATE machine_calibrations
     SET state = 'RETIRED', retired_at = clock_timestamp()
     WHERE id = $1`,
    "machineCalibrationId",
  ],
] as const;

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

  it.each(captureResourceInvalidations)(
    "revalidates and compensates after %s invalidates a live reservation",
    async (resourceName, invalidationSql, resourceIdKey) => {
      await rollback(`stale-${resourceIdKey}`, async (client, fixtures) => {
        const { foundation, providerIntentId } = await preparePayment(
          client,
          fixtures,
          `stale-${resourceIdKey}`,
        );
        const evidence = await eventEvidence(client, foundation);
        await client.query(invalidationSql, [foundation[resourceIdKey]]);

        const eventId = `stale-${resourceIdKey}-capture`;
        const capture = await client.query<{ outcome: string }>(
          `SELECT taven_apply_checkout_payment_event(
             'sandbox', $1, $2, 'PAYMENT_CAPTURED', $3, $4,
             clock_timestamp(), '{"source":"live-revalidation-e2e"}'::jsonb
           ) AS outcome`,
          [eventId, providerIntentId, evidence.amount_minor, evidence.currency],
        );
        expect(capture.rows).toEqual([{ outcome: "REFUND_PENDING" }]);

        const duplicate = await client.query<{ outcome: string }>(
          `SELECT taven_apply_checkout_payment_event(
             'sandbox', $1, $2, 'PAYMENT_CAPTURED', $3, $4,
             clock_timestamp(), '{"source":"live-revalidation-e2e"}'::jsonb
           ) AS outcome`,
          [eventId, providerIntentId, evidence.amount_minor, evidence.currency],
        );
        expect(duplicate.rows).toEqual([{ outcome: "DUPLICATE" }]);

        expect(
          (
            await client.query(
              `SELECT target_order.status::text AS order_status,
                      payment.status::text AS payment_status,
                      reservation_set.status::text AS set_status,
                      closed.payload ->> 'reason' AS close_reason,
                      compensation.payload ->> 'kind' AS compensation_kind,
                      (SELECT count(*)::int FROM jobs
                       WHERE order_id = target_order.id) AS job_count,
                      (SELECT count(*)::int FROM payment_provider_events
                       WHERE payment_id = payment.id) AS event_count,
                      (SELECT count(*)::int FROM refund_transactions
                       WHERE payment_id = payment.id) AS refund_count,
                      (SELECT count(*)::int FROM outbox_messages
                       WHERE aggregate_id = refund.id
                         AND message_type = 'refund_payment') AS refund_commands
               FROM orders target_order
               JOIN payments payment ON payment.order_id = target_order.id
               JOIN phase_reservation_sets reservation_set
                 ON reservation_set.id = $2
               JOIN refund_transactions refund
                 ON refund.payment_id = payment.id
               JOIN audit_events closed
                 ON closed.payment_id = payment.id
                AND closed.event_type = 'checkout.payment_closed'
               JOIN audit_events compensation
                 ON compensation.refund_transaction_id = refund.id
                AND compensation.event_type =
                    'checkout.late_capture_compensation_created'
               WHERE target_order.id = $1`,
              [foundation.orderId, foundation.phaseReservationSetId],
            )
          ).rows,
        ).toEqual([
          {
            order_status: "CANCELLED",
            payment_status: "REFUND_PENDING",
            set_status: "RELEASED",
            close_reason: "CAPACITY_UNAVAILABLE",
            compensation_kind: "initial_checkout_capacity",
            job_count: 0,
            event_count: 1,
            refund_count: 1,
            refund_commands: 1,
          },
        ]);
      });
    },
  );

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

  it("persists the capacity cause when capture cannot reacquire resources", async () => {
    await rollback("capacity-compensation", async (client, fixtures) => {
      const { foundation, providerIntentId } = await preparePayment(
        client,
        fixtures,
        "capacity-compensation",
      );
      const evidence = await eventEvidence(client, foundation);
      await client.query(
        `SELECT taven_release_phase_reservation_set($1::uuid)`,
        [foundation.phaseReservationSetId],
      );

      const capture = await client.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', 'capacity-compensation-capture', $1,
           'PAYMENT_CAPTURED', $2, $3, clock_timestamp(), '{}'::jsonb, true
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
                    closed.payload ->> 'reason' AS close_reason,
                    compensation.payload ->> 'kind' AS compensation_kind,
                    command.payload ->> 'compensationKind' AS command_kind,
                    (SELECT count(*)::int FROM jobs
                     WHERE order_id = target_order.id) AS job_count
             FROM orders target_order
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             JOIN audit_events closed
               ON closed.payment_id = payment.id
              AND closed.event_type = 'checkout.payment_closed'
             JOIN audit_events compensation
               ON compensation.refund_transaction_id = refund.id
              AND compensation.event_type =
                  'checkout.late_capture_compensation_created'
             JOIN outbox_messages command
               ON command.aggregate_id = refund.id
              AND command.message_type = 'refund_payment'
             WHERE target_order.id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "CANCELLED",
          payment_status: "REFUND_PENDING",
          refund_reason: "LATE_CAPTURE_COMPENSATION",
          close_reason: "CAPACITY_UNAVAILABLE",
          compensation_kind: "initial_checkout_capacity",
          command_kind: "initial_checkout_capacity",
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

      for (const [eventId, eventKind] of [
        ["returned-intent-pending", "PAYMENT_PENDING"],
        ["returned-intent-failed", "PAYMENT_FAILED"],
      ] as const) {
        const applyTerminalEvent = () =>
          client.query<{ outcome: string }>(
            `SELECT taven_apply_checkout_payment_event(
               'sandbox', $1, $2, $3::payment_provider_event_kind, $4, $5,
               clock_timestamp(), '{}'::jsonb
             ) AS outcome`,
            [
              eventId,
              providerIntentId,
              eventKind,
              evidence.amount_minor,
              evidence.currency,
            ],
          );
        expect((await applyTerminalEvent()).rows).toEqual([
          { outcome: "IGNORED_TERMINAL" },
        ]);
        expect((await applyTerminalEvent()).rows).toEqual([
          { outcome: "DUPLICATE" },
        ]);
      }
      expect(
        (
          await client.query(
            `SELECT payment.status::text AS payment_status,
                    (SELECT count(*)::int FROM payment_provider_events
                     WHERE payment_id = payment.id) AS event_count,
                    (SELECT count(*)::int FROM refund_transactions
                     WHERE payment_id = payment.id) AS refund_count,
                    (SELECT count(*)::int FROM jobs
                     WHERE order_id = payment.order_id) AS job_count
             FROM payments payment
             WHERE payment.id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          payment_status: "VOIDED",
          event_count: 2,
          refund_count: 0,
          job_count: 0,
        },
      ]);

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
                     WHERE order_id = payment.order_id) AS job_count,
                    (SELECT count(*)::int FROM payment_provider_events
                     WHERE payment_id = payment.id) AS event_count
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
          event_count: 3,
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
    const returnedIntentToken = randomBytes(32).toString("base64url");
    const returnedIntentPublicTokenHash = createHash("sha256")
      .update(returnedIntentToken)
      .digest("hex");
    const callbackToken = randomBytes(32).toString("base64url");
    const callbackPublicTokenHash = createHash("sha256")
      .update(callbackToken)
      .digest("hex");
    const ambiguousCallbackToken = randomBytes(32).toString("base64url");
    const ambiguousCallbackPublicTokenHash = createHash("sha256")
      .update(ambiguousCallbackToken)
      .digest("hex");
    const ambiguousCaptureToken = randomBytes(32).toString("base64url");
    const ambiguousCapturePublicTokenHash = createHash("sha256")
      .update(ambiguousCaptureToken)
      .digest("hex");
    const setupClient = await pool.connect();
    let foundation: PersistenceFoundation;
    let outageFoundation: PersistenceFoundation;
    let returnedIntentFoundation: PersistenceFoundation;
    let callbackFoundation: PersistenceFoundation;
    let ambiguousCallbackFoundation: PersistenceFoundation;
    let ambiguousCaptureFoundation: PersistenceFoundation;
    let customerEmail: string;
    let outageCustomerEmail: string;
    let returnedIntentCustomerEmail: string;
    let callbackCustomerEmail: string;
    let ambiguousCallbackCustomerEmail: string;
    let ambiguousCaptureCustomerEmail: string;
    let destination: ResolvedDeliveryCapability;
    let outageDestination: ResolvedDeliveryCapability;
    let returnedIntentDestination: ResolvedDeliveryCapability;
    let callbackDestination: ResolvedDeliveryCapability;
    let ambiguousCallbackDestination: ResolvedDeliveryCapability;
    let ambiguousCaptureDestination: ResolvedDeliveryCapability;
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
        false,
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
      const returnedIntentFixtures = new PersistenceFactory(
        setupClient,
        `${scope}:http-returned-intent`,
        { publicTokenHash: returnedIntentPublicTokenHash },
      );
      returnedIntentFoundation = await prepareReservedFoundation(
        setupClient,
        returnedIntentFixtures,
        "http-returned-intent",
      );
      returnedIntentCustomerEmail = (
        await setupClient.query<{ email: string }>(
          "SELECT email FROM customers WHERE id = $1",
          [returnedIntentFoundation.customerId],
        )
      ).rows[0]!.email;
      const returnedIntentDestinationRow = (
        await setupClient.query<{
          provider_endpoint_id: string;
          endpoint_type: string;
          address_snapshot: Record<string, unknown>;
          capability_snapshot: Record<string, unknown>;
        }>(
          `SELECT provider_endpoint_id, endpoint_type, address_snapshot,
                  capability_snapshot
           FROM delivery_destinations WHERE id = $1`,
          [returnedIntentFoundation.deliveryDestinationId],
        )
      ).rows[0]!;
      returnedIntentDestination = {
        providerEndpointId: returnedIntentDestinationRow.provider_endpoint_id,
        endpointType: returnedIntentDestinationRow.endpoint_type,
        addressSnapshot:
          returnedIntentDestinationRow.address_snapshot as Prisma.InputJsonObject,
        capabilitySnapshot:
          returnedIntentDestinationRow.capability_snapshot as Prisma.InputJsonObject,
        supportedCategoryIds: ["standard"],
      };
      const callbackFixtures = new PersistenceFactory(
        setupClient,
        `${scope}:http-callback-finalization`,
        { publicTokenHash: callbackPublicTokenHash },
      );
      callbackFoundation = await prepareReservedFoundation(
        setupClient,
        callbackFixtures,
        "http-callback-finalization",
      );
      callbackCustomerEmail = (
        await setupClient.query<{ email: string }>(
          "SELECT email FROM customers WHERE id = $1",
          [callbackFoundation.customerId],
        )
      ).rows[0]!.email;
      const callbackDestinationRow = (
        await setupClient.query<{
          provider_endpoint_id: string;
          endpoint_type: string;
          address_snapshot: Record<string, unknown>;
          capability_snapshot: Record<string, unknown>;
        }>(
          `SELECT provider_endpoint_id, endpoint_type, address_snapshot,
                  capability_snapshot
           FROM delivery_destinations WHERE id = $1`,
          [callbackFoundation.deliveryDestinationId],
        )
      ).rows[0]!;
      callbackDestination = {
        providerEndpointId: callbackDestinationRow.provider_endpoint_id,
        endpointType: callbackDestinationRow.endpoint_type,
        addressSnapshot:
          callbackDestinationRow.address_snapshot as Prisma.InputJsonObject,
        capabilitySnapshot:
          callbackDestinationRow.capability_snapshot as Prisma.InputJsonObject,
        supportedCategoryIds: ["standard"],
      };
      const ambiguousCallbackFixtures = new PersistenceFactory(
        setupClient,
        `${scope}:http-callback-ambiguity`,
        { publicTokenHash: ambiguousCallbackPublicTokenHash },
      );
      ambiguousCallbackFoundation = await prepareReservedFoundation(
        setupClient,
        ambiguousCallbackFixtures,
        "http-callback-ambiguity",
      );
      ambiguousCallbackCustomerEmail = (
        await setupClient.query<{ email: string }>(
          "SELECT email FROM customers WHERE id = $1",
          [ambiguousCallbackFoundation.customerId],
        )
      ).rows[0]!.email;
      const ambiguousCallbackDestinationRow = (
        await setupClient.query<{
          provider_endpoint_id: string;
          endpoint_type: string;
          address_snapshot: Record<string, unknown>;
          capability_snapshot: Record<string, unknown>;
        }>(
          `SELECT provider_endpoint_id, endpoint_type, address_snapshot,
                  capability_snapshot
           FROM delivery_destinations WHERE id = $1`,
          [ambiguousCallbackFoundation.deliveryDestinationId],
        )
      ).rows[0]!;
      ambiguousCallbackDestination = {
        providerEndpointId:
          ambiguousCallbackDestinationRow.provider_endpoint_id,
        endpointType: ambiguousCallbackDestinationRow.endpoint_type,
        addressSnapshot:
          ambiguousCallbackDestinationRow.address_snapshot as Prisma.InputJsonObject,
        capabilitySnapshot:
          ambiguousCallbackDestinationRow.capability_snapshot as Prisma.InputJsonObject,
        supportedCategoryIds: ["standard"],
      };
      const ambiguousCaptureFixtures = new PersistenceFactory(
        setupClient,
        `${scope}:http-ambiguous-capture`,
        { publicTokenHash: ambiguousCapturePublicTokenHash },
      );
      ambiguousCaptureFoundation = await prepareReservedFoundation(
        setupClient,
        ambiguousCaptureFixtures,
        "http-ambiguous-capture",
      );
      ambiguousCaptureCustomerEmail = (
        await setupClient.query<{ email: string }>(
          "SELECT email FROM customers WHERE id = $1",
          [ambiguousCaptureFoundation.customerId],
        )
      ).rows[0]!.email;
      const ambiguousCaptureDestinationRow = (
        await setupClient.query<{
          provider_endpoint_id: string;
          endpoint_type: string;
          address_snapshot: Record<string, unknown>;
          capability_snapshot: Record<string, unknown>;
        }>(
          `SELECT provider_endpoint_id, endpoint_type, address_snapshot,
                  capability_snapshot
           FROM delivery_destinations WHERE id = $1`,
          [ambiguousCaptureFoundation.deliveryDestinationId],
        )
      ).rows[0]!;
      ambiguousCaptureDestination = {
        providerEndpointId: ambiguousCaptureDestinationRow.provider_endpoint_id,
        endpointType: ambiguousCaptureDestinationRow.endpoint_type,
        addressSnapshot:
          ambiguousCaptureDestinationRow.address_snapshot as Prisma.InputJsonObject,
        capabilitySnapshot:
          ambiguousCaptureDestinationRow.capability_snapshot as Prisma.InputJsonObject,
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
      claimPolicyRevision: process.env.TAVEN_CLAIM_POLICY_REVISION,
      termsRevision: process.env.TAVEN_TERMS_REVISION,
      provider: process.env.TAVEN_PAYMENT_PROVIDER,
      secret: process.env.TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET,
      providerUrl: process.env.TAVEN_PAYMENT_SANDBOX_PUBLIC_URL,
      siteUrl: process.env.TAVEN_PUBLIC_SITE_URL,
    };
    const signingSecret = "e2e-sandbox-payment-signing-secret-32";
    process.env.TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED = "true";
    process.env.TAVEN_CLAIM_POLICY_REVISION = "claim-policy-v1";
    process.env.TAVEN_TERMS_REVISION = "terms-v1";
    process.env.TAVEN_PAYMENT_PROVIDER = "sandbox";
    process.env.TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET = signingSecret;
    process.env.TAVEN_PAYMENT_SANDBOX_PUBLIC_URL = "http://sandbox.local";
    process.env.TAVEN_PUBLIC_SITE_URL = "https://taven.cz";
    const sandbox = new SandboxPaymentProviderAdapter({
      provider: "sandbox",
      publicBaseUrl: "http://sandbox.local",
      webhookSigningSecret: signingSecret,
    });
    let providerFailure: "DEFINITIVE" | "AMBIGUOUS" | null = null;
    let deliveryResolutionError: Error | null = null;
    let providerCreateCalls = 0;
    let providerVerifyCalls = 0;
    let providerCancelCalls = 0;
    let sandboxCheckoutBaseUrl = "http://sandbox.local";
    let applicationBaseUrl: URL | undefined;
    let failNextFinalizationBeforeCommit = false;
    let failNextReturnedIntentClose = false;
    let markAmbiguousCaptureIntentStarted!: () => void;
    const ambiguousCaptureIntentStarted = new Promise<void>((resolve) => {
      markAmbiguousCaptureIntentStarted = resolve;
    });
    let rejectAmbiguousCaptureIntent!: () => void;
    const ambiguousCaptureIntentResume = new Promise<void>((resolve) => {
      rejectAmbiguousCaptureIntent = resolve;
    });
    let latestReturnUrls:
      | Readonly<{ success: string; cancelled: string; pending: string }>
      | undefined;
    const provider: PaymentProviderPort = {
      providerName: () => sandbox.providerName(),
      capabilities: () => sandbox.capabilities(),
      refundRetrySafety: () => sandbox.refundRetrySafety(),
      createIntent: async (input) => {
        providerCreateCalls += 1;
        if (input.email === ambiguousCaptureCustomerEmail) {
          await sandbox.createIntent(input);
          markAmbiguousCaptureIntentStarted();
          await ambiguousCaptureIntentResume;
          throw new Error(
            "simulated lost provider response during verified capture",
          );
        }
        if (providerFailure === "DEFINITIVE") {
          throw new PaymentIntentCreationError(
            "DEFINITIVE_FAILURE",
            "simulated provider rejection",
          );
        }
        if (providerFailure === "AMBIGUOUS") {
          throw new Error("simulated lost provider response");
        }
        latestReturnUrls = input.returnUrls;
        const intent = await sandbox.createIntent(input);
        if (input.email === returnedIntentCustomerEmail) {
          failNextReturnedIntentClose = true;
          throw new PaymentIntentCreationError(
            "AMBIGUOUS",
            "simulated unusable checkout result",
            { providerIntentId: intent.providerIntentId },
          );
        }
        if (
          input.email === callbackCustomerEmail ||
          input.email === ambiguousCallbackCustomerEmail
        ) {
          if (!applicationBaseUrl) {
            throw new Error("callback test application URL is unavailable");
          }
          const pendingEvent = {
            providerEventId: `sandbox-create-pending-${input.paymentId}`,
            providerTransactionId: intent.providerIntentId,
            merchantReference: input.merchantReference,
            status: "PENDING",
            amountMinor: input.amountMinor.toString(),
            currency: input.currency,
            occurredAt: new Date().toISOString(),
          };
          const pendingResponse = await fetch(
            new URL("/payments/webhooks/sandbox", applicationBaseUrl),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-taven-sandbox-signature": sandboxEventSignature(
                  pendingEvent,
                  signingSecret,
                ),
              },
              body: JSON.stringify(pendingEvent),
            },
          );
          if (!pendingResponse.ok) {
            throw new Error("callback staging failed during intent creation");
          }
          if (input.email === ambiguousCallbackCustomerEmail) {
            throw new Error(
              "simulated lost provider response after pending callback",
            );
          }
          failNextFinalizationBeforeCommit = true;
        }
        return {
          ...intent,
          checkoutUrl: new URL(
            `/payments/sandbox/${encodeURIComponent(intent.providerIntentId)}`,
            sandboxCheckoutBaseUrl,
          ).toString(),
        };
      },
      locateEvent: (input) => sandbox.locateEvent(input),
      verifyEvent: (input) => {
        providerVerifyCalls += 1;
        return sandbox.verifyEvent(input);
      },
      cancelIntent: (providerIntentId) => {
        providerCancelCalls += 1;
        return sandbox.cancelIntent(providerIntentId);
      },
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
          }) => {
            if (deliveryResolutionError) throw deliveryResolutionError;
            if (input.providerEndpointId === destination.providerEndpointId) {
              return destination;
            }
            if (
              input.providerEndpointId ===
              callbackDestination.providerEndpointId
            ) {
              return callbackDestination;
            }
            if (
              input.providerEndpointId ===
              ambiguousCallbackDestination.providerEndpointId
            ) {
              return ambiguousCallbackDestination;
            }
            if (
              input.providerEndpointId ===
              returnedIntentDestination.providerEndpointId
            ) {
              return returnedIntentDestination;
            }
            if (
              input.providerEndpointId ===
              ambiguousCaptureDestination.providerEndpointId
            ) {
              return ambiguousCaptureDestination;
            }
            return outageDestination;
          },
        })
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(provider)
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(0, "127.0.0.1");
      const baseUrl = new URL(await app.getUrl());
      applicationBaseUrl = baseUrl;
      sandboxCheckoutBaseUrl = baseUrl.origin;
      const prisma = app.get(PrismaService);
      await prisma.customer.update({
        where: { id: foundation.customerId },
        data: { displayName: "Existing Customer" },
      });

      const outageIdempotencyKey = "sandbox-http-outage-1";
      const createOutagePayment = (idempotencyKey = outageIdempotencyKey) =>
        fetch(
          new URL(
            `/automatic-quote-sessions/${outageFoundation.quoteSessionId}/checkout/payments`,
            baseUrl,
          ),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${outageToken}`,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
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
      const createAmbiguousCapturePayment = () =>
        fetch(
          new URL(
            `/automatic-quote-sessions/${ambiguousCaptureFoundation.quoteSessionId}/checkout/payments`,
            baseUrl,
          ),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${ambiguousCaptureToken}`,
              "content-type": "application/json",
              "idempotency-key": "sandbox-ambiguous-capture-1",
            },
            body: JSON.stringify({
              email: ambiguousCaptureCustomerEmail,
              fullName: "Ambiguous Capture Customer",
              method: "CARD",
              acceptTerms: true,
              acceptClaimPolicy: true,
              acknowledgeWithdrawalException: true,
            }),
          },
        );
      const createReturnedIntentPayment = () =>
        fetch(
          new URL(
            `/automatic-quote-sessions/${returnedIntentFoundation.quoteSessionId}/checkout/payments`,
            baseUrl,
          ),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${returnedIntentToken}`,
              "content-type": "application/json",
              "idempotency-key": "sandbox-returned-intent-1",
            },
            body: JSON.stringify({
              email: returnedIntentCustomerEmail,
              fullName: "Returned Intent Customer",
              method: "CARD",
              acceptTerms: true,
              acceptClaimPolicy: true,
              acknowledgeWithdrawalException: true,
            }),
          },
        );

      process.env.TAVEN_PUBLIC_SITE_URL = "not-an-absolute-url";
      const invalidSiteResponse = await createOutagePayment();
      expect(invalidSiteResponse.status).toBe(500);
      await expect(
        app.get(PrismaService).payment.count({
          where: { orderId: outageFoundation.orderId },
        }),
      ).resolves.toBe(0);
      await expect(
        app.get(PrismaService).idempotencyRecord.count({
          where: {
            namespace: `checkout-payment:${outageFoundation.quoteSessionId}`,
            idempotencyKey: outageIdempotencyKey,
          },
        }),
      ).resolves.toBe(0);
      process.env.TAVEN_PUBLIC_SITE_URL = "https://taven.cz";

      const createPayment = (
        idempotencyKey = "sandbox-http-create-1",
        overrides: Partial<{
          email: string;
          fullName: string;
          method: "CARD" | "BANK_TRANSFER";
        }> = {},
      ) =>
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
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify({
              email: customerEmail,
              fullName: "Sandbox Customer",
              method: "CARD",
              acceptTerms: true,
              acceptClaimPolicy: true,
              acknowledgeWithdrawalException: true,
              ...overrides,
            }),
          },
        );
      const createCallbackPayment = () =>
        fetch(
          new URL(
            `/automatic-quote-sessions/${callbackFoundation.quoteSessionId}/checkout/payments`,
            baseUrl,
          ),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${callbackToken}`,
              "content-type": "application/json",
              "idempotency-key": "sandbox-callback-finalization-1",
            },
            body: JSON.stringify({
              email: callbackCustomerEmail,
              fullName: "Callback Customer",
              method: "CARD",
              acceptTerms: true,
              acceptClaimPolicy: true,
              acknowledgeWithdrawalException: true,
            }),
          },
        );
      const createAmbiguousCallbackPayment = () =>
        fetch(
          new URL(
            `/automatic-quote-sessions/${ambiguousCallbackFoundation.quoteSessionId}/checkout/payments`,
            baseUrl,
          ),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${ambiguousCallbackToken}`,
              "content-type": "application/json",
              "idempotency-key": "sandbox-callback-ambiguity-1",
            },
            body: JSON.stringify({
              email: ambiguousCallbackCustomerEmail,
              fullName: "Ambiguous Callback Customer",
              method: "CARD",
              acceptTerms: true,
              acceptClaimPolicy: true,
              acknowledgeWithdrawalException: true,
            }),
          },
        );
      const readPayment = (
        sessionId: string,
        sessionToken: string,
        paymentId?: string,
      ) => {
        const url = new URL(
          `/automatic-quote-sessions/${sessionId}/checkout/payment`,
          baseUrl,
        );
        if (paymentId !== undefined) {
          url.searchParams.set("paymentId", paymentId);
        }
        return fetch(url, {
          headers: { authorization: `Bearer ${sessionToken}` },
        });
      };
      const cancelPayment = (
        sessionId: string,
        sessionToken: string,
        paymentId?: string,
      ) => {
        const url = new URL(
          `/automatic-quote-sessions/${sessionId}/checkout/payment`,
          baseUrl,
        );
        if (paymentId !== undefined) {
          url.searchParams.set("paymentId", paymentId);
        }
        return fetch(url, {
          method: "DELETE",
          headers: { authorization: `Bearer ${sessionToken}` },
        });
      };
      const transactions = prisma as unknown as {
        $transaction: InteractiveTransaction;
      };
      const originalTransaction = transactions.$transaction.bind(prisma);

      process.env.TAVEN_TERMS_REVISION = "terms-pending";
      const providerCallsBeforeUnapprovedTerms = providerCreateCalls;
      const unapprovedTermsResponse = await createPayment(
        "sandbox-http-unapproved-terms",
      );
      expect(unapprovedTermsResponse.status).toBe(503);
      expect(providerCreateCalls).toBe(providerCallsBeforeUnapprovedTerms);
      process.env.TAVEN_TERMS_REVISION = "terms-v1";

      let returnedIntentCloseFailures = 0;
      const returnedIntentTransactionSpy = vi
        .spyOn(transactions, "$transaction")
        .mockImplementation(async (work) => {
          if (failNextReturnedIntentClose) {
            failNextReturnedIntentClose = false;
            returnedIntentCloseFailures += 1;
            throw new Error("simulated returned-intent close failure");
          }
          return originalTransaction(work);
        });
      const returnedIntentResponse = await createReturnedIntentPayment();
      returnedIntentTransactionSpy.mockRestore();
      expect(returnedIntentResponse.status).toBe(200);
      expect(returnedIntentCloseFailures).toBe(1);
      const returnedIntentPayment = await prisma.payment.findFirstOrThrow({
        where: { orderId: returnedIntentFoundation.orderId },
        include: { checkoutCommand: true },
      });
      await expect(returnedIntentResponse.json()).resolves.toMatchObject({
        paymentId: returnedIntentPayment.id,
        status: "VOIDED",
        checkoutUrl: null,
      });
      expect(returnedIntentPayment).toMatchObject({
        status: "VOIDED",
        providerIntentId: null,
        providerCheckoutUrl: null,
        checkoutCommand: { status: "COMPLETED" },
      });
      await expect(
        prisma.outboxMessage.findFirstOrThrow({
          where: {
            aggregateId: returnedIntentPayment.id,
            messageType: "void_payment",
          },
          select: { payload: true },
        }),
      ).resolves.toMatchObject({
        payload: {
          paymentId: returnedIntentPayment.id,
          providerIntentId: `sandbox-${returnedIntentPayment.id}`,
          action: "void_payment",
        },
      });
      const providerCallsAfterReturnedIntent = providerCreateCalls;
      const returnedIntentReplay = await createReturnedIntentPayment();
      expect(returnedIntentReplay.status).toBe(200);
      await expect(returnedIntentReplay.json()).resolves.toMatchObject({
        paymentId: returnedIntentPayment.id,
        status: "VOIDED",
      });
      expect(providerCreateCalls).toBe(providerCallsAfterReturnedIntent);
      expect(providerCancelCalls).toBe(0);

      const ambiguousCallbackResponse = await createAmbiguousCallbackPayment();
      expect(ambiguousCallbackResponse.status).toBe(200);
      const ambiguousCallbackPayment = await prisma.payment.findFirstOrThrow({
        where: { orderId: ambiguousCallbackFoundation.orderId },
        include: { checkoutCommand: true },
      });
      await expect(ambiguousCallbackResponse.json()).resolves.toMatchObject({
        paymentId: ambiguousCallbackPayment.id,
        status: "VOIDED",
        checkoutUrl: null,
      });
      expect(ambiguousCallbackPayment).toMatchObject({
        status: "VOIDED",
        providerIntentId: `sandbox-${ambiguousCallbackPayment.id}`,
        providerCheckoutUrl: null,
        checkoutCommand: { status: "COMPLETED" },
      });
      await expect(
        prisma.outboxMessage.count({
          where: {
            aggregateId: ambiguousCallbackPayment.id,
            messageType: "void_payment",
          },
        }),
      ).resolves.toBe(1);
      const providerCallsAfterAmbiguousCallback = providerCreateCalls;
      const ambiguousCallbackReplay = await createAmbiguousCallbackPayment();
      expect(ambiguousCallbackReplay.status).toBe(200);
      await expect(ambiguousCallbackReplay.json()).resolves.toMatchObject({
        paymentId: ambiguousCallbackPayment.id,
        status: "VOIDED",
        checkoutUrl: null,
      });
      expect(providerCreateCalls).toBe(providerCallsAfterAmbiguousCallback);
      expect(providerCancelCalls).toBe(0);

      const callbackTransactionSpy = vi
        .spyOn(transactions, "$transaction")
        .mockImplementation(async (work) => {
          if (failNextFinalizationBeforeCommit) {
            failNextFinalizationBeforeCommit = false;
            throw new Error("simulated finalization transaction failure");
          }
          return originalTransaction(work);
        });
      const callbackResponse = await createCallbackPayment();
      callbackTransactionSpy.mockRestore();
      expect(callbackResponse.status).toBe(200);
      const callbackPayment = await prisma.payment.findFirstOrThrow({
        where: { orderId: callbackFoundation.orderId },
        include: { checkoutCommand: true },
      });
      await expect(callbackResponse.json()).resolves.toMatchObject({
        paymentId: callbackPayment.id,
        status: "VOIDED",
      });
      expect(callbackPayment).toMatchObject({
        status: "VOIDED",
        providerIntentId: `sandbox-${callbackPayment.id}`,
        providerCheckoutUrl: null,
        checkoutCommand: { status: "COMPLETED" },
      });
      await expect(
        prisma.outboxMessage.count({
          where: {
            aggregateId: callbackPayment.id,
            messageType: "void_payment",
          },
        }),
      ).resolves.toBe(1);
      const providerCallsAfterCallbackClose = providerCreateCalls;
      const callbackReplay = await createCallbackPayment();
      expect(callbackReplay.status).toBe(200);
      await expect(callbackReplay.json()).resolves.toMatchObject({
        paymentId: callbackPayment.id,
        status: "VOIDED",
      });
      expect(providerCreateCalls).toBe(providerCallsAfterCallbackClose);
      expect(providerCancelCalls).toBe(0);

      let checkoutTransactionCount = 0;
      const transactionSpy = vi
        .spyOn(transactions, "$transaction")
        .mockImplementation(async (work) => {
          const result = await originalTransaction(work);
          checkoutTransactionCount += 1;
          if (checkoutTransactionCount === 3) {
            throw new Error("simulated lost commit acknowledgement");
          }
          return result;
        });
      const createdResponse = await createPayment();
      transactionSpy.mockRestore();
      expect(createdResponse.status).toBe(200);
      expect(checkoutTransactionCount).toBe(3);
      expect(providerCancelCalls).toBe(0);
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
      const returnQuery = `?sessionId=${foundation.quoteSessionId}&paymentId=${created.paymentId}`;
      expect(latestReturnUrls).toEqual({
        success: `https://taven.cz/checkout/payment/success${returnQuery}`,
        cancelled: `https://taven.cz/checkout/payment/cancelled${returnQuery}`,
        pending: `https://taven.cz/checkout/payment/pending${returnQuery}`,
      });

      const exactStatusResponse = await readPayment(
        foundation.quoteSessionId,
        token,
        created.paymentId,
      );
      expect(exactStatusResponse.status).toBe(200);
      await expect(exactStatusResponse.json()).resolves.toMatchObject({
        paymentId: created.paymentId,
        status: "PENDING",
      });
      await expect(
        prisma.customer.findUniqueOrThrow({
          where: { id: foundation.customerId },
          select: { displayName: true },
        }),
      ).resolves.toEqual({ displayName: "Existing Customer" });
      await expect(
        Promise.all([
          prisma.quoteSession.findUniqueOrThrow({
            where: { id: foundation.quoteSessionId },
            select: { customerId: true },
          }),
          prisma.order.findUniqueOrThrow({
            where: { id: foundation.orderId },
            select: { customerId: true },
          }),
        ]),
      ).resolves.toEqual([
        { customerId: foundation.customerId },
        { customerId: foundation.customerId },
      ]);
      const callsAfterInitialPayment = providerCreateCalls;
      process.env.TAVEN_CLAIM_POLICY_REVISION = "claims-v2-approved";
      const changedActivePolicyResponse = await createPayment(
        "sandbox-http-changed-active-claim-policy",
      );
      expect(changedActivePolicyResponse.status).toBe(503);
      process.env.TAVEN_CLAIM_POLICY_REVISION = "claim-policy-v1";
      expect(providerCreateCalls).toBe(callsAfterInitialPayment);
      for (const [idempotencyKey, overrides] of [
        ["sandbox-http-changed-method", { method: "BANK_TRANSFER" }],
        ["sandbox-http-changed-name", { fullName: "Changed Name" }],
        ["sandbox-http-changed-email", { email: "other@example.test" }],
      ] as const) {
        const changedResponse = await createPayment(idempotencyKey, overrides);
        expect(changedResponse.status).toBe(409);
      }
      expect(providerCreateCalls).toBe(callsAfterInitialPayment);
      await expect(
        prisma.payment.count({ where: { orderId: foundation.orderId } }),
      ).resolves.toBe(1);
      const matchingResponse = await createPayment(
        "sandbox-http-matching-input",
      );
      expect(matchingResponse.status).toBe(200);
      await expect(matchingResponse.json()).resolves.toEqual(created);
      expect(providerCreateCalls).toBe(callsAfterInitialPayment);
      await expect(
        readPayment(foundation.quoteSessionId, token),
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        readPayment(foundation.quoteSessionId, token, "invalid-payment-id"),
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        readPayment(
          outageFoundation.quoteSessionId,
          outageToken,
          created.paymentId,
        ),
      ).resolves.toMatchObject({ status: 404 });

      const checkoutPageResponse = await fetch(created.checkoutUrl);
      expect(checkoutPageResponse.status).toBe(200);
      expect(await checkoutPageResponse.text()).toContain(
        "TAVEN. sandbox checkout",
      );

      await prisma.$queryRaw`
        SELECT taven_release_phase_reservation_set(
          ${foundation.phaseReservationSetId}::uuid
        )
      `;

      const event = {
        providerEventId: `sandbox-http-capture-${created.paymentId}`,
        providerTransactionId: `sandbox-${created.paymentId}`,
        merchantReference: created.paymentId,
        status: "CAPTURED",
        amountMinor: String(created.amountMinor),
        currency: created.currency,
        occurredAt: new Date().toISOString(),
      };
      const sendPublicWebhook = (payload: unknown) =>
        fetch(new URL("/payments/webhooks/sandbox", baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-taven-sandbox-signature": sandboxEventSignature(
              payload,
              signingSecret,
            ),
          },
          body: JSON.stringify(payload),
        });
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

      const unknownEvent = {
        ...event,
        providerEventId: `sandbox-http-unknown-${randomUUID()}`,
        providerTransactionId: `sandbox-${randomUUID()}`,
        merchantReference: randomUUID(),
      };
      const callsBeforeUnknownEvent = providerVerifyCalls;
      const unknownResponse = await sendPublicWebhook(unknownEvent);
      expect(unknownResponse.status).toBe(404);
      expect(providerVerifyCalls).toBe(callsBeforeUnknownEvent);

      const pendingEvent = {
        ...event,
        providerEventId: `sandbox-http-pending-${created.paymentId}`,
        status: "PENDING",
      };
      const callsBeforeRateLimit = providerVerifyCalls;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await sendPublicWebhook(pendingEvent);
        expect(response.status).toBe(200);
        await response.json();
      }
      const rateLimitedResponse = await sendPublicWebhook(pendingEvent);
      expect(rateLimitedResponse.status).toBe(429);
      expect(providerVerifyCalls).toBe(callsBeforeRateLimit + 12);
      const eventsBeforeTransientCapture =
        await prisma.paymentProviderEvent.count({
          where: { paymentId: created.paymentId },
        });

      const sendSandboxOutcome = (outcome: string) =>
        fetch(`${created.checkoutUrl}/${outcome}`, { method: "POST" });
      const eligibilityPlanService = app.get(EligibilityPlanService);
      const createCompletePlan = eligibilityPlanService.createCompletePlan.bind(
        eligibilityPlanService,
      );
      let firstReacquisitionPlanKey: string | undefined;
      const reacquisitionPlanKeys: string[] = [];
      const eligibilityPlan = vi
        .spyOn(eligibilityPlanService, "createCompletePlan")
        .mockImplementation(async (input) => {
          const plan = await createCompletePlan(input);
          firstReacquisitionPlanKey ??= input.planKey;
          reacquisitionPlanKeys.push(input.planKey);
          return input.planKey === firstReacquisitionPlanKey
            ? { ...plan, expiresAt: new Date(0) }
            : plan;
        });
      const reacquireForCapture = vi
        .spyOn(app.get(ResourceReservationService), "reacquireForCapture")
        .mockRejectedValueOnce(
          new Error("simulated temporary reservation reacquisition failure"),
        );
      const transientReacquisitionResponse =
        await sendSandboxOutcome("capture");
      reacquireForCapture.mockRestore();
      expect(transientReacquisitionResponse.status).toBe(500);
      await expect(
        prisma.paymentProviderEvent.count({
          where: { paymentId: created.paymentId },
        }),
      ).resolves.toBe(eventsBeforeTransientCapture);
      await expect(
        prisma.refundTransaction.count({
          where: { paymentId: created.paymentId },
        }),
      ).resolves.toBe(0);

      deliveryResolutionError = new Error(
        "simulated temporary delivery resolution failure",
      );
      const transientCaptureResponse = await sendSandboxOutcome("capture");
      expect(transientCaptureResponse.status).toBe(500);
      const paymentAfterTransientCapture =
        await prisma.payment.findUniqueOrThrow({
          where: { id: created.paymentId },
          select: {
            status: true,
            providerEvents: { select: { id: true } },
            refunds: { select: { id: true } },
          },
        });
      expect(paymentAfterTransientCapture).toMatchObject({
        status: "PENDING",
        refunds: [],
      });
      expect(paymentAfterTransientCapture.providerEvents).toHaveLength(
        eventsBeforeTransientCapture,
      );
      deliveryResolutionError = null;
      const capturedResponse = await sendSandboxOutcome("capture");
      expect(capturedResponse.status).toBe(200);
      expect(await capturedResponse.text()).toContain(
        "Webhook outcome: <strong>CAPTURED</strong>",
      );
      eligibilityPlan.mockRestore();
      expect(reacquisitionPlanKeys).toHaveLength(4);
      expect(new Set(reacquisitionPlanKeys).size).toBe(2);
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

      process.env.TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED = "false";
      const replayResponse = await createPayment();
      expect(replayResponse.status).toBe(200);
      await expect(replayResponse.json()).resolves.toEqual(created);
      process.env.TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED = "true";

      providerFailure = "DEFINITIVE";
      const outageResponse = await createOutagePayment();
      expect(outageResponse.status).toBe(502);
      const firstFailedPayment = await prisma.payment.findFirstOrThrow({
        where: { orderId: outageFoundation.orderId },
        select: {
          id: true,
          status: true,
          intentCreationFailureResultId: true,
        },
      });
      expect(firstFailedPayment).toMatchObject({
        status: "FAILED",
        intentCreationFailureResultId: expect.any(String),
      });

      const callsBeforeFailedPolicyChange = providerCreateCalls;
      process.env.TAVEN_CLAIM_POLICY_REVISION = "claims-v2-approved";
      const changedFailedPolicyResponse = await createOutagePayment(
        "sandbox-http-changed-failed-claim-policy",
      );
      expect(changedFailedPolicyResponse.status).toBe(503);
      process.env.TAVEN_CLAIM_POLICY_REVISION = "claim-policy-v1";
      expect(providerCreateCalls).toBe(callsBeforeFailedPolicyChange);
      await expect(
        Promise.all([
          prisma.payment.count({
            where: { orderId: outageFoundation.orderId },
          }),
          prisma.order.findUniqueOrThrow({
            where: { id: outageFoundation.orderId },
            select: {
              acceptedTermsRevision: true,
              acceptedClaimPolicyRevision: true,
            },
          }),
        ]),
      ).resolves.toEqual([
        1,
        {
          acceptedTermsRevision: "terms-v1",
          acceptedClaimPolicyRevision: "claim-policy-v1",
        },
      ]);

      const firstOutageRecord = await prisma.idempotencyRecord.findFirstOrThrow(
        {
          where: {
            namespace: `checkout-payment:${outageFoundation.quoteSessionId}`,
            idempotencyKey: outageIdempotencyKey,
          },
          orderBy: { generation: "desc" },
        },
      );
      await prisma.idempotencyRecord.update({
        where: { id: firstOutageRecord.id },
        data: {
          expiresAt: new Date(firstOutageRecord.createdAt.getTime() + 1),
        },
      });

      const retriedOutageResponse = await createOutagePayment();
      expect(retriedOutageResponse.status).toBe(502);
      await expect(
        prisma.idempotencyRecord.findMany({
          where: {
            namespace: `checkout-payment:${outageFoundation.quoteSessionId}`,
            idempotencyKey: outageIdempotencyKey,
          },
          orderBy: { generation: "asc" },
          select: { generation: true, status: true },
        }),
      ).resolves.toEqual([
        { generation: 1, status: "COMPLETED" },
        { generation: 2, status: "COMPLETED" },
      ]);
      await expect(
        prisma.payment.count({
          where: { orderId: outageFoundation.orderId, status: "FAILED" },
        }),
      ).resolves.toBe(2);
      const failedPayments = await prisma.payment.findMany({
        where: { orderId: outageFoundation.orderId, status: "FAILED" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const firstAttemptStatus = await readPayment(
        outageFoundation.quoteSessionId,
        outageToken,
        firstFailedPayment.id,
      );
      expect(firstAttemptStatus.status).toBe(200);
      await expect(firstAttemptStatus.json()).resolves.toMatchObject({
        paymentId: firstFailedPayment.id,
        status: "FAILED",
      });
      const secondFailedPayment = failedPayments.find(
        ({ id }) => id !== firstFailedPayment.id,
      );
      if (!secondFailedPayment) {
        throw new Error("Second failed payment was not created");
      }
      const secondAttemptStatus = await readPayment(
        outageFoundation.quoteSessionId,
        outageToken,
        secondFailedPayment.id,
      );
      expect(secondAttemptStatus.status).toBe(200);
      await expect(secondAttemptStatus.json()).resolves.toMatchObject({
        paymentId: secondFailedPayment.id,
        status: "FAILED",
      });

      providerFailure = "AMBIGUOUS";
      const ambiguousKey = "sandbox-http-ambiguous-1";
      const callsBeforeAmbiguity = providerCreateCalls;
      const ambiguousResponse = await createOutagePayment(ambiguousKey);
      expect(ambiguousResponse.status).toBe(502);
      const ambiguousPayment = await prisma.payment.findFirstOrThrow({
        where: {
          orderId: outageFoundation.orderId,
          status: "CREATED",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(ambiguousPayment).toMatchObject({
        merchantReference: ambiguousPayment.id,
        checkoutCommandId: expect.any(String),
        intentCreationFailureResultId: null,
      });
      await expect(
        prisma.auditEvent.count({
          where: {
            paymentId: ambiguousPayment.id,
            eventType: "checkout.payment_intent_creation_ambiguous",
          },
        }),
      ).resolves.toBe(1);

      const blockedRetry = await createOutagePayment(
        "sandbox-http-ambiguous-other",
      );
      expect(blockedRetry.status).toBe(409);
      expect(providerCreateCalls).toBe(callsBeforeAmbiguity + 1);

      const ambiguousCaptureRequest = createAmbiguousCapturePayment();
      await ambiguousCaptureIntentStarted;
      const ambiguousCapturePayment = await prisma.payment.findFirstOrThrow({
        where: {
          orderId: ambiguousCaptureFoundation.orderId,
          status: "CREATED",
        },
      });
      await prisma.$queryRaw`
        SELECT taven_release_phase_reservation_set(
          ${ambiguousCaptureFoundation.phaseReservationSetId}::uuid
        )
      `;
      const recoveredTransactionId = `sandbox-${ambiguousCapturePayment.id}`;
      const recoveredCapture = {
        providerEventId: `sandbox-recovered-capture-${ambiguousCapturePayment.id}`,
        providerTransactionId: recoveredTransactionId,
        merchantReference: ambiguousCapturePayment.merchantReference,
        status: "CAPTURED",
        amountMinor: ambiguousCapturePayment.requestedAmountMinor.toString(),
        currency: ambiguousCapturePayment.currency,
        occurredAt: new Date().toISOString(),
      };
      let markRecoveryPlanEntered!: () => void;
      const recoveryPlanEntered = new Promise<void>((resolve) => {
        markRecoveryPlanEntered = resolve;
      });
      let resumeRecoveryPlan!: () => void;
      const recoveryPlanResume = new Promise<void>((resolve) => {
        resumeRecoveryPlan = resolve;
      });
      const recoveryPlanSpy = vi
        .spyOn(eligibilityPlanService, "createCompletePlan")
        .mockImplementationOnce(async (input) => {
          const plan = await createCompletePlan(input);
          markRecoveryPlanEntered();
          await recoveryPlanResume;
          return plan;
        });
      const recoveredCaptureRequest = sendPublicWebhook(recoveredCapture);
      try {
        await recoveryPlanEntered;
        const concurrentSameKeyRetry = await createAmbiguousCapturePayment();
        expect(concurrentSameKeyRetry.status).toBe(200);
        await expect(concurrentSameKeyRetry.json()).resolves.toMatchObject({
          paymentId: ambiguousCapturePayment.id,
          status: "PENDING",
          checkoutUrl: null,
        });
        rejectAmbiguousCaptureIntent();
        const originalCreateResponse = await ambiguousCaptureRequest;
        expect(originalCreateResponse.status).toBe(200);
        await expect(originalCreateResponse.json()).resolves.toMatchObject({
          paymentId: ambiguousCapturePayment.id,
          status: "PENDING",
          checkoutUrl: null,
        });
      } finally {
        rejectAmbiguousCaptureIntent();
        resumeRecoveryPlan();
        recoveryPlanSpy.mockRestore();
      }
      const recoveredCaptureResponse = await recoveredCaptureRequest;
      expect(recoveredCaptureResponse.status).toBe(200);
      await expect(recoveredCaptureResponse.json()).resolves.toEqual({
        outcome: "CAPTURED",
      });
      await expect(
        Promise.all([
          prisma.payment.findUniqueOrThrow({
            where: { id: ambiguousCapturePayment.id },
            select: {
              status: true,
              providerIntentId: true,
              providerCaptureId: true,
              refunds: { select: { id: true } },
            },
          }),
          prisma.order.findUniqueOrThrow({
            where: { id: ambiguousCaptureFoundation.orderId },
            select: { status: true },
          }),
          prisma.job.count({
            where: { orderId: ambiguousCaptureFoundation.orderId },
          }),
          prisma.phaseReservationSet.count({
            where: {
              reacquisitionPaymentId: ambiguousCapturePayment.id,
              status: "HELD",
            },
          }),
          prisma.auditEvent.count({
            where: {
              paymentId: ambiguousCapturePayment.id,
              eventType: "checkout.verified_capture_staged",
            },
          }),
          prisma.outboxMessage.count({
            where: {
              aggregateId: ambiguousCapturePayment.id,
              messageType: "void_payment",
            },
          }),
        ]),
      ).resolves.toEqual([
        {
          status: "CAPTURED",
          providerIntentId: recoveredTransactionId,
          providerCaptureId: recoveredTransactionId,
          refunds: [],
        },
        { status: "CONFIRMED" },
        1,
        1,
        1,
        0,
      ]);
      const recoveredCaptureReplay = await sendPublicWebhook(recoveredCapture);
      expect(recoveredCaptureReplay.status).toBe(200);
      await expect(recoveredCaptureReplay.json()).resolves.toEqual({
        outcome: "DUPLICATE",
      });
      const recoveredCheckoutReplay = await createAmbiguousCapturePayment();
      expect(recoveredCheckoutReplay.status).toBe(200);
      await expect(recoveredCheckoutReplay.json()).resolves.toMatchObject({
        paymentId: ambiguousCapturePayment.id,
        status: "CAPTURED",
      });
      expect(providerCreateCalls).toBe(callsBeforeAmbiguity + 2);
      expect(providerCancelCalls).toBe(0);

      const staleCancelResponse = await cancelPayment(
        outageFoundation.quoteSessionId,
        outageToken,
        firstFailedPayment.id,
      );
      expect(staleCancelResponse.status).toBe(200);
      await expect(staleCancelResponse.json()).resolves.toMatchObject({
        paymentId: firstFailedPayment.id,
        status: "FAILED",
      });
      await expect(
        Promise.all([
          prisma.payment.findUniqueOrThrow({
            where: { id: ambiguousPayment.id },
            select: { status: true },
          }),
          prisma.order.findUniqueOrThrow({
            where: { id: outageFoundation.orderId },
            select: { status: true },
          }),
        ]),
      ).resolves.toEqual([{ status: "CREATED" }, { status: "QUOTED" }]);

      await expect(
        cancelPayment(
          outageFoundation.quoteSessionId,
          outageToken,
          created.paymentId,
        ),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        cancelPayment(outageFoundation.quoteSessionId, outageToken),
      ).resolves.toMatchObject({ status: 400 });
      const cancelResponse = await cancelPayment(
        outageFoundation.quoteSessionId,
        outageToken,
        ambiguousPayment.id,
      );
      expect(cancelResponse.status).toBe(200);

      const lateTransactionId = `late-${ambiguousPayment.id}`;
      const lateCapture = {
        providerEventId: `sandbox-ambiguous-capture-${ambiguousPayment.id}`,
        providerTransactionId: lateTransactionId,
        merchantReference: ambiguousPayment.merchantReference,
        status: "CAPTURED",
        amountMinor: ambiguousPayment.requestedAmountMinor.toString(),
        currency: ambiguousPayment.currency,
        occurredAt: new Date().toISOString(),
      };
      const lateCaptureResponse = await fetch(
        new URL("/payments/webhooks/sandbox", baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-taven-sandbox-signature": sandboxEventSignature(
              lateCapture,
              signingSecret,
            ),
          },
          body: JSON.stringify(lateCapture),
        },
      );
      expect(lateCaptureResponse.status).toBe(200);
      await expect(lateCaptureResponse.json()).resolves.toEqual({
        outcome: "REFUND_PENDING",
      });
      await expect(
        prisma.payment.findUniqueOrThrow({
          where: { id: ambiguousPayment.id },
          select: {
            status: true,
            providerIntentId: true,
            providerCaptureId: true,
            refunds: { select: { status: true } },
          },
        }),
      ).resolves.toEqual({
        status: "REFUND_PENDING",
        providerIntentId: null,
        providerCaptureId: lateTransactionId,
        refunds: [{ status: "PENDING" }],
      });

      const reconciledReplay = await createOutagePayment(ambiguousKey);
      expect(reconciledReplay.status).toBe(200);
      await expect(reconciledReplay.json()).resolves.toMatchObject({
        paymentId: ambiguousPayment.id,
        status: "REFUND_PENDING",
      });
      expect(providerCreateCalls).toBe(callsBeforeAmbiguity + 2);
    } finally {
      await app?.close();
      restoreEnvironment(
        "TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED",
        previousEnvironment.gate,
      );
      restoreEnvironment(
        "TAVEN_CLAIM_POLICY_REVISION",
        previousEnvironment.claimPolicyRevision,
      );
      restoreEnvironment(
        "TAVEN_TERMS_REVISION",
        previousEnvironment.termsRevision,
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
  }, 15_000);

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

  it("takes the Order fence before releasing a checkout reservation", async () => {
    const name = `release-lock-order-${randomUUID().slice(0, 8)}`;
    const setupClient = await pool.connect();
    let foundation: PersistenceFoundation;
    try {
      await setupClient.query("BEGIN");
      const fixtures = new PersistenceFactory(setupClient, `${scope}:${name}`, {
        publicTokenHash: createHash("sha256")
          .update(`${scope}:${name}:checkout-token`)
          .digest("hex"),
      });
      ({ foundation } = await preparePayment(setupClient, fixtures, name));
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }

    const cancellationClient = await pool.connect();
    const releaseClient = await pool.connect();
    const applicationName = `checkout-release-lock-${randomUUID()}`;
    try {
      await cancellationClient.query("BEGIN");
      await cancellationClient.query("SET LOCAL statement_timeout = '5s'");
      await cancellationClient.query(
        `SELECT id FROM orders WHERE id = $1 FOR UPDATE`,
        [foundation.orderId],
      );
      await releaseClient.query(
        `SELECT set_config('application_name', $1, false)`,
        [applicationName],
      );
      await releaseClient.query(`SET statement_timeout = '5s'`);
      const releaseResult = expect(
        releaseClient.query<{ released: boolean }>(
          `SELECT taven_release_checkout_phase_reservation_set(
             $1, $2
           ) AS released`,
          [foundation.paymentId, foundation.phaseReservationSetId],
        ),
      ).resolves.toMatchObject({ rows: [{ released: false }] });
      await waitForDatabaseLock(applicationName);

      const close = await cancellationClient.query<{ status: string }>(
        `SELECT taven_close_initial_checkout_payment(
           $1, 'CUSTOMER_CANCELLED'
         )::text AS status`,
        [foundation.paymentId],
      );
      expect(close.rows).toEqual([{ status: "VOIDED" }]);
      await cancellationClient.query("COMMIT");
      await releaseResult;

      expect(
        (
          await pool.query(
            `SELECT payment.status::text AS payment_status,
                    reservation_set.status::text AS set_status
             FROM payments payment
             JOIN phase_reservation_sets reservation_set
               ON reservation_set.id = $2
             WHERE payment.id = $1`,
            [foundation.paymentId, foundation.phaseReservationSetId],
          )
        ).rows,
      ).toEqual([{ payment_status: "VOIDED", set_status: "RELEASED" }]);
    } catch (error) {
      await cancellationClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      cancellationClient.release();
      releaseClient.release();
    }
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

  it("waits for a concurrent resource change and revalidates before capture", async () => {
    const name = `resource-revalidation-race-${randomUUID().slice(0, 8)}`;
    const setupClient = await pool.connect();
    let foundation: PersistenceFoundation;
    let providerIntentId: string;
    let amountMinor: string;
    let currency: string;
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
      const evidence = await eventEvidence(setupClient, foundation);
      amountMinor = evidence.amount_minor;
      currency = evidence.currency;
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }

    const resourceUpdater = await pool.connect();
    const captureClient = await pool.connect();
    const applicationName = `capture-resource-lock-${randomUUID()}`;
    try {
      await resourceUpdater.query("BEGIN");
      await resourceUpdater.query(
        `UPDATE machines SET status = 'MAINTENANCE' WHERE id = $1`,
        [foundation.machineId],
      );
      await captureClient.query(
        `SELECT set_config('application_name', $1, false)`,
        [applicationName],
      );
      await captureClient.query(`SET statement_timeout = '5s'`);
      const capturePromise = captureClient.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', $1, $2, 'PAYMENT_CAPTURED', $3, $4,
           clock_timestamp(), '{"source":"resource-race-e2e"}'::jsonb
         ) AS outcome`,
        [`${name}-capture`, providerIntentId, amountMinor, currency],
      );
      await waitForDatabaseLock(applicationName);
      await resourceUpdater.query("COMMIT");

      await expect(capturePromise).resolves.toMatchObject({
        rows: [{ outcome: "REFUND_PENDING" }],
      });
      expect(
        (
          await captureClient.query(
            `SELECT payment.status::text AS payment_status,
                    target_order.status::text AS order_status,
                    (SELECT count(*)::int FROM jobs
                     WHERE order_id = target_order.id) AS job_count,
                    (SELECT count(*)::int FROM refund_transactions
                     WHERE payment_id = payment.id) AS refund_count
             FROM payments payment
             JOIN orders target_order ON target_order.id = payment.order_id
             WHERE payment.id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          payment_status: "REFUND_PENDING",
          order_status: "CANCELLED",
          job_count: 0,
          refund_count: 1,
        },
      ]);
    } catch (error) {
      await resourceUpdater.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      resourceUpdater.release();
      captureClient.release();
    }
  });

  it("uses the refund-dispatch lock order for subsequent provider events", async () => {
    const name = `refund-lock-order-${randomUUID().slice(0, 8)}`;
    const setupClient = await pool.connect();
    let foundation: PersistenceFoundation;
    let providerIntentId: string;
    let amountMinor: string;
    let currency: string;
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
      const evidence = await eventEvidence(setupClient, foundation);
      amountMinor = evidence.amount_minor;
      currency = evidence.currency;
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }

    await pool.query(
      `SELECT taven_close_initial_checkout_payment(
         $1, 'CUSTOMER_CANCELLED'
       )`,
      [foundation.paymentId],
    );
    await pool.query(
      `SELECT taven_apply_checkout_payment_event(
         'sandbox', $1, $2, 'PAYMENT_CAPTURED', $3, $4,
         clock_timestamp(), '{}'::jsonb
       )`,
      [`${name}-capture`, providerIntentId, amountMinor, currency],
    );
    const refundId = (
      await pool.query<{ id: string }>(
        `SELECT id FROM refund_transactions WHERE payment_id = $1`,
        [foundation.paymentId],
      )
    ).rows[0]!.id;

    const orderLocker = await pool.connect();
    const eventClient = await pool.connect();
    const applicationName = `checkout-lock-${randomUUID()}`;
    try {
      await orderLocker.query("BEGIN");
      await orderLocker.query("SET LOCAL statement_timeout = '5s'");
      await orderLocker.query(
        `SELECT id FROM orders WHERE id = $1 FOR UPDATE`,
        [foundation.orderId],
      );
      await eventClient.query(
        `SELECT set_config('application_name', $1, false)`,
        [applicationName],
      );
      await eventClient.query(`SET statement_timeout = '5s'`);
      const eventResultPromise = eventClient.query<{ outcome: string }>(
        `SELECT taven_apply_checkout_payment_event(
           'sandbox', $1, $2, 'PAYMENT_PENDING', $3, $4,
           clock_timestamp(), '{}'::jsonb
         ) AS outcome`,
        [`${name}-subsequent`, providerIntentId, amountMinor, currency],
      );
      await waitForDatabaseLock(applicationName);

      const claim = await orderLocker.query<{ claimed_at: Date | null }>(
        `SELECT taven_claim_refund_dispatch($1) AS claimed_at`,
        [refundId],
      );
      expect(claim.rows[0]?.claimed_at).toBeInstanceOf(Date);
      await orderLocker.query("COMMIT");

      await expect(eventResultPromise).resolves.toMatchObject({
        rows: [{ outcome: "IGNORED_TERMINAL" }],
      });
    } catch (error) {
      await orderLocker.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      orderLocker.release();
      eventClient.release();
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
