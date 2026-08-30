import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;

function databaseIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

it("upgrades sealed legacy individual FULL contracts without rewriting them", async () => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for migration upgrade tests");
  }

  const sourceUrl = new URL(databaseUrl);
  const databaseName = `taven_upgrade_${randomUUID().replaceAll("-", "")}`;
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  targetUrl.searchParams.delete("schema");
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  adminUrl.searchParams.delete("schema");
  const admin = new Client({ connectionString: adminUrl.toString() });
  let target: Client | undefined;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseIdentifier(databaseName)}`);
    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();

    const migrationsRoot = join(process.cwd(), "prisma/migrations");
    const finalMigration = "20260830220000_price_list_snapshot_contract";
    const migrations = (await readdir(migrationsRoot))
      .filter((name) => /^20/.test(name))
      .sort();
    for (const migration of migrations.filter(
      (name) => name !== finalMigration,
    )) {
      await target.query(
        await readFile(
          join(migrationsRoot, migration, "migration.sql"),
          "utf8",
        ),
      );
    }

    await target.query(`
      SET session_replication_role = 'replica';

      INSERT INTO customers (id, email, first_seen_at, created_at, updated_at)
      VALUES (
        '10000000-0000-4000-8000-000000000001',
        'legacy-individual@example.test',
        clock_timestamp(), clock_timestamp(), clock_timestamp()
      );
      INSERT INTO quote_requests
        (id, customer_id, status, created_at, updated_at)
      VALUES (
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
        'QUOTED', clock_timestamp(), clock_timestamp()
      );
      INSERT INTO quotes
        (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
        clock_timestamp() + interval '30 days',
        clock_timestamp(), clock_timestamp()
      );
      INSERT INTO price_snapshots
        (id, currency, contract_total_minor, pricing_revision, input_snapshot,
         snapshot_hash, sealed_at, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000004', 'EUR', 2500,
        'legacy-individual-v0', '{}'::jsonb, repeat('a', 64),
        clock_timestamp(), clock_timestamp()
      );
      INSERT INTO payment_schedules
        (id, price_snapshot_id, sequence, role, gross_amount_minor,
         fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000005',
        '10000000-0000-4000-8000-000000000004',
        0, 'FULL', 2500, 0, 0, '{}'::jsonb, clock_timestamp()
      );
      INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
      VALUES (
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000004'
      );
      INSERT INTO orders
        (id, customer_id, public_reference, status, quoted_at,
         created_at, updated_at)
      VALUES (
        '10000000-0000-4000-8000-000000000006',
        '10000000-0000-4000-8000-000000000001',
        'T-LEGACY-FULL', 'QUOTED', clock_timestamp(),
        clock_timestamp(), clock_timestamp()
      );
      INSERT INTO individual_order_origins (order_id, quote_id)
      VALUES (
        '10000000-0000-4000-8000-000000000006',
        '10000000-0000-4000-8000-000000000003'
      );
      INSERT INTO delivery_destinations
        (id, order_id, provider_endpoint_id, endpoint_type,
         address_snapshot, capability_snapshot, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000007',
        '10000000-0000-4000-8000-000000000006',
        'legacy-endpoint', 'address', '{}'::jsonb, '{}'::jsonb,
        clock_timestamp()
      );
      INSERT INTO order_price_bindings
        (id, order_id, price_snapshot_id, delivery_destination_id, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000008',
        '10000000-0000-4000-8000-000000000006',
        '10000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000007',
        clock_timestamp()
      );
      INSERT INTO order_active_price_bindings
        (order_id, order_price_binding_id)
      VALUES (
        '10000000-0000-4000-8000-000000000006',
        '10000000-0000-4000-8000-000000000008'
      );
      UPDATE orders
      SET status = 'IN_PRODUCTION',
          confirmed_at = clock_timestamp(),
          accepted_order_price_binding_id =
            '10000000-0000-4000-8000-000000000008',
          accepted_terms_revision = 'terms-v1',
          accepted_claim_policy_revision = 'claims-v1',
          withdrawal_exception_acknowledged_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = '10000000-0000-4000-8000-000000000006';

      SET session_replication_role = 'origin';
    `);

    await target.query(
      await readFile(
        join(migrationsRoot, finalMigration, "migration.sql"),
        "utf8",
      ),
    );

    expect(
      (
        await target.query<{
          contract_valid: boolean;
          marker_count: string;
          schedule_roles: string[];
          snapshot_still_sealed: boolean;
        }>(`
          SELECT
            (SELECT count(*)::text
             FROM legacy_individual_full_payment_bindings legacy
             WHERE legacy.order_id = target_order.id) AS marker_count,
            snapshot.sealed_at IS NOT NULL AS snapshot_still_sealed,
            ARRAY(
              SELECT schedule.role::text
              FROM payment_schedules schedule
              WHERE schedule.price_snapshot_id = snapshot.id
              ORDER BY schedule.sequence
            ) AS schedule_roles,
            taven_payment_schedule_is_valid_for_order(
              target_order.id, snapshot.id, snapshot.contract_total_minor
            ) AS contract_valid
          FROM orders target_order
          JOIN order_active_price_bindings active
            ON active.order_id = target_order.id
          JOIN order_price_bindings binding
            ON binding.id = active.order_price_binding_id
          JOIN price_snapshots snapshot ON snapshot.id = binding.price_snapshot_id
          WHERE target_order.id = '10000000-0000-4000-8000-000000000006'
        `)
      ).rows,
    ).toEqual([
      {
        contract_valid: true,
        marker_count: "1",
        schedule_roles: ["FULL"],
        snapshot_still_sealed: true,
      },
    ]);

    await target.query(`
      ALTER TABLE orders DISABLE TRIGGER USER;
      ALTER TABLE orders ENABLE TRIGGER orders_qc_balance_payment_created;
      UPDATE orders
      SET status = 'QC_PASSED', updated_at = clock_timestamp()
      WHERE id = '10000000-0000-4000-8000-000000000006';
    `);
    expect(
      (
        await target.query<{ balance_count: string }>(`
          SELECT count(*)::text AS balance_count
          FROM payments
          WHERE order_id = '10000000-0000-4000-8000-000000000006'
            AND role = 'BALANCE'
        `)
      ).rows,
    ).toEqual([{ balance_count: "0" }]);
  } finally {
    await target?.end().catch(() => undefined);
    await admin.query(
      `DROP DATABASE IF EXISTS ${databaseIdentifier(databaseName)} WITH (FORCE)`,
    );
    await admin.end();
  }
}, 30_000);
