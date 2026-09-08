import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;

function databaseIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function applyMigrationWithCommittedEnumValues(
  client: Client,
  migrationSql: string,
): Promise<void> {
  // pg sends a whole SQL file as one implicit transaction. PostgreSQL makes a
  // newly added enum value usable only after that transaction commits, whereas
  // Prisma's migration runner commits these ALTER TYPE statements separately.
  const enumValueStatements =
    migrationSql.match(/^ALTER TYPE .+ ADD VALUE(?: IF NOT EXISTS)? .+;$/gmu) ??
    [];
  for (const statement of enumValueStatements) {
    await client.query(statement);
  }
  const remainingSql = migrationSql.replace(
    /^ALTER TYPE .+ ADD VALUE(?: IF NOT EXISTS)? .+;$/gmu,
    "",
  );
  if (remainingSql.trim()) await client.query(remainingSql);
}

it("binds only uniquely provable legacy automatic-quote handoff issuance", async () => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for migration upgrade tests");
  }

  const sourceUrl = new URL(databaseUrl);
  const databaseName = `taven_handoff_upgrade_${randomUUID().replaceAll("-", "")}`;
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  targetUrl.searchParams.delete("schema");
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  adminUrl.searchParams.delete("schema");
  const admin = new Client({ connectionString: adminUrl.toString() });
  let target: Client | undefined;

  const migration = "20260908090000_harden_automatic_quote_handoff_issuance";
  const provableCapabilityId = "92000000-0000-4000-8000-000000000001";
  const ambiguousCapabilityId = "92000000-0000-4000-8000-000000000002";
  const provableRecordId = "93000000-0000-4000-8000-000000000001";

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseIdentifier(databaseName)}`);
    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();

    const migrationsRoot = join(process.cwd(), "prisma/migrations");
    const migrations = (await readdir(migrationsRoot))
      .filter((name) => /^20/.test(name))
      .sort();
    for (const name of migrations.filter((name) => name < migration)) {
      await applyMigrationWithCommittedEnumValues(
        target,
        await readFile(join(migrationsRoot, name, "migration.sql"), "utf8"),
      );
    }

    await target.query(`
      SET session_replication_role = 'replica';

      INSERT INTO automatic_quote_handoff_capabilities
        (id, source_quote_session_id, token_hash, scope, reasons, model_file_ids,
         item_selections, issued_at, expires_at)
      VALUES
        ('${provableCapabilityId}', '91000000-0000-4000-8000-000000000001',
         repeat('a', 64), 'ASSISTED_QUOTE_REQUEST', ARRAY['UNSUPPORTED_FORMAT'],
         ARRAY[]::text[], '[]'::jsonb,
         '2026-09-01T00:00:00.000Z', '2026-09-01T00:15:00.000Z'),
        ('${ambiguousCapabilityId}', '91000000-0000-4000-8000-000000000002',
         repeat('b', 64), 'ASSISTED_QUOTE_REQUEST', ARRAY['UNSUPPORTED_FORMAT'],
         ARRAY[]::text[], '[]'::jsonb,
         '2026-09-01T00:00:00.000Z', '2026-09-01T00:15:00.000Z');

      INSERT INTO idempotency_records
        (id, namespace, idempotency_key, generation, request_fingerprint, status,
         response_status_code, response_body, expires_at, created_at, updated_at)
      VALUES
        ('${provableRecordId}',
         'automatic-quote.handoff:91000000-0000-4000-8000-000000000001',
         'legacy-canonical-key', 1, repeat('c', 64), 'COMPLETED', 200,
         '{"handoffId":"${provableCapabilityId}","expiresAt":"2026-09-01T00:15:00.000Z"}'::jsonb,
         '2026-09-08T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('93000000-0000-4000-8000-000000000002',
         'automatic-quote.handoff:91000000-0000-4000-8000-000000000002',
         'ambiguous-key-one', 1, repeat('d', 64), 'COMPLETED', 200,
         '{"handoffId":"${ambiguousCapabilityId}","expiresAt":"2026-09-01T00:15:00.000Z"}'::jsonb,
         '2026-09-08T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('93000000-0000-4000-8000-000000000003',
         'automatic-quote.handoff:91000000-0000-4000-8000-000000000002',
         'ambiguous-key-two', 1, repeat('e', 64), 'COMPLETED', 200,
         '{"handoffId":"${ambiguousCapabilityId}","expiresAt":"2026-09-01T00:15:00.000Z"}'::jsonb,
         '2026-09-08T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');

      SET session_replication_role = 'origin';
    `);
    await target.query(
      await readFile(join(migrationsRoot, migration, "migration.sql"), "utf8"),
    );

    expect(
      (
        await target.query<{
          issuance_idempotency_record_id: string | null;
          issuance_key_hash: string | null;
          issuance_replay_until: Date | null;
          issuance_legacy_exhausted: boolean;
          consumed_at: Date | null;
        }>(`
          SELECT issuance_idempotency_record_id, issuance_key_hash,
                 issuance_replay_until, issuance_legacy_exhausted, consumed_at
          FROM automatic_quote_handoff_capabilities
          WHERE id = '${provableCapabilityId}'
        `)
      ).rows,
    ).toEqual([
      {
        issuance_idempotency_record_id: provableRecordId,
        issuance_key_hash:
          "451b8e1e788408a843bcc5d4a699e603d2a476699562f12640bd120aaa54dc7a",
        issuance_replay_until: new Date("2026-09-08T00:00:00.000Z"),
        issuance_legacy_exhausted: false,
        consumed_at: null,
      },
    ]);
    expect(
      (
        await target.query<{
          issuance_idempotency_record_id: string | null;
          issuance_key_hash: string | null;
          issuance_replay_until: Date | null;
          issuance_legacy_exhausted: boolean;
          consumed_at: Date | null;
        }>(`
          SELECT issuance_idempotency_record_id, issuance_key_hash,
                 issuance_replay_until, issuance_legacy_exhausted, consumed_at
          FROM automatic_quote_handoff_capabilities
          WHERE id = '${ambiguousCapabilityId}'
        `)
      ).rows,
    ).toEqual([
      {
        issuance_idempotency_record_id: null,
        issuance_key_hash: null,
        issuance_replay_until: null,
        issuance_legacy_exhausted: true,
        consumed_at: null,
      },
    ]);

    await expect(
      target.query(`
        UPDATE automatic_quote_handoff_capabilities
        SET consumed_at = issued_at + interval '1 second'
        WHERE id = '${ambiguousCapabilityId}'
      `),
    ).resolves.toMatchObject({ rowCount: 1 });
  } finally {
    await target?.end().catch(() => undefined);
    await admin.query(
      `DROP DATABASE IF EXISTS ${databaseIdentifier(databaseName)} WITH (FORCE)`,
    );
    await admin.end();
  }
}, 30_000);

it("upgrades sealed legacy individual FULL contracts and outstanding quotes without rewriting them", async () => {
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
      (name) => name < finalMigration,
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
      INSERT INTO quote_requests
        (id, customer_id, status, created_at, updated_at)
      VALUES
        ('10000000-0000-4000-8000-000000000010',
         '10000000-0000-4000-8000-000000000001',
         'QUOTED', clock_timestamp(), clock_timestamp()),
        ('10000000-0000-4000-8000-000000000020',
         '10000000-0000-4000-8000-000000000001',
         'EXPIRED', clock_timestamp(), clock_timestamp()),
        ('10000000-0000-4000-8000-000000000030',
         '10000000-0000-4000-8000-000000000001',
         'REJECTED', clock_timestamp(), clock_timestamp());
      INSERT INTO quotes
        (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
      VALUES
        ('10000000-0000-4000-8000-000000000011',
         '10000000-0000-4000-8000-000000000010',
         '10000000-0000-4000-8000-000000000001',
         clock_timestamp() + interval '30 days', clock_timestamp(), clock_timestamp()),
        ('10000000-0000-4000-8000-000000000021',
         '10000000-0000-4000-8000-000000000020',
         '10000000-0000-4000-8000-000000000001',
         clock_timestamp() - interval '1 day', clock_timestamp() - interval '2 days', clock_timestamp()),
        ('10000000-0000-4000-8000-000000000031',
         '10000000-0000-4000-8000-000000000030',
         '10000000-0000-4000-8000-000000000001',
         clock_timestamp() + interval '30 days', clock_timestamp(), clock_timestamp());
      INSERT INTO price_snapshots
        (id, currency, contract_total_minor, pricing_revision, input_snapshot,
         snapshot_hash, sealed_at, created_at)
      VALUES
        ('10000000-0000-4000-8000-000000000012', 'EUR', 2500,
         'legacy-outstanding-full-v0', '{}'::jsonb, repeat('b', 64),
         clock_timestamp(), clock_timestamp()),
        ('10000000-0000-4000-8000-000000000022', 'EUR', 2500,
         'legacy-expired-full-v0', '{}'::jsonb, repeat('c', 64),
         clock_timestamp(), clock_timestamp()),
        ('10000000-0000-4000-8000-000000000032', 'EUR', 2500,
         'legacy-rejected-full-v0', '{}'::jsonb, repeat('d', 64),
         clock_timestamp(), clock_timestamp());
      INSERT INTO payment_schedules
        (id, price_snapshot_id, sequence, role, gross_amount_minor,
         fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
      VALUES
        ('10000000-0000-4000-8000-000000000013',
         '10000000-0000-4000-8000-000000000012',
         0, 'FULL', 2500, 0, 0, '{}'::jsonb, clock_timestamp()),
        ('10000000-0000-4000-8000-000000000023',
         '10000000-0000-4000-8000-000000000022',
         0, 'FULL', 2500, 0, 0, '{}'::jsonb, clock_timestamp()),
        ('10000000-0000-4000-8000-000000000033',
         '10000000-0000-4000-8000-000000000032',
         0, 'FULL', 2500, 0, 0, '{}'::jsonb, clock_timestamp());
      INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
      VALUES
        ('10000000-0000-4000-8000-000000000011',
         '10000000-0000-4000-8000-000000000012'),
        ('10000000-0000-4000-8000-000000000021',
         '10000000-0000-4000-8000-000000000022'),
        ('10000000-0000-4000-8000-000000000031',
         '10000000-0000-4000-8000-000000000032');
      INSERT INTO quote_items
        (id, quote_id, ordinal, source_model_file_id, model_geometry_id,
         print_config_revision_id, material, quantity, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000014',
        '10000000-0000-4000-8000-000000000011', 0,
        '10000000-0000-4000-8000-000000009001',
        '10000000-0000-4000-8000-000000009002',
        '10000000-0000-4000-8000-000000009003',
        'PLA', 1, clock_timestamp()
      );
      INSERT INTO price_snapshot_components
        (id, price_snapshot_id, kind, scope, quote_item_id, amount_minor, created_at)
      VALUES
        ('10000000-0000-4000-8000-000000000015',
         '10000000-0000-4000-8000-000000000012',
         'ITEM_PRODUCTION', 'QUOTE_ITEM',
         '10000000-0000-4000-8000-000000000014', 2000, clock_timestamp()),
        ('10000000-0000-4000-8000-000000000016',
         '10000000-0000-4000-8000-000000000012',
         'ITEM_QUANTITY', 'QUOTE_ITEM',
         '10000000-0000-4000-8000-000000000014', 250, clock_timestamp()),
        ('10000000-0000-4000-8000-000000000017',
         '10000000-0000-4000-8000-000000000012',
         'ITEM_POSTPROCESSING', 'QUOTE_ITEM',
         '10000000-0000-4000-8000-000000000014', 250, clock_timestamp());
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

    expect(
      (
        await target.query<{
          marker_count: string;
          is_grandfathered: boolean;
        }>(`
          SELECT
            (SELECT count(*)::text
             FROM legacy_individual_full_quote_bindings) AS marker_count,
            taven_individual_full_quote_binding_is_grandfathered(
              '10000000-0000-4000-8000-000000000011',
              '10000000-0000-4000-8000-000000000012'
            ) AS is_grandfathered
        `)
      ).rows,
    ).toEqual([{ marker_count: "1", is_grandfathered: true }]);

    await expect(
      target.query(`
        UPDATE legacy_individual_full_quote_bindings
        SET recorded_at = recorded_at
        WHERE quote_id = '10000000-0000-4000-8000-000000000011'
      `),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "legacy_individual_full_quote_binding_immutable",
    });

    await target.query(`
      BEGIN;
      INSERT INTO orders
        (id, customer_id, public_reference, status, created_at, updated_at)
      VALUES (
        '10000000-0000-4000-8000-000000000018',
        '10000000-0000-4000-8000-000000000001',
        'T-LEGACY-OUTSTANDING-FULL', 'DRAFT',
        clock_timestamp(), clock_timestamp()
      );
      INSERT INTO delivery_destinations
        (id, order_id, provider_endpoint_id, endpoint_type,
         address_snapshot, capability_snapshot, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000019',
        '10000000-0000-4000-8000-000000000018',
        'legacy-outstanding-endpoint', 'address', '{}'::jsonb, '{}'::jsonb,
        clock_timestamp()
      );
      INSERT INTO order_price_bindings
        (id, order_id, price_snapshot_id, delivery_destination_id, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000018',
        '10000000-0000-4000-8000-000000000018',
        '10000000-0000-4000-8000-000000000012',
        '10000000-0000-4000-8000-000000000019',
        clock_timestamp()
      );
      INSERT INTO order_active_price_bindings
        (order_id, order_price_binding_id)
      VALUES (
        '10000000-0000-4000-8000-000000000018',
        '10000000-0000-4000-8000-000000000018'
      );
      UPDATE quote_requests
      SET status = 'ACCEPTED', updated_at = clock_timestamp()
      WHERE id = '10000000-0000-4000-8000-000000000010';
      INSERT INTO individual_order_origins (order_id, quote_id)
      VALUES (
        '10000000-0000-4000-8000-000000000018',
        '10000000-0000-4000-8000-000000000011'
      );
      COMMIT;
    `);

    expect(
      (
        await target.query<{
          order_schedule_valid: boolean;
          request_status: string;
        }>(`
          SELECT
            request.status::text AS request_status,
            taven_payment_schedule_is_valid_for_order(
              target_order.id, snapshot.id, snapshot.contract_total_minor
            ) AS order_schedule_valid
          FROM quote_requests request
          JOIN quotes quote ON quote.quote_request_id = request.id
          JOIN individual_order_origins origin ON origin.quote_id = quote.id
          JOIN orders target_order ON target_order.id = origin.order_id
          JOIN order_active_price_bindings active
            ON active.order_id = target_order.id
          JOIN order_price_bindings binding
            ON binding.id = active.order_price_binding_id
          JOIN price_snapshots snapshot ON snapshot.id = binding.price_snapshot_id
          WHERE request.id = '10000000-0000-4000-8000-000000000010'
        `)
      ).rows,
    ).toEqual([{ request_status: "ACCEPTED", order_schedule_valid: true }]);

    await target.query(`
      ALTER TABLE orders DISABLE TRIGGER USER;
      ALTER TABLE orders ENABLE TRIGGER orders_qc_balance_payment_created;
      UPDATE orders
      SET status = 'IN_PRODUCTION',
          quoted_at = clock_timestamp(),
          confirmed_at = clock_timestamp(),
          accepted_order_price_binding_id =
            '10000000-0000-4000-8000-000000000018',
          accepted_terms_revision = 'terms-v1',
          accepted_claim_policy_revision = 'claims-v1',
          withdrawal_exception_acknowledged_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = '10000000-0000-4000-8000-000000000018';
      UPDATE orders
      SET status = 'QC_PASSED', updated_at = clock_timestamp()
      WHERE id = '10000000-0000-4000-8000-000000000018';
    `);
    expect(
      (
        await target.query<{ balance_count: string }>(`
          SELECT count(*)::text AS balance_count
          FROM payments
          WHERE order_id = '10000000-0000-4000-8000-000000000018'
            AND role = 'BALANCE'
        `)
      ).rows,
    ).toEqual([{ balance_count: "0" }]);

    await target.query(`
      SET session_replication_role = 'replica';
      INSERT INTO quote_requests
        (id, customer_id, status, created_at, updated_at)
      VALUES (
        '10000000-0000-4000-8000-000000000040',
        '10000000-0000-4000-8000-000000000001',
        'QUOTED', clock_timestamp(), clock_timestamp()
      );
      INSERT INTO quotes
        (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000041',
        '10000000-0000-4000-8000-000000000040',
        '10000000-0000-4000-8000-000000000001',
        clock_timestamp() + interval '30 days', clock_timestamp(), clock_timestamp()
      );
      INSERT INTO price_snapshots
        (id, price_list_id, currency, contract_total_minor, pricing_revision,
         input_snapshot, snapshot_hash, sealed_at, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000042',
        (SELECT id FROM price_lists ORDER BY id LIMIT 1), 'EUR', 2500,
        'fresh-full-v1', '{}'::jsonb, repeat('e', 64),
        clock_timestamp(), clock_timestamp()
      );
      INSERT INTO payment_schedules
        (id, price_snapshot_id, sequence, role, gross_amount_minor,
         fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
      VALUES (
        '10000000-0000-4000-8000-000000000043',
        '10000000-0000-4000-8000-000000000042',
        0, 'FULL', 2500, 0, 0, '{}'::jsonb, clock_timestamp()
      );
      INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
      VALUES (
        '10000000-0000-4000-8000-000000000041',
        '10000000-0000-4000-8000-000000000042'
      );
      SET session_replication_role = 'origin';
    `);
    expect(
      (
        await target.query<{ marker_count: string }>(`
          SELECT count(*)::text AS marker_count
          FROM legacy_individual_full_quote_bindings
          WHERE quote_id = '10000000-0000-4000-8000-000000000041'
        `)
      ).rows,
    ).toEqual([{ marker_count: "0" }]);
    await expect(
      target.query(`
        UPDATE quote_requests
        SET status = 'ACCEPTED', updated_at = clock_timestamp()
        WHERE id = '10000000-0000-4000-8000-000000000040'
      `),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "quote_price_binding_acceptance_check",
    });

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

it("backfills existing price snapshots and price lists as non-VAT-payer records", async () => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for migration upgrade tests");
  }

  const sourceUrl = new URL(databaseUrl);
  const databaseName = `taven_tax_upgrade_${randomUUID().replaceAll("-", "")}`;
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
    const taxMigration = "20260904213100_vat_aware_pricing";
    const migrations = (await readdir(migrationsRoot))
      .filter((name) => /^20/.test(name))
      .sort();
    for (const migration of migrations.filter((name) => name < taxMigration)) {
      await target.query(
        await readFile(
          join(migrationsRoot, migration, "migration.sql"),
          "utf8",
        ),
      );
    }

    await target.query(`
      SET session_replication_role = 'replica';
      INSERT INTO price_snapshots
        (id, price_list_id, currency, contract_total_minor, pricing_revision,
         input_snapshot, snapshot_hash, created_at)
      VALUES (
        '81000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000019',
        'CZK', 12345, 'legacy-v0-czk', '{}'::jsonb, repeat('8', 64),
        clock_timestamp()
      );
      SET session_replication_role = 'origin';
    `);
    await target.query(
      await readFile(
        join(migrationsRoot, taxMigration, "migration.sql"),
        "utf8",
      ),
    );

    expect(
      (
        await target.query<{
          tax_regime: string;
          vat_rate_basis_points: number;
          net_amount_minor: string;
          vat_amount_minor: string;
          policy: unknown;
        }>(`
          SELECT snapshot.tax_regime::text,
                 snapshot.vat_rate_basis_points,
                 snapshot.net_amount_minor::text,
                 snapshot.vat_amount_minor::text,
                 list.parameters -> 'sellerTaxPolicy' AS policy
          FROM price_snapshots snapshot
          JOIN price_lists list ON list.id = snapshot.price_list_id
          WHERE snapshot.id = '81000000-0000-4000-8000-000000000001'
        `)
      ).rows,
    ).toEqual([
      {
        tax_regime: "NON_VAT_PAYER",
        vat_rate_basis_points: 0,
        net_amount_minor: "12345",
        vat_amount_minor: "0",
        policy: { regime: "NON_VAT_PAYER", vatRateBasisPoints: 0 },
      },
    ]);
  } finally {
    await target?.end().catch(() => undefined);
    await admin.query(
      `DROP DATABASE IF EXISTS ${databaseIdentifier(databaseName)} WITH (FORCE)`,
    );
    await admin.end();
  }
}, 30_000);
