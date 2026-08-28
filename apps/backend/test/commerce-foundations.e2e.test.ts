import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  PersistenceFactory,
  testTimes,
  type PersistenceFoundation,
  type ProductionReservationFixture,
} from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const scope = `commerce-foundations-${randomUUID()}`;
let pool: Pool;

async function rollback<T>(
  name: string,
  work: (c: PoolClient, f: PersistenceFactory) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    return await work(
      client,
      new PersistenceFactory(client, `${scope}:${name}`),
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function expectQueryError(
  client: PoolClient,
  savepoint: string,
  work: () => Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(savepoint)) {
    throw new Error(`invalid savepoint name: ${savepoint}`);
  }
  await client.query(`SAVEPOINT "${savepoint}"`);
  try {
    await expect(work()).rejects.toMatchObject(expected);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
    await client.query(`RELEASE SAVEPOINT "${savepoint}"`);
  }
}

async function createCurrentPlan(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
): Promise<
  Array<
    ProductionReservationFixture & {
      endsAt: Date;
      startsAt: Date;
    }
  >
> {
  const productions: Array<
    ProductionReservationFixture & {
      endsAt: Date;
      startsAt: Date;
    }
  > = [];
  for (const [index] of foundation.fulfilmentSlotIds.entries()) {
    const startsAt = new Date(
      testTimes.capacityStart.getTime() + index * 2 * 60 * 60 * 1_000,
    );
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1_000);
    const production = await fixtures.planProduction(
      foundation,
      `payment-plan-${foundation.orderId}-${index}`,
      { startsAt, endsAt },
      60,
      60,
      1,
      index,
    );
    productions.push({ ...production, startsAt, endsAt });
  }
  await fixtures.createResourcePlan(foundation, productions);
  await client.query(
    `UPDATE inventories SET remaining_milligrams = 1000 WHERE id = $1`,
    [foundation.inventoryId],
  );
  await fixtures.createPhaseReservationSet(foundation);
  for (const [index, production] of productions.entries()) {
    await fixtures.createProductionReservation(foundation, production);
    await client.query(
      `INSERT INTO inventory_reservations (id, node_id, production_reservation_id,
                                          inventory_id, reserved_milligrams, expires_at,
                                          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [
        production.inventoryReservationId,
        foundation.nodeId,
        production.productionReservationId,
        foundation.inventoryId,
        production.requiredMaterialMilligrams,
        testTimes.expiresAt,
        testTimes.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO capacity_reservations (id, node_id, production_reservation_id,
                                         candidate_capacity_interval_id, machine_id,
                                         starts_at, ends_at, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fixtures.id(`payment-capacity-${foundation.orderId}-${index}`),
        foundation.nodeId,
        production.productionReservationId,
        production.candidateCapacityIntervalId,
        foundation.machineId,
        production.startsAt,
        production.endsAt,
        testTimes.expiresAt,
        testTimes.createdAt,
      ],
    );
  }
  await client.query(
    `UPDATE phase_reservation_sets SET status = 'RESERVED' WHERE id = $1`,
    [foundation.phaseReservationSetId],
  );
  return productions;
}

async function createCurrentPlanAndPayment(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
): Promise<
  Array<
    ProductionReservationFixture & {
      endsAt: Date;
      startsAt: Date;
    }
  >
> {
  const productions = await createCurrentPlan(client, fixtures, foundation);
  await fixtures.finalizePayment(foundation);
  return productions;
}

async function activateCurrentPlan(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  productions: ProductionReservationFixture[],
): Promise<void> {
  for (const production of productions) {
    await client.query(
      `UPDATE inventory_reservations SET status = 'HELD'
       WHERE production_reservation_id = $1`,
      [production.productionReservationId],
    );
    await client.query(
      `UPDATE capacity_reservations SET status = 'HELD'
       WHERE production_reservation_id = $1`,
      [production.productionReservationId],
    );
    await fixtures.createJob(foundation, production);
    await client.query(
      `UPDATE production_reservations
       SET status = 'HELD', job_id = $2 WHERE id = $1`,
      [production.productionReservationId, production.jobId],
    );
  }
  await client.query(
    `UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1`,
    [foundation.phaseReservationSetId],
  );
  await fixtures.activatePayment(foundation);
  await client.query(
    `SET CONSTRAINTS
       "payments_capture_activation_reconciled",
       "orders_capture_activation_reconciled",
       "order_phases_capture_activation_reconciled",
       "phase_reservation_sets_capture_activation_reconciled",
       "jobs_captured_reservation_reconciled" IMMEDIATE`,
  );
  await client.query(
    `SET CONSTRAINTS
       "payments_capture_activation_reconciled",
       "orders_capture_activation_reconciled",
       "order_phases_capture_activation_reconciled",
       "phase_reservation_sets_capture_activation_reconciled",
       "jobs_captured_reservation_reconciled" DEFERRED`,
  );
}

async function advanceOrderToCompleted(
  client: PoolClient,
  orderId: string,
): Promise<void> {
  for (const status of [
    "IN_PRODUCTION",
    "QC_PASSED",
    "READY_TO_SHIP",
    "SHIPPED",
    "DELIVERED",
    "COMPLETED",
  ]) {
    await client.query(
      `UPDATE orders SET status = $2::order_status WHERE id = $1`,
      [orderId, status],
    );
  }
}

describe("commerce persistence foundations", () => {
  beforeAll(() => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for commerce E2E tests");
    }
    pool = new Pool({ connectionString: databaseUrl });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("builds a quoted automatic order with stable slots, binding-scoped plans, and a complete plan before payment", async () => {
    await rollback("automatic-multi-item", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "automatic-multi-item",
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        [
          { color: "red", quantity: 1 },
          {
            color: "red",
            quantity: 2,
            geometryBounds: {
              xMicrometers: 2,
              yMicrometers: 3,
              zMicrometers: 4,
            },
          },
        ],
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);

      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM automatic_order_origins
             WHERE order_id = $1 AND quote_session_id = $2`,
            [foundation.orderId, foundation.quoteSessionId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM individual_order_origins WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("0");
      const items = await client.query<{
        quantity: number;
        source_model_file_id: string;
      }>(
        `SELECT quantity, source_model_file_id
         FROM order_items WHERE order_id = $1 ORDER BY ordinal`,
        [foundation.orderId],
      );
      expect(items.rows).toEqual([
        { quantity: 1, source_model_file_id: foundation.modelFileId },
        { quantity: 2, source_model_file_id: foundation.modelFileId },
      ]);
      const itemTopology = await client.query<{
        geometries: string;
        configurations: string;
      }>(
        `SELECT count(DISTINCT model_geometry_id)::text AS geometries,
                count(DISTINCT print_config_revision_id)::text AS configurations
         FROM order_items WHERE order_id = $1`,
        [foundation.orderId],
      );
      expect(itemTopology.rows).toEqual([
        { geometries: "2", configurations: "2" },
      ]);
      expect(
        (
          await client.query(
            `SELECT quantity_ordinal
             FROM fulfilment_slots slot
             JOIN order_items item ON item.id = slot.order_item_id
             WHERE slot.order_phase_id = $1 ORDER BY item.ordinal, quantity_ordinal`,
            [foundation.orderPhaseId],
          )
        ).rows.map((row) => row.quantity_ordinal),
      ).toEqual([1, 1, 2]);
      expect(
        (
          await client.query<{
            order_item_id: string;
            phase_kind: string;
            quantity_ordinal: number;
            shipment_plan_id: string;
          }>(
            `SELECT slot.order_item_id, phase.kind::text AS phase_kind,
                    slot.quantity_ordinal, allocation.shipment_plan_id
             FROM fulfilment_slots slot
             JOIN order_items item ON item.id = slot.order_item_id
             JOIN order_phases phase ON phase.id = slot.order_phase_id
             JOIN shipment_plan_fulfilment_slots allocation
               ON allocation.fulfilment_slot_id = slot.id
              AND allocation.order_price_binding_id = $2
             WHERE slot.order_phase_id = $1
             ORDER BY item.ordinal, slot.quantity_ordinal`,
            [foundation.orderPhaseId, foundation.orderPriceBindingId],
          )
        ).rows,
      ).toEqual([
        {
          order_item_id: foundation.orderItemIds[0],
          phase_kind: "SINGLE",
          quantity_ordinal: 1,
          shipment_plan_id: foundation.shipmentPlanIds[0],
        },
        {
          order_item_id: foundation.orderItemIds[1],
          phase_kind: "SINGLE",
          quantity_ordinal: 1,
          shipment_plan_id: foundation.shipmentPlanIds[1],
        },
        {
          order_item_id: foundation.orderItemIds[1],
          phase_kind: "SINGLE",
          quantity_ordinal: 2,
          shipment_plan_id: foundation.shipmentPlanIds[1],
        },
      ]);
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM shipment_plan_fulfilment_slots
             WHERE order_price_binding_id = $1`,
            [foundation.orderPriceBindingId],
          )
        ).rows[0]?.count,
      ).toBe("3");
      expect(
        (
          await client.query(
            `SELECT count(DISTINCT delivery_destination_id)::text AS count
             FROM shipment_plans WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query<{
            address_snapshot: { country: string };
            capability_snapshot: { service: string };
            endpoint_type: string;
            provider_endpoint_id: string;
          }>(
            `SELECT provider_endpoint_id, endpoint_type,
                    address_snapshot, capability_snapshot
             FROM delivery_destinations WHERE id = $1`,
            [foundation.deliveryDestinationId],
          )
        ).rows,
      ).toEqual([
        {
          provider_endpoint_id: expect.stringMatching(/^endpoint-/),
          endpoint_type: "address",
          address_snapshot: { country: "CZ" },
          capability_snapshot: { service: "standard" },
        },
      ]);
      expect(
        (
          await client.query(
            `SELECT count(DISTINCT delivery_destination_id)::text AS count
             FROM shipments WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM price_snapshot_components
             WHERE price_snapshot_id = $1 AND kind = 'ORDER_MIN_PRINT'`,
            [foundation.priceSnapshotId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM price_snapshot_components
             WHERE price_snapshot_id = $1 AND kind = 'ORDER_SMALL_SURCHARGE'`,
            [foundation.priceSnapshotId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count FROM payments WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count FROM jobs WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("0");
    });
  });

  it("reconciles immutable price components and freezes automatic commerce after payment intent creation", async () => {
    await rollback("immutable-pricing", async (client, fixtures) => {
      const boundDraft = await fixtures.createFoundation(
        "bound-draft-pricing",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      const boundDraftMutationError = {
        code: "23514",
        constraint: "order_item_price_binding_immutable_check",
      };
      await expectQueryError(
        client,
        "bound_draft_order_item_insert",
        () =>
          client.query(
            `INSERT INTO order_items (id, order_id, ordinal, source_model_file_id,
                                     model_geometry_id, print_config_revision_id,
                                     material, color, quantity, created_at)
             VALUES ($1,$2,99,$3,$4,$5,'PLA','green',1,$6)`,
            [
              fixtures.id("bound-draft-late-item"),
              boundDraft.orderId,
              boundDraft.modelFileId,
              boundDraft.modelGeometryId,
              boundDraft.printConfigRevisionId,
              new Date(),
            ],
          ),
        boundDraftMutationError,
      );
      await expectQueryError(
        client,
        "bound_draft_order_item_update",
        () =>
          client.query(`UPDATE order_items SET color = 'green' WHERE id = $1`, [
            boundDraft.orderItemId,
          ]),
        boundDraftMutationError,
      );
      await expectQueryError(
        client,
        "bound_draft_order_item_delete",
        () =>
          client.query(`DELETE FROM order_items WHERE id = $1`, [
            boundDraft.orderItemId,
          ]),
        boundDraftMutationError,
      );

      const foundation = await fixtures.createFoundation("immutable-pricing");
      await expectQueryError(
        client,
        "quoted_order_item_insert",
        () =>
          client.query(
            `INSERT INTO order_items (id, order_id, ordinal, source_model_file_id,
                                     model_geometry_id, print_config_revision_id,
                                     material, color, quantity, created_at)
             VALUES ($1,$2,99,$3,$4,$5,'PLA','green',1,$6)`,
            [
              fixtures.id("late-order-item"),
              foundation.orderId,
              foundation.modelFileId,
              foundation.modelGeometryId,
              foundation.printConfigRevisionId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "order_item_price_binding_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "quoted_fulfilment_slot_insert",
        () =>
          client.query(
            `INSERT INTO fulfilment_slots (id, order_id, order_phase_id, order_item_id,
                                           quantity_ordinal, settlement_amount_minor,
                                           created_at, updated_at)
             VALUES ($1,$2,$3,$4,2,0,$5,$5)`,
            [
              fixtures.id("late-quoted-slot"),
              foundation.orderId,
              foundation.orderPhaseId,
              foundation.orderItemId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "fulfilment_slot_topology_immutable_check",
        },
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);
      await expectQueryError(
        client,
        "paid_fulfilment_slot_insert",
        () =>
          client.query(
            `INSERT INTO fulfilment_slots (id, order_id, order_phase_id, order_item_id,
                                           quantity_ordinal, settlement_amount_minor,
                                           created_at, updated_at)
             VALUES ($1,$2,$3,$4,2,0,$5,$5)`,
            [
              fixtures.id("late-paid-slot"),
              foundation.orderId,
              foundation.orderPhaseId,
              foundation.orderItemId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "fulfilment_slot_topology_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "paid_shipment_plan_insert",
        () =>
          client.query(
            `INSERT INTO shipment_plans (id, order_id, order_phase_id,
                                        price_snapshot_id, order_price_binding_id,
                                        delivery_destination_id, ordinal, category,
                                        planned_volume_cubic_mm,
                                        planned_weight_milligrams,
                                        shipping_amount_minor, packaging_amount_minor,
                                        handling_amount_minor, allocation_snapshot, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,99,'standard',1,1,0,0,0,'{}'::jsonb,$7)`,
            [
              fixtures.id("late-paid-shipment-plan"),
              foundation.orderId,
              foundation.orderPhaseId,
              foundation.priceSnapshotId,
              foundation.orderPriceBindingId,
              foundation.deliveryDestinationId,
              new Date(),
            ],
          ),
        { code: "23514", constraint: "shipment_plan_payment_guard" },
      );
      await expectQueryError(
        client,
        "restore_paid_order_draft",
        () =>
          client.query(`UPDATE orders SET status = 'DRAFT' WHERE id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );
      expect(
        (
          await client.query<{ kind: string; scope: string }>(
            `SELECT kind::text, scope::text
             FROM price_snapshot_components
             WHERE price_snapshot_id = $1 ORDER BY kind`,
            [foundation.priceSnapshotId],
          )
        ).rows,
      ).toEqual([
        { kind: "ITEM_POSTPROCESSING", scope: "ORDER_ITEM" },
        { kind: "ITEM_PRODUCTION", scope: "ORDER_ITEM" },
        { kind: "ITEM_QUANTITY", scope: "ORDER_ITEM" },
        { kind: "ORDER_MIN_PRINT", scope: "ORDER" },
        { kind: "ORDER_SMALL_SURCHARGE", scope: "ORDER" },
        { kind: "SHIPMENT", scope: "SHIPMENT_PLAN" },
      ]);
      await expectQueryError(
        client,
        "immutable_snapshot",
        () =>
          client.query(
            `UPDATE price_snapshots SET contract_total_minor = 999 WHERE id = $1`,
            [foundation.priceSnapshotId],
          ),
        { code: "23514" },
      );
      await expectQueryError(
        client,
        "immutable_schedule",
        () =>
          client.query(
            `UPDATE payment_schedules SET gross_amount_minor = 999 WHERE id = $1`,
            [foundation.paymentScheduleId],
          ),
        { code: "23514" },
      );
      await expectQueryError(
        client,
        "immutable_audit",
        () =>
          client.query(`DELETE FROM audit_events WHERE order_id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514" },
      );
      await expectQueryError(
        client,
        "immutable_destination",
        () =>
          client.query(
            `UPDATE delivery_destinations
             SET capability_snapshot = '{"service":"express"}'::jsonb
             WHERE id = $1`,
            [foundation.deliveryDestinationId],
          ),
        { code: "23514" },
      );
      await expectQueryError(
        client,
        "immutable_order_item",
        () =>
          client.query(`UPDATE order_items SET color = 'green' WHERE id = $1`, [
            foundation.orderItemId,
          ]),
        {
          code: "23514",
          constraint: "order_item_price_binding_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "stable_slot",
        () =>
          client.query(
            `UPDATE fulfilment_slots SET settlement_amount_minor = 1 WHERE id = $1`,
            [foundation.fulfilmentSlotId],
          ),
        {
          code: "23514",
          constraint: "fulfilment_slot_settlement_payment_guard",
        },
      );
    });
  });

  it("serializes binding invalidation and active moves with payment insertion", async () => {
    const setup = await pool.connect();
    const paying = await pool.connect();
    const mutating = await pool.connect();
    try {
      const fixtures = new PersistenceFactory(
        setup,
        `${scope}:binding-payment-concurrency`,
      );
      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "binding-payment-concurrency",
      );
      await createCurrentPlan(setup, fixtures, foundation);
      const replacementSnapshotId = fixtures.id(
        "binding-payment-concurrency:replacement-snapshot",
      );
      const replacementBindingId = fixtures.id(
        "binding-payment-concurrency:replacement-binding",
      );
      const replacementSnapshotHash = randomUUID()
        .replaceAll("-", "")
        .repeat(2);
      await setup.query(
        `INSERT INTO price_snapshots
           (id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,'EUR',0,'concurrency-v0','{}'::jsonb,$2,$3)`,
        [replacementSnapshotId, replacementSnapshotHash, new Date()],
      );
      await setup.query(
        `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [
          fixtures.id("binding-payment-concurrency:replacement-schedule"),
          replacementSnapshotId,
          new Date(),
        ],
      );
      await setup.query(
        `INSERT INTO order_price_bindings
           (id, order_id, price_snapshot_id, delivery_destination_id, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          replacementBindingId,
          foundation.orderId,
          replacementSnapshotId,
          foundation.deliveryDestinationId,
          new Date(),
        ],
      );
      await setup.query("COMMIT");

      const payingFixtures = new PersistenceFactory(
        paying,
        `${scope}:binding-payment-concurrency`,
      );
      await paying.query("BEGIN");
      await payingFixtures.finalizePayment(foundation);

      await mutating.query("BEGIN");
      await mutating.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        mutating.query(
          `UPDATE order_price_bindings SET invalidated_at = $2 WHERE id = $1`,
          [foundation.orderPriceBindingId, new Date()],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await mutating.query("ROLLBACK");

      await mutating.query("BEGIN");
      await mutating.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        mutating.query(
          `UPDATE order_active_price_bindings
           SET order_price_binding_id = $2 WHERE order_id = $1`,
          [foundation.orderId, replacementBindingId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await mutating.query("ROLLBACK");
      await paying.query("COMMIT");

      await setup.query("BEGIN");
      await expect(
        setup.query(
          `UPDATE order_price_bindings SET invalidated_at = $2 WHERE id = $1`,
          [foundation.orderPriceBindingId, new Date()],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "order_price_binding_payment_guard",
      });
      await setup.query("ROLLBACK");

      await setup.query("BEGIN");
      await expect(
        setup.query(
          `UPDATE order_active_price_bindings
           SET order_price_binding_id = $2 WHERE order_id = $1`,
          [foundation.orderId, replacementBindingId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "active_order_price_binding_payment_guard",
      });
      await setup.query("ROLLBACK");
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await paying.query("ROLLBACK").catch(() => undefined);
      await mutating.query("ROLLBACK").catch(() => undefined);
      setup.release();
      paying.release();
      mutating.release();
    }
  });

  it("binds item reference slices to their exact geometry and print configuration", async () => {
    await rollback("reference-slice-inputs", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "reference-slice-inputs",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [
          {
            geometryBounds: {
              xMicrometers: 1,
              yMicrometers: 2,
              zMicrometers: 3,
            },
          },
          {
            geometryBounds: {
              xMicrometers: 4,
              yMicrometers: 5,
              zMicrometers: 6,
            },
          },
        ],
        "DRAFT",
      );
      const matchingReferenceId = fixtures.id("matching-reference");
      const wrongGeometryReferenceId = fixtures.id("wrong-geometry-reference");
      const wrongConfigReferenceId = fixtures.id("wrong-config-reference");
      const referenceInputs = [
        {
          id: matchingReferenceId,
          geometryId: foundation.modelGeometryIds[0]!,
          configId: foundation.printConfigRevisionIds[0]!,
          name: "matching",
        },
        {
          id: wrongGeometryReferenceId,
          geometryId: foundation.modelGeometryIds[1]!,
          configId: foundation.printConfigRevisionIds[0]!,
          name: "wrong-geometry",
        },
        {
          id: wrongConfigReferenceId,
          geometryId: foundation.modelGeometryIds[0]!,
          configId: foundation.printConfigRevisionIds[1]!,
          name: "wrong-config",
        },
      ];
      for (const reference of referenceInputs) {
        await client.query(
          `INSERT INTO slice_results (id, kind, cache_key, model_geometry_id,
                                     print_config_revision_id, reference_profile_id,
                                     parts_per_plate, artifact_object_key, artifact_hash,
                                     estimated_print_seconds, estimated_material_milligrams,
                                     slicer_engine, slicer_version, created_at)
           SELECT $1, 'REFERENCE', $2, $3, $4, profile.reference_profile_id,
                  production.parts_per_plate, $5, production.artifact_hash,
                  production.estimated_print_seconds,
                  production.estimated_material_milligrams,
                  reference_profile.slicer_engine,
                  reference_profile.slicer_version, $6
           FROM slice_results production
           JOIN machine_profiles profile ON profile.id = production.machine_profile_id
           JOIN reference_profiles reference_profile
             ON reference_profile.id = profile.reference_profile_id
           WHERE production.id = $7`,
          [
            reference.id,
            `reference-${reference.name}-${reference.id}`,
            reference.geometryId,
            reference.configId,
            `reference/${reference.name}/${reference.id}`,
            new Date(),
            foundation.sliceResultId,
          ],
        );
      }

      const mutableQuoteRequestId = fixtures.id(
        "reference-inputs:quote-request",
      );
      const mutableQuoteId = fixtures.id("reference-inputs:quote");
      const quoteCreatedAt = new Date();
      await client.query(
        `INSERT INTO quote_requests
           (id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,'QUOTED',$3,$3)`,
        [mutableQuoteRequestId, foundation.customerId, quoteCreatedAt],
      );
      await client.query(
        `INSERT INTO quotes
           (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          mutableQuoteId,
          mutableQuoteRequestId,
          foundation.customerId,
          new Date(quoteCreatedAt.getTime() + 60 * 60 * 1_000),
          quoteCreatedAt,
        ],
      );
      const mutableOrderId = fixtures.id("reference-inputs:order");
      const mutableQuoteSessionId = fixtures.id(
        "reference-inputs:quote-session",
      );
      await client.query(
        `INSERT INTO quote_sessions
           (id, customer_id, public_token_hash, expires_at,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          mutableQuoteSessionId,
          foundation.customerId,
          "e".repeat(64),
          new Date(quoteCreatedAt.getTime() + 60 * 60 * 1_000),
          quoteCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO orders
           (id, customer_id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
        [
          mutableOrderId,
          foundation.customerId,
          `R-${randomUUID()}`,
          quoteCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO automatic_order_origins (order_id, quote_session_id)
         VALUES ($1,$2)`,
        [mutableOrderId, mutableQuoteSessionId],
      );

      for (const table of ["quote_items", "order_items"] as const) {
        const parentColumn = table === "quote_items" ? "quote_id" : "order_id";
        const parentId =
          table === "quote_items" ? mutableQuoteId : mutableOrderId;
        const constraint =
          table === "quote_items"
            ? "quote_item_reference_slice_input_check"
            : "order_item_reference_slice_input_check";
        const insertItem = (
          id: string,
          ordinal: number,
          referenceSliceId: string,
          geometryId = foundation.modelGeometryIds[0]!,
          configId = foundation.printConfigRevisionIds[0]!,
        ) =>
          client.query(
            `INSERT INTO ${table} (id, ${parentColumn}, ordinal,
                                  source_model_file_id, model_geometry_id,
                                  print_config_revision_id, reference_slice_result_id,
                                  material, color, quantity, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'PLA','black',1,$8)`,
            [
              id,
              parentId,
              ordinal,
              foundation.modelFileId,
              geometryId,
              configId,
              referenceSliceId,
              new Date(),
            ],
          );

        await expect(
          insertItem(
            fixtures.id(`${table}:matching-reference-item`),
            2,
            matchingReferenceId,
          ),
        ).resolves.toBeDefined();
        await expectQueryError(
          client,
          `${table}_production_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:production-reference-item`),
              3,
              foundation.sliceResultId,
            ),
          { code: "23514", constraint },
        );
        await expectQueryError(
          client,
          `${table}_wrong_geometry_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:wrong-geometry-reference-item`),
              4,
              wrongGeometryReferenceId,
            ),
          { code: "23514", constraint },
        );
        await expectQueryError(
          client,
          `${table}_wrong_config_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:wrong-config-reference-item`),
              5,
              wrongConfigReferenceId,
            ),
          { code: "23514", constraint },
        );
        if (table === "order_items") {
          await expectQueryError(
            client,
            "order_item_reference_update_bypass",
            () =>
              client.query(
                `UPDATE order_items
                 SET reference_slice_result_id = $2
                 WHERE id = $1`,
                [
                  fixtures.id(`${table}:matching-reference-item`),
                  foundation.sliceResultId,
                ],
              ),
            { code: "23514", constraint },
          );
        }
      }
    });
  });

  it("revalidates source availability when a draft item selects another geometry", async () => {
    await rollback("draft-item-source-update", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "draft-item-source-update",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      const mutableSessionId = fixtures.id("source-update:quote-session");
      const mutableOrderId = fixtures.id("source-update:order");
      const mutableItemId = fixtures.id("source-update:item");
      const mutableCreatedAt = new Date();
      await client.query(
        `INSERT INTO quote_sessions
           (id, customer_id, public_token_hash, expires_at,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          mutableSessionId,
          foundation.customerId,
          "a".repeat(64),
          new Date(mutableCreatedAt.getTime() + 60 * 60 * 1_000),
          mutableCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO orders
           (id, customer_id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
        [
          mutableOrderId,
          foundation.customerId,
          `S-${randomUUID()}`,
          mutableCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO automatic_order_origins (order_id, quote_session_id)
         VALUES ($1,$2)`,
        [mutableOrderId, mutableSessionId],
      );
      await client.query(
        `INSERT INTO order_items
           (id, order_id, ordinal, source_model_file_id, model_geometry_id,
            print_config_revision_id, material, color, quantity, created_at)
         VALUES ($1,$2,0,$3,$4,$5,'PLA','red',1,$6)`,
        [
          mutableItemId,
          mutableOrderId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          mutableCreatedAt,
        ],
      );
      const expiredSourceId = fixtures.id("expired-update-source");
      const expiredGeometryId = fixtures.id("expired-update-geometry");
      const uploadedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
      const deleteAfter = new Date(Date.now() - 24 * 60 * 60 * 1_000);
      await client.query(
        `INSERT INTO model_files (id, format, original_filename,
                                 storage_object_key, content_hash, size_bytes,
                                 uploaded_at, source_delete_after, retention_hold)
         VALUES ($1,'STL','expired.stl',$2,$3,1,$4,$5,'ACTIVE_ORDER')`,
        [
          expiredSourceId,
          `models/${expiredSourceId}.stl`,
          "f".repeat(64),
          uploadedAt,
          deleteAfter,
        ],
      );
      await client.query(
        `INSERT INTO model_geometries
           (id, source_model_file_id, canonical_object_key, geometry_hash,
            canonicalizer_revision, volume_cubic_micrometers,
            bounds_x_micrometers, bounds_y_micrometers,
            bounds_z_micrometers, triangle_count)
         VALUES ($1,$2,$3,$4,'test',1,1,1,1,1)`,
        [
          expiredGeometryId,
          expiredSourceId,
          `canonical/${expiredGeometryId}`,
          "e".repeat(64),
        ],
      );
      await client.query(
        `UPDATE model_files SET retention_hold = 'NONE' WHERE id = $1`,
        [expiredSourceId],
      );
      const selectExpiredSource = () =>
        client.query(
          `UPDATE order_items
           SET source_model_file_id = $2, model_geometry_id = $3
           WHERE id = $1`,
          [mutableItemId, expiredSourceId, expiredGeometryId],
        );
      await expectQueryError(
        client,
        "expired_geometry_update_bypass",
        selectExpiredSource,
        {
          code: "23514",
          constraint: "model_geometry_source_available_check",
        },
      );
      await client.query(
        `UPDATE model_files SET deleted_at = now() WHERE id = $1`,
        [expiredSourceId],
      );
      await expectQueryError(
        client,
        "deleted_geometry_update_bypass",
        selectExpiredSource,
        {
          code: "23514",
          constraint: "model_geometry_source_available_check",
        },
      );
    });
  });

  it("binds every planned slot to compatible candidate inputs and quantity", async () => {
    await rollback("planned-slot-inputs", async (client, fixtures) => {
      const crossItem = await fixtures.createFoundation(
        "cross-item-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [
          {
            geometryBounds: {
              xMicrometers: 1,
              yMicrometers: 1,
              zMicrometers: 1,
            },
          },
          {
            geometryBounds: {
              xMicrometers: 2,
              yMicrometers: 2,
              zMicrometers: 2,
            },
          },
        ],
      );
      const crossItemProduction = await fixtures.planProduction(
        crossItem,
        "cross-item-candidate",
      );
      await expectQueryError(
        client,
        "cross_item_candidate_slot",
        () =>
          fixtures.createResourcePlan(crossItem, [
            {
              ...crossItemProduction,
              fulfilmentSlotId: crossItem.fulfilmentSlotIds[1]!,
            },
          ]),
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_input_check",
        },
      );

      const wrongColor = await fixtures.createFoundation(
        "wrong-color-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ color: "white" }],
      );
      await client.query(
        `UPDATE inventories SET color = 'black' WHERE id = $1`,
        [wrongColor.inventoryId],
      );
      const wrongColorProduction = await fixtures.planProduction(
        wrongColor,
        "wrong-color-candidate",
      );
      await expectQueryError(
        client,
        "wrong_color_candidate_slot",
        () => fixtures.createResourcePlan(wrongColor, [wrongColorProduction]),
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_input_check",
        },
      );

      const missingInventoryColor = await fixtures.createFoundation(
        "missing-inventory-color-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ color: "white" }],
      );
      await client.query(`UPDATE inventories SET color = NULL WHERE id = $1`, [
        missingInventoryColor.inventoryId,
      ]);
      const missingInventoryColorProduction = await fixtures.planProduction(
        missingInventoryColor,
        "missing-inventory-color-candidate",
      );
      await expectQueryError(
        client,
        "missing_inventory_color_candidate_slot",
        () =>
          fixtures.createResourcePlan(missingInventoryColor, [
            missingInventoryColorProduction,
          ]),
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_input_check",
        },
      );

      const underfilled = await fixtures.createFoundation(
        "underfilled-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ quantity: 2 }],
      );
      const underfilledProduction = await fixtures.planProduction(
        underfilled,
        "underfilled-candidate",
        undefined,
        120,
        120,
        2,
      );
      await expectQueryError(
        client,
        "underfilled_candidate_quantity",
        async () => {
          await fixtures.createResourcePlan(underfilled, [
            underfilledProduction,
          ]);
          await client.query(
            `SET CONSTRAINTS "phase_resource_plan_jobs_candidate_quantity_reconciled",
                             "phase_resource_plan_slots_candidate_quantity_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_quantity_check",
        },
      );

      const overfilled = await fixtures.createFoundation(
        "overfilled-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ quantity: 2 }],
      );
      const overfilledProduction = await fixtures.planProduction(
        overfilled,
        "overfilled-candidate",
      );
      await expectQueryError(
        client,
        "overfilled_candidate_quantity",
        async () => {
          await fixtures.createResourcePlan(overfilled, [overfilledProduction]);
          await client.query(
            `INSERT INTO phase_resource_plan_slots
               (id, node_id, phase_resource_plan_id,
                phase_resource_plan_job_id, fulfilment_slot_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              fixtures.id("overfilled-candidate:extra-plan-slot"),
              overfilled.nodeId,
              overfilled.phaseResourcePlanId,
              overfilledProduction.phaseResourcePlanJobId,
              overfilled.fulfilmentSlotIds[1],
            ],
          );
          await client.query(
            `SET CONSTRAINTS "phase_resource_plan_jobs_candidate_quantity_reconciled",
                             "phase_resource_plan_slots_candidate_quantity_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_quantity_check",
        },
      );

      const mixedItems = await fixtures.createFoundation(
        "mixed-item-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{}, {}],
        "DRAFT",
        async (draftFoundation) => {
          await client.query(
            `UPDATE order_items
             SET source_model_file_id = $2, model_geometry_id = $3,
                 print_config_revision_id = $4
             WHERE id = $1`,
            [
              draftFoundation.orderItemIds[1],
              draftFoundation.modelFileId,
              draftFoundation.modelGeometryId,
              draftFoundation.printConfigRevisionId,
            ],
          );
        },
      );
      const secondItemId = mixedItems.orderItemIds[1];
      if (!secondItemId) {
        throw new Error("mixed-item fixture is missing its second item");
      }
      const secondSlotId = fixtures.id("mixed-item-candidate:second-slot");
      await client.query(
        `INSERT INTO fulfilment_slots
           (id, order_id, order_phase_id, order_item_id, quantity_ordinal,
            settlement_amount_minor, created_at, updated_at)
         VALUES ($1,$2,$3,$4,2,0,$5,$5)`,
        [
          secondSlotId,
          mixedItems.orderId,
          mixedItems.orderPhaseId,
          secondItemId,
          new Date(),
        ],
      );
      await client.query(
        `INSERT INTO shipment_plan_fulfilment_slots
           (shipment_plan_id, order_price_binding_id, fulfilment_slot_id)
         VALUES ($1,$2,$3)`,
        [
          mixedItems.shipmentPlanId,
          mixedItems.orderPriceBindingId,
          secondSlotId,
        ],
      );
      const mixedItemProduction = await fixtures.planProduction(
        mixedItems,
        "mixed-item-candidate",
        undefined,
        120,
        120,
        2,
      );
      await expectQueryError(
        client,
        "mixed_item_candidate_membership",
        async () => {
          await fixtures.createResourcePlan(mixedItems, [mixedItemProduction]);
          await client.query(
            `INSERT INTO phase_resource_plan_slots
               (id, node_id, phase_resource_plan_id,
                phase_resource_plan_job_id, fulfilment_slot_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              fixtures.id("mixed-item-candidate:second-plan-slot"),
              mixedItems.nodeId,
              mixedItems.phaseResourcePlanId,
              mixedItemProduction.phaseResourcePlanJobId,
              secondSlotId,
            ],
          );
          await client.query(
            `SET CONSTRAINTS "phase_resource_plan_jobs_candidate_quantity_reconciled",
                             "phase_resource_plan_slots_candidate_quantity_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_item_check",
        },
      );
    });
  });

  it("allows a payment schedule retry only after a failed attempt", async () => {
    await rollback("payment-schedule-retry", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "payment-schedule-retry",
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);

      const insertRetry = (id: string, providerIntentId: string) =>
        client.query(
          `INSERT INTO payments
             (id, order_id, price_snapshot_id, order_price_binding_id,
              payment_schedule_id, role, provider, provider_intent_id,
              requested_amount_minor, currency, status, created_at, updated_at)
           SELECT $1, order_id, price_snapshot_id, order_price_binding_id,
                  payment_schedule_id, role, provider, $2,
                  requested_amount_minor, currency, 'PENDING', $3, $3
           FROM payments WHERE id = $4`,
          [id, providerIntentId, new Date(), foundation.paymentId],
        );

      await expectQueryError(
        client,
        "concurrent_payment_schedule_attempt",
        () =>
          insertRetry(
            fixtures.id("concurrent-payment-attempt"),
            "concurrent-provider-intent",
          ),
        {
          code: "23505",
          constraint: "payments_one_nonfailed_attempt_per_schedule_key",
        },
      );

      await client.query(
        `UPDATE payments SET status = 'FAILED' WHERE id = $1`,
        [foundation.paymentId],
      );
      const retryPaymentId = fixtures.id("failed-payment-retry");
      await expect(
        insertRetry(retryPaymentId, "failed-provider-intent-retry"),
      ).resolves.toBeDefined();

      await client.query(
        `UPDATE payments SET status = 'VOIDED' WHERE id = $1`,
        [retryPaymentId],
      );
      await expectQueryError(
        client,
        "voided_payment_schedule_attempt",
        () =>
          insertRetry(
            fixtures.id("voided-payment-retry"),
            "voided-provider-intent-retry",
          ),
        {
          code: "23505",
          constraint: "payments_one_nonfailed_attempt_per_schedule_key",
        },
      );
    });
  });

  it("persists a pending compensation capture directly as refund pending", async () => {
    await rollback("pending-capture-compensation", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "pending-capture-compensation",
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);
      const capturedAt = new Date();
      const captureCutoffAt = new Date(capturedAt.getTime() - 1);
      await client.query(
        `UPDATE payments
         SET status = 'REFUND_PENDING',
             captured_amount_minor = requested_amount_minor,
             provider_capture_id = $2, captured_at = $3,
             capture_authorized = false, capture_cutoff_at = $4
         WHERE id = $1`,
        [
          foundation.paymentId,
          "late-provider-capture",
          capturedAt,
          captureCutoffAt,
        ],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{
            capture_matches_request: boolean;
            captured_at: Date;
            provider_capture_id: string;
            status: string;
          }>(
            `SELECT status::text,
                    captured_amount_minor = requested_amount_minor
                      AS capture_matches_request,
                    provider_capture_id, captured_at
             FROM payments WHERE id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "REFUND_PENDING",
          capture_matches_request: true,
          provider_capture_id: "late-provider-capture",
          captured_at: capturedAt,
        },
      ]);
    });
  });

  it("rejects ordinary capture after its authorization window closes", async () => {
    await rollback("closed-capture-window", async (client, fixtures) => {
      const capturePayment = async (
        foundation: PersistenceFoundation,
        providerCaptureId: string,
      ): Promise<void> => {
        await client.query(
          `UPDATE payments
           SET status = 'CAPTURED',
               captured_amount_minor = requested_amount_minor,
               provider_capture_id = $2, captured_at = $3
           WHERE id = $1`,
          [foundation.paymentId, providerCaptureId, new Date()],
        );
      };

      const unauthorized = await fixtures.createFoundation(
        "unauthorized-capture",
      );
      await createCurrentPlanAndPayment(client, fixtures, unauthorized);
      await expectQueryError(
        client,
        "cutoff_without_closing_authorization",
        () =>
          client.query(
            `UPDATE payments SET capture_cutoff_at = $2 WHERE id = $1`,
            [unauthorized.paymentId, new Date()],
          ),
        { code: "23514", constraint: "payment_capture_window_check" },
      );
      await client.query(
        `UPDATE payments SET capture_authorized = false WHERE id = $1`,
        [unauthorized.paymentId],
      );
      await expectQueryError(
        client,
        "capture_without_authorization",
        () => capturePayment(unauthorized, "unauthorized-capture"),
        { code: "23514", constraint: "payment_capture_window_check" },
      );

      const expired = await fixtures.createFoundation("expired-capture");
      await createCurrentPlanAndPayment(client, fixtures, expired);
      await client.query(
        `UPDATE payments
         SET capture_authorized = false, capture_cutoff_at = $2
         WHERE id = $1`,
        [expired.paymentId, new Date(Date.now() - 1_000)],
      );
      await expectQueryError(
        client,
        "capture_after_cutoff",
        () => capturePayment(expired, "expired-capture"),
        { code: "23514", constraint: "payment_capture_window_check" },
      );
    });
  });

  it("requires a captured held production reservation for every job", async () => {
    await rollback("uncaptured-production-job", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "uncaptured-production-job",
      );
      const production = await fixtures.planProduction(
        foundation,
        "uncaptured-production-job",
      );
      await fixtures.createResourcePlan(foundation, [production]);
      await fixtures.createPhaseReservationSet(foundation);
      await fixtures.createProductionReservation(foundation, production);
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
          testTimes.expiresAt,
          testTimes.createdAt,
        ],
      );
      const capacityReservationId = fixtures.id(
        "uncaptured-production-job:capacity",
      );
      await client.query(
        `INSERT INTO capacity_reservations
           (id, node_id, production_reservation_id,
            candidate_capacity_interval_id, machine_id,
            starts_at, ends_at, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [
          capacityReservationId,
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          testTimes.capacityStart,
          testTimes.capacityEnd,
          testTimes.expiresAt,
          testTimes.createdAt,
        ],
      );
      await client.query(
        `UPDATE phase_reservation_sets SET status = 'RESERVED' WHERE id = $1`,
        [foundation.phaseReservationSetId],
      );
      await fixtures.finalizePayment(foundation);
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await client.query(`SET CONSTRAINTS ALL DEFERRED`);

      await expectQueryError(
        client,
        "capture_without_activation",
        async () => {
          await fixtures.capturePayment(foundation);
          await client.query(
            `SET CONSTRAINTS "payments_capture_activation_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_capture_activation_check",
        },
      );

      const holdReservationAndCreateJob = async (): Promise<void> => {
        await client.query(
          `UPDATE inventory_reservations SET status = 'HELD' WHERE id = $1`,
          [production.inventoryReservationId],
        );
        await client.query(
          `UPDATE capacity_reservations SET status = 'HELD' WHERE id = $1`,
          [capacityReservationId],
        );
        await fixtures.createJob(foundation, production);
        await client.query(
          `UPDATE production_reservations
           SET status = 'HELD', job_id = $2 WHERE id = $1`,
          [production.productionReservationId, production.jobId],
        );
        await client.query(
          `UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1`,
          [foundation.phaseReservationSetId],
        );
      };

      await expectQueryError(
        client,
        "uncaptured_production_job",
        async () => {
          await holdReservationAndCreateJob();
          await client.query(
            `SET CONSTRAINTS "jobs_captured_reservation_reconciled" IMMEDIATE`,
          );
        },
        { code: "23514", constraint: "job_capture_reconciliation_check" },
      );

      await holdReservationAndCreateJob();
      await fixtures.activatePayment(foundation);
      await expect(
        client.query(
          `SET CONSTRAINTS
             "payments_capture_activation_reconciled",
             "orders_capture_activation_reconciled",
             "order_phases_capture_activation_reconciled",
             "phase_reservation_sets_capture_activation_reconciled",
             "jobs_captured_reservation_reconciled" IMMEDIATE`,
        ),
      ).resolves.toBeDefined();
    });
  });

  it("requires scoped payment topology and retains provider/refund identities", async () => {
    await rollback("scoped-identities", async (client, fixtures) => {
      await expectQueryError(
        client,
        "terminal_order_insert",
        () =>
          client.query(
            `INSERT INTO orders
             (id, public_reference, status, created_at, updated_at)
             VALUES ($1,$2,'COMPLETED',$3,$3)`,
            [
              fixtures.id("terminal-order-insert"),
              "terminal-order-insert",
              new Date(),
            ],
          ),
        { code: "23514", constraint: "order_status_transition_check" },
      );
      const foundation = await fixtures.createFoundation(
        "scoped-identities",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      await client.query(
        `UPDATE reference_profiles
         SET state = 'RETIRED', retired_at = $1
         WHERE material = 'PLA' AND quality = 'STANDARD' AND state = 'ACTIVE'`,
        [new Date()],
      );
      const other = await fixtures.createFoundation("other");
      await expectQueryError(
        client,
        "skip_draft_lifecycle",
        () =>
          client.query(`UPDATE orders SET status = 'COMPLETED' WHERE id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );
      await expectQueryError(
        client,
        "draft_order_payment",
        () => createCurrentPlanAndPayment(client, fixtures, foundation),
        { code: "23514", constraint: "payment_fulfilment_topology_check" },
      );
      await client.query(
        `UPDATE orders SET status = 'QUOTED', quoted_at = $2 WHERE id = $1`,
        [foundation.orderId, new Date()],
      );
      await expectQueryError(
        client,
        "skip_quoted_lifecycle",
        () =>
          client.query(`UPDATE orders SET status = 'SHIPPED' WHERE id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );
      const foundationProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await createCurrentPlanAndPayment(client, fixtures, other);
      await expectQueryError(
        client,
        "captured_payment_insert",
        () =>
          client.query(
            `INSERT INTO payments (id, order_id, price_snapshot_id, order_price_binding_id,
                                  payment_schedule_id, role, provider, provider_intent_id,
                                  provider_capture_id, requested_amount_minor,
                                  captured_amount_minor, currency, status, captured_at,
                                  created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'FULL','test',$6,$7,950,950,'EUR','CAPTURED',$8,$8,$8)`,
            [
              fixtures.id("direct-captured-payment"),
              foundation.orderId,
              foundation.priceSnapshotId,
              foundation.orderPriceBindingId,
              foundation.paymentScheduleId,
              "direct-captured-intent",
              "direct-captured-capture",
              new Date(),
            ],
          ),
        { code: "23514", constraint: "payment_initial_status_check" },
      );
      await expectQueryError(
        client,
        "audit_order_payment_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, order_id, payment_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'payment.scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-order-payment-mismatch"),
              foundation.orderId,
              other.paymentId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await expectQueryError(
        client,
        "cross_order_shipment",
        () =>
          client.query(
            `INSERT INTO shipments (id, order_id, order_phase_id, shipment_plan_id,
                                   delivery_destination_id, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$6)`,
            [
              fixtures.id("bad-shipment"),
              foundation.orderId,
              foundation.orderPhaseId,
              other.shipmentPlanId,
              foundation.deliveryDestinationId,
              new Date(),
            ],
          ),
        { code: "23503" },
      );
      await expectQueryError(
        client,
        "cross_order_payment",
        () =>
          client.query(
            `INSERT INTO payments (id, order_id, price_snapshot_id, order_price_binding_id,
                                  payment_schedule_id, role, provider, requested_amount_minor,
                                  currency, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'FULL','test',950,'EUR',$6,$6)`,
            [
              fixtures.id("cross-order-payment"),
              foundation.orderId,
              other.priceSnapshotId,
              other.orderPriceBindingId,
              other.paymentScheduleId,
              new Date(),
            ],
          ),
        { code: "23514", constraint: "payment_fulfilment_topology_check" },
      );
      await expectQueryError(
        client,
        "zero_refund",
        () =>
          client.query(
            `INSERT INTO refund_transactions (id, payment_id, idempotency_key,
                                               amount_minor, reason, created_at, updated_at)
             VALUES ($1,$2,$3,0,'CUSTOMER_CANCELLATION',$4,$4)`,
            [
              fixtures.id("refund-zero"),
              foundation.paymentId,
              "r1",
              new Date(),
            ],
          ),
        { code: "23514" },
      );
      const payment = await client.query<{
        provider_intent_id: string;
        requested_amount_minor: string;
      }>(
        `SELECT provider_intent_id, requested_amount_minor::text
         FROM payments WHERE id = $1`,
        [foundation.paymentId],
      );
      const capturedAmount = payment.rows[0]?.requested_amount_minor;
      const providerIntentId = payment.rows[0]?.provider_intent_id;
      if (!capturedAmount || !providerIntentId) {
        throw new Error("fixture payment is missing");
      }
      await expectQueryError(
        client,
        "duplicate_provider",
        () =>
          client.query(
            `INSERT INTO payments (id, order_id, price_snapshot_id, order_price_binding_id,
                                  payment_schedule_id, role, provider, provider_intent_id,
                                  requested_amount_minor, currency, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'FULL','test',$6,$7,'EUR',$8,$8)`,
            [
              fixtures.id("duplicate-payment"),
              foundation.orderId,
              foundation.priceSnapshotId,
              foundation.orderPriceBindingId,
              foundation.paymentScheduleId,
              providerIntentId,
              capturedAmount,
              new Date(),
            ],
          ),
        { code: "23505" },
      );
      const remainingRefundAmount = Number(capturedAmount) - 600;
      if (remainingRefundAmount <= 0) {
        throw new Error("fixture payment cannot support a partial refund");
      }
      await expectQueryError(
        client,
        "capture_without_provider_facts",
        () =>
          client.query(
            `UPDATE payments SET status = 'CAPTURED' WHERE id = $1`,
            [foundation.paymentId],
          ),
        { code: "23514", constraint: "payments_capture_facts_check" },
      );
      await activateCurrentPlan(
        client,
        fixtures,
        foundation,
        foundationProductions,
      );
      await client.query(
        `INSERT INTO refund_transactions (id, payment_id, idempotency_key,
                                         amount_minor, reason, status, created_at, updated_at)
         VALUES ($1,$2,$3,600,'CUSTOMER_CANCELLATION','PENDING',$4,$4)`,
        [
          fixtures.id("refund-first"),
          foundation.paymentId,
          "refund-first",
          new Date(),
        ],
      );
      await expectQueryError(
        client,
        "audit_refund_payment_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, payment_id, refund_transaction_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'refund.scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-refund-payment-mismatch"),
              other.paymentId,
              fixtures.id("refund-first"),
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await expectQueryError(
        client,
        "audit_refund_order_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, order_id, refund_transaction_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'refund.scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-refund-order-mismatch"),
              other.orderId,
              fixtures.id("refund-first"),
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await client.query(
        `INSERT INTO audit_events
         (id, order_id, payment_id, refund_transaction_id,
          event_type, payload, created_at)
         VALUES ($1,$2,$3,$4,'refund.scope_consistent','{}'::jsonb,$5)`,
        [
          fixtures.id("audit-refund-scope-consistent"),
          foundation.orderId,
          foundation.paymentId,
          fixtures.id("refund-first"),
          new Date(),
        ],
      );
      await expectQueryError(
        client,
        "over_refund",
        () =>
          client.query(
            `INSERT INTO refund_transactions (id, payment_id, idempotency_key,
                                             amount_minor, reason, status, created_at, updated_at)
             VALUES ($1,$2,$3,500,'CUSTOMER_CANCELLATION','PENDING',$4,$4)`,
            [
              fixtures.id("refund-over-cap"),
              foundation.paymentId,
              "refund-over-cap",
              new Date(),
            ],
          ),
        { code: "23514", constraint: "refund_captured_payment_check" },
      );
      await expectQueryError(
        client,
        "succeed_refund_without_provider_facts",
        () =>
          client.query(
            `UPDATE refund_transactions SET status = 'SUCCEEDED' WHERE id = $1`,
            [fixtures.id("refund-first")],
          ),
        {
          code: "23514",
          constraint: "refund_transactions_success_facts_check",
        },
      );
      const refundCompletedAt = new Date();
      await expectQueryError(
        client,
        "succeed_refund_without_payment_status",
        async () => {
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', provider_refund_id = $2,
                 completed_at = $3, updated_at = $3
             WHERE id = $1`,
            [
              fixtures.id("refund-first"),
              "provider-refund-first",
              refundCompletedAt,
            ],
          );
          await client.query(
            `SET CONSTRAINTS "refund_transactions_payment_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      await expectQueryError(
        client,
        "partial_status_without_successful_refund",
        async () => {
          await client.query(
            `UPDATE payments SET status = 'PARTIALLY_REFUNDED' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `SET CONSTRAINTS "payments_refund_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
        [
          fixtures.id("refund-first"),
          "provider-refund-first",
          refundCompletedAt,
        ],
      );
      await client.query(
        `UPDATE payments SET status = 'PARTIALLY_REFUNDED' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      for (const status of ["PENDING", "FAILED"]) {
        await expectQueryError(
          client,
          `reopen_succeeded_refund_${status.toLowerCase()}`,
          () =>
            client.query(
              `UPDATE refund_transactions SET status = $2 WHERE id = $1`,
              [fixtures.id("refund-first"), status],
            ),
          {
            code: "23514",
            constraint: "refund_transaction_succeeded_immutable_check",
          },
        );
      }
      await expectQueryError(
        client,
        "claim_full_refund_before_reconciliation",
        async () => {
          await client.query(
            `UPDATE payments SET status = 'REFUNDED' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `SET CONSTRAINTS "payments_refund_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `INSERT INTO refund_transactions (id, payment_id, idempotency_key,
                                         amount_minor, reason, status,
                                         provider_refund_id, requested_at,
                                         completed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','SUCCEEDED',$5,$6,$6,$6,$6)`,
        [
          fixtures.id("refund-remainder"),
          foundation.paymentId,
          "refund-remainder",
          remainingRefundAmount,
          "provider-refund-remainder",
          new Date(),
        ],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUNDED' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await expectQueryError(
        client,
        "rewind_captured_payment",
        () =>
          client.query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [
            foundation.paymentId,
          ]),
        { code: "23514", constraint: "payment_status_transition_check" },
      );
      await expectQueryError(
        client,
        "mutate_provider_intent",
        () =>
          client.query(
            `UPDATE payments SET provider_intent_id = $2 WHERE id = $1`,
            [foundation.paymentId, "replacement-provider-intent"],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "mutate_provider_capture",
        () =>
          client.query(
            `UPDATE payments SET provider_capture_id = $2 WHERE id = $1`,
            [foundation.paymentId, "replacement-provider-capture"],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "rewrite_captured_at",
        () =>
          client.query(
            `UPDATE payments
             SET captured_at = captured_at + interval '1 second'
             WHERE id = $1`,
            [foundation.paymentId],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await client.query(
        `UPDATE payments
         SET capture_authorized = false, capture_cutoff_at = $2
         WHERE id = $1`,
        [foundation.paymentId, new Date()],
      );
      await expectQueryError(
        client,
        "reopen_capture_window",
        () =>
          client.query(
            `UPDATE payments SET capture_authorized = true WHERE id = $1`,
            [foundation.paymentId],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "mutate_payment_contract",
        () =>
          client.query(
            `UPDATE payments SET requested_amount_minor = requested_amount_minor - 1
             WHERE id = $1`,
            [foundation.paymentId],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "delete_payment",
        () =>
          client.query(`DELETE FROM payments WHERE id = $1`, [
            foundation.paymentId,
          ]),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
    });
  });

  it("releases terminal order source holds without clearing financial or legal blockers", async () => {
    await rollback("terminal-source-retention", async (client, fixtures) => {
      const completed = await fixtures.createFoundation("completed-order", {
        deleteAfter: testTimes.capacityEnd,
        quoteExpiresAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000),
      });
      const completedProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        completed,
      );
      await activateCurrentPlan(
        client,
        fixtures,
        completed,
        completedProductions,
      );
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT retention_hold::text FROM model_files WHERE id = $1`,
            [completed.modelFileId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "ACTIVE_ORDER" }]);
      const completedAt = (
        await client.query<{ completed_at: Date }>(
          `SELECT clock_timestamp() AS completed_at`,
        )
      ).rows[0]?.completed_at;
      if (!completedAt) {
        throw new Error("database completion clock is unavailable");
      }
      await advanceOrderToCompleted(client, completed.orderId);
      const releasedSource = await client.query<{
        retention_hold: string;
        source_delete_after: Date;
      }>(
        `SELECT retention_hold::text, source_delete_after
         FROM model_files WHERE id = $1`,
        [completed.modelFileId],
      );
      expect(releasedSource.rows[0]?.retention_hold).toBe("NONE");
      expect(
        releasedSource.rows[0]?.source_delete_after.getTime(),
      ).toBeGreaterThanOrEqual(
        completedAt.getTime() + 90 * 24 * 60 * 60 * 1_000,
      );
      await expectQueryError(
        client,
        "reopen_terminal_order",
        () =>
          client.query(`UPDATE orders SET status = 'CONFIRMED' WHERE id = $1`, [
            completed.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );

      const captured = await fixtures.createFoundation("captured-cancelled");
      const capturedProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        captured,
      );
      const capturedAmount = (
        await client.query<{ requested_amount_minor: string }>(
          `SELECT requested_amount_minor::text FROM payments WHERE id = $1`,
          [captured.paymentId],
        )
      ).rows[0]?.requested_amount_minor;
      if (!capturedAmount) {
        throw new Error("captured retention fixture payment is missing");
      }
      await activateCurrentPlan(
        client,
        fixtures,
        captured,
        capturedProductions,
      );
      await client.query(
        `UPDATE orders SET status = 'CANCELLED' WHERE id = $1`,
        [captured.orderId],
      );
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT retention_hold::text FROM model_files WHERE id = $1`,
            [captured.modelFileId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "ACTIVE_ORDER" }]);
      await expectQueryError(
        client,
        "close_unrefunded_order",
        async () => {
          await client.query(
            `UPDATE orders SET status = 'REFUNDED' WHERE id = $1`,
            [captured.orderId],
          );
          await client.query(
            `SET CONSTRAINTS "orders_refund_completion_reconciled" IMMEDIATE`,
          );
        },
        { code: "23514", constraint: "order_refund_completion_check" },
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
        [captured.paymentId],
      );
      await client.query(
        `INSERT INTO refund_transactions
         (id, payment_id, idempotency_key, provider_refund_id,
          amount_minor, reason, status, requested_at, completed_at,
          created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'CUSTOMER_CANCELLATION','SUCCEEDED',$6,$6,$6,$6)`,
        [
          fixtures.id("retention-full-refund"),
          captured.paymentId,
          "retention-full-refund",
          "retention-full-refund",
          capturedAmount,
          new Date(),
        ],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUNDED' WHERE id = $1`,
        [captured.paymentId],
      );
      await client.query(
        `UPDATE orders SET status = 'REFUNDED' WHERE id = $1`,
        [captured.orderId],
      );
      await client.query(
        `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "orders_refund_completion_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT retention_hold::text FROM model_files WHERE id = $1`,
            [captured.modelFileId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "NONE" }]);

      const legal = await fixtures.createFoundation("legal-order");
      const legalProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        legal,
      );
      await activateCurrentPlan(client, fixtures, legal, legalProductions);
      await client.query(
        `UPDATE model_files SET retention_hold = 'LEGAL' WHERE id = $1`,
        [legal.modelFileId],
      );
      await advanceOrderToCompleted(client, legal.orderId);
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT retention_hold::text FROM model_files WHERE id = $1`,
            [legal.modelFileId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "LEGAL" }]);
    });
  });

  it("accepts only currently quoted and unexpired individual offers", async () => {
    await rollback(
      "individual-offer-availability",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "individual-offer-availability",
        );
        const createPricedOffer = async (
          name: string,
          issuedAt: Date,
          expiresAt: Date,
          snapshotHash: string,
        ): Promise<string> => {
          const requestId = fixtures.id(`${name}:request`);
          const quoteId = fixtures.id(`${name}:quote`);
          const snapshotId = fixtures.id(`${name}:snapshot`);
          await client.query(
            `INSERT INTO quote_requests
             (id, customer_id, status, created_at, updated_at)
           VALUES ($1,$2,'QUOTED',$3,$3)`,
            [requestId, foundation.customerId, issuedAt],
          );
          await client.query(
            `INSERT INTO quotes
             (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$5)`,
            [quoteId, requestId, foundation.customerId, expiresAt, issuedAt],
          );
          await client.query(
            `INSERT INTO price_snapshots
             (id, currency, contract_total_minor, pricing_revision,
              input_snapshot, snapshot_hash, created_at)
           VALUES ($1,'EUR',0,'offer-v0','{}'::jsonb,$2,$3)`,
            [snapshotId, snapshotHash, issuedAt],
          );
          await client.query(
            `INSERT INTO payment_schedules
             (id, price_snapshot_id, sequence, role, gross_amount_minor,
              fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
           VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
            [fixtures.id(`${name}:schedule`), snapshotId, issuedAt],
          );
          await client.query(
            `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
           VALUES ($1,$2)`,
            [quoteId, snapshotId],
          );
          return requestId;
        };

        const now = new Date();
        const closedRequestId = await createPricedOffer(
          "closed-offer",
          now,
          new Date(now.getTime() + 60 * 60 * 1_000),
          "1".repeat(64),
        );
        await client.query(
          `UPDATE quote_requests SET status = 'EXPIRED', updated_at = $2
         WHERE id = $1`,
          [closedRequestId, now],
        );
        await expectQueryError(
          client,
          "accept_closed_offer",
          () =>
            client.query(
              `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
             WHERE id = $1`,
              [closedRequestId, now],
            ),
          {
            code: "23514",
            constraint: "quote_price_binding_acceptance_check",
          },
        );

        const staleIssuedAt = new Date(now.getTime() - 2 * 60 * 60 * 1_000);
        const staleRequestId = await createPricedOffer(
          "stale-offer",
          staleIssuedAt,
          new Date(now.getTime() - 60 * 60 * 1_000),
          "2".repeat(64),
        );
        await expectQueryError(
          client,
          "accept_stale_offer",
          () =>
            client.query(
              `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
             WHERE id = $1`,
              [staleRequestId, now],
            ),
          {
            code: "23514",
            constraint: "quote_price_binding_acceptance_check",
          },
        );
      },
    );
  });

  it("allows an individual draft only after accepting a quoted request and copies its quote item exactly", async () => {
    await rollback("individual-copy", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("individual-copy");
      const quoteRequestId = fixtures.id("custom-request");
      const quoteId = fixtures.id("custom-quote");
      const quoteItemId = fixtures.id("custom-quote-item");
      const snapshotId = fixtures.id("custom-snapshot");
      const scheduleId = fixtures.id("custom-schedule");
      const orderId = fixtures.id("custom-order");
      const orderItemId = fixtures.id("custom-order-item");
      const now = new Date();
      await client.query(
        `INSERT INTO quote_requests (id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,'QUOTED',$3,$3)`,
        [quoteRequestId, foundation.customerId, now],
      );
      await client.query(
        `INSERT INTO quotes (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          quoteId,
          quoteRequestId,
          foundation.customerId,
          new Date(now.getTime() + 60 * 60 * 1_000),
          now,
        ],
      );
      await client.query(
        `INSERT INTO quote_items (id, quote_id, ordinal, source_model_file_id,
                                 model_geometry_id, print_config_revision_id, material,
                                 color, quantity, created_at)
         VALUES ($1,$2,0,$3,$4,$5,'PLA','black',2,$6)`,
        [
          quoteItemId,
          quoteId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO price_snapshots (id, currency, contract_total_minor, pricing_revision,
                                     input_snapshot, snapshot_hash, created_at)
         VALUES ($1,'EUR',0,'custom-v0','{}'::jsonb,$2,$3)`,
        [snapshotId, "b".repeat(64), now],
      );
      await client.query(
        `INSERT INTO payment_schedules (id, price_snapshot_id, sequence, role,
                                       gross_amount_minor, fee_rate_basis_points, fee_fixed_minor,
                                       provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [scheduleId, snapshotId, now],
      );
      await expectQueryError(
        client,
        "accept_quote_without_price_binding",
        () =>
          client.query(
            `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2 WHERE id = $1`,
            [quoteRequestId, now],
          ),
        {
          code: "23514",
          constraint: "quote_price_binding_acceptance_check",
        },
      );
      await client.query(
        `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id) VALUES ($1,$2)`,
        [quoteId, snapshotId],
      );
      await expectQueryError(
        client,
        "price_bound_quote_item_insert",
        () =>
          client.query(
            `INSERT INTO quote_items (id, quote_id, ordinal, source_model_file_id,
                                     model_geometry_id, print_config_revision_id, material,
                                     color, quantity, created_at)
             VALUES ($1,$2,1,$3,$4,$5,'PLA','white',1,$6)`,
            [
              fixtures.id("price-bound-quote-item"),
              quoteId,
              foundation.modelFileId,
              foundation.modelGeometryId,
              foundation.printConfigRevisionId,
              now,
            ],
          ),
        {
          code: "23514",
          constraint: "quote_item_price_binding_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "accept_quote_without_order",
        async () => {
          await client.query(
            `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
             WHERE id = $1`,
            [quoteRequestId, now],
          );
          await client.query(
            `SET CONSTRAINTS "quote_requests_individual_order_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "quote_request_individual_order_atomic_check",
        },
      );
      await client.query(
        `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2 WHERE id = $1`,
        [quoteRequestId, now],
      );
      const closedRequestId = fixtures.id("closed-custom-request");
      const closedQuoteId = fixtures.id("closed-custom-quote");
      const closedSnapshotId = fixtures.id("closed-custom-snapshot");
      await client.query(
        `INSERT INTO quote_requests (id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,'QUOTED',$3,$3)`,
        [closedRequestId, foundation.customerId, now],
      );
      await client.query(
        `INSERT INTO quotes (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          closedQuoteId,
          closedRequestId,
          foundation.customerId,
          new Date(now.getTime() + 60 * 60 * 1_000),
          now,
        ],
      );
      await client.query(
        `INSERT INTO price_snapshots (id, currency, contract_total_minor,
                                     pricing_revision, input_snapshot,
                                     snapshot_hash, created_at)
         VALUES ($1,'EUR',0,'closed-v0','{}'::jsonb,$2,$3)`,
        [closedSnapshotId, "c".repeat(64), now],
      );
      await client.query(
        `INSERT INTO payment_schedules (id, price_snapshot_id, sequence, role,
                                       gross_amount_minor, fee_rate_basis_points,
                                       fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [fixtures.id("closed-custom-schedule"), closedSnapshotId, now],
      );
      await client.query(
        `UPDATE quote_requests SET status = 'EXPIRED', updated_at = $2 WHERE id = $1`,
        [closedRequestId, now],
      );
      await expectQueryError(
        client,
        "bind_closed_quote",
        () =>
          client.query(
            `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id) VALUES ($1,$2)`,
            [closedQuoteId, closedSnapshotId],
          ),
        {
          code: "23514",
          constraint: "quote_price_binding_acceptance_check",
        },
      );
      await expectQueryError(
        client,
        "accepted_quote_item_insert",
        () =>
          client.query(
            `INSERT INTO quote_items (id, quote_id, ordinal, source_model_file_id,
                                     model_geometry_id, print_config_revision_id, material,
                                     color, quantity, created_at)
             VALUES ($1,$2,1,$3,$4,$5,'PLA','white',1,$6)`,
            [
              fixtures.id("late-accepted-quote-item"),
              quoteId,
              foundation.modelFileId,
              foundation.modelGeometryId,
              foundation.printConfigRevisionId,
              now,
            ],
          ),
        {
          code: "23514",
          constraint: "quote_item_accepted_immutable_check",
        },
      );

      await expectQueryError(
        client,
        "binding_before_individual_origin",
        async () => {
          const mismatchedOrderId = fixtures.id("mismatched-custom-order");
          const mismatchedDestinationId = fixtures.id(
            "mismatched-custom-destination",
          );
          await client.query(
            `INSERT INTO orders
               (id, customer_id, public_reference, status, created_at, updated_at)
             VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
            [
              mismatchedOrderId,
              foundation.customerId,
              `I-${randomUUID()}`,
              now,
            ],
          );
          await client.query(
            `INSERT INTO delivery_destinations
               (id, order_id, provider_endpoint_id, endpoint_type,
                address_snapshot, capability_snapshot, created_at)
             VALUES ($1,$2,$3,'address','{}'::jsonb,'{}'::jsonb,$4)`,
            [
              mismatchedDestinationId,
              mismatchedOrderId,
              `endpoint-${randomUUID()}`,
              now,
            ],
          );
          await client.query(
            `INSERT INTO order_price_bindings
               (id, order_id, price_snapshot_id,
                delivery_destination_id, created_at)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              fixtures.id("mismatched-custom-binding"),
              mismatchedOrderId,
              closedSnapshotId,
              mismatchedDestinationId,
              now,
            ],
          );
          await client.query(
            `INSERT INTO individual_order_origins (order_id, quote_id)
             VALUES ($1,$2)`,
            [mismatchedOrderId, quoteId],
          );
          await client.query(
            `SET CONSTRAINTS
               "individual_order_origins_quote_snapshot_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "individual_order_price_binding_check",
        },
      );

      await client.query(
        `INSERT INTO orders (id, customer_id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
        [orderId, foundation.customerId, `I-${randomUUID()}`, now],
      );
      const destinationId = fixtures.id("custom-destination");
      await client.query(
        `INSERT INTO delivery_destinations
           (id, order_id, provider_endpoint_id, endpoint_type,
            address_snapshot, capability_snapshot, created_at)
         VALUES ($1,$2,$3,'address','{}'::jsonb,'{}'::jsonb,$4)`,
        [destinationId, orderId, `endpoint-${randomUUID()}`, now],
      );
      await client.query(
        `INSERT INTO individual_order_origins (order_id, quote_id) VALUES ($1,$2)`,
        [orderId, quoteId],
      );
      await client.query(
        `INSERT INTO order_items (id, order_id, ordinal, source_model_file_id,
                                 model_geometry_id, print_config_revision_id, material,
                                 color, quantity, created_at)
         VALUES ($1,$2,0,$3,$4,$5,'PLA','black',2,$6)`,
        [
          orderItemId,
          orderId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO individual_order_item_sources (order_item_id, quote_item_id)
         VALUES ($1,$2)`,
        [orderItemId, quoteItemId],
      );
      await client.query(
        `INSERT INTO order_price_bindings
           (id, order_id, price_snapshot_id, delivery_destination_id, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          fixtures.id("custom-order-price-binding"),
          orderId,
          snapshotId,
          destinationId,
          now,
        ],
      );
      await client.query(
        `SET CONSTRAINTS
           "order_price_bindings_individual_quote_snapshot_reconciled",
           "individual_order_origins_quote_snapshot_reconciled",
           "quote_requests_individual_order_reconciled",
           "individual_order_origins_request_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{ request_status: string; order_status: string }>(
            `SELECT request.status::text AS request_status,
                    target_order.status::text AS order_status
             FROM quote_requests request
             JOIN quotes quote ON quote.quote_request_id = request.id
             JOIN individual_order_origins origin ON origin.quote_id = quote.id
             JOIN orders target_order ON target_order.id = origin.order_id
             WHERE request.id = $1`,
            [quoteRequestId],
          )
        ).rows,
      ).toEqual([{ request_status: "ACCEPTED", order_status: "DRAFT" }]);
      expect(
        (
          await client.query<{
            color: string;
            material: string;
            model_geometry_id: string;
            print_config_revision_id: string;
            quantity: number;
            source_model_file_id: string;
          }>(
            `SELECT item.source_model_file_id, item.model_geometry_id,
                    item.print_config_revision_id, item.material::text,
                    item.color, item.quantity
             FROM order_items item
             JOIN individual_order_item_sources source
               ON source.order_item_id = item.id
             WHERE item.id = $1 AND source.quote_item_id = $2`,
            [orderItemId, quoteItemId],
          )
        ).rows,
      ).toEqual([
        {
          source_model_file_id: foundation.modelFileId,
          model_geometry_id: foundation.modelGeometryId,
          print_config_revision_id: foundation.printConfigRevisionId,
          material: "PLA",
          color: "black",
          quantity: 2,
        },
      ]);
      expect(
        (
          await client.query<{ automatic_origins: string; payments: string }>(
            `SELECT
               (SELECT count(*)::text FROM automatic_order_origins
                WHERE order_id = $1) AS automatic_origins,
               (SELECT count(*)::text FROM payments
                WHERE order_id = $1) AS payments`,
            [orderId],
          )
        ).rows,
      ).toEqual([{ automatic_origins: "0", payments: "0" }]);
    });
  });
});
