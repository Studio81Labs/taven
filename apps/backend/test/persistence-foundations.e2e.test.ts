import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { PersistenceFactory } from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const testScope = `persistence-foundations-${randomUUID()}`;
let pool: Pool;

function factory(client: PoolClient, name: string): PersistenceFactory {
  return new PersistenceFactory(client, `${testScope}:${name}`);
}

async function inRollbackTransaction<T>(
  name: string,
  work: (client: PoolClient, fixtures: PersistenceFactory) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    return await work(client, factory(client, name));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

describe("persistence foundations", () => {
  beforeAll(() => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for persistence E2E tests");
    }
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("has every resource-foundation table after migration", async () => {
    const result = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
      [
        [
          "revision_identities",
          "model_files",
          "model_geometries",
          "preflight_findings",
          "photo_assets",
          "print_config_revisions",
          "reference_profiles",
          "machine_capabilities",
          "machine_profiles",
          "nodes",
          "machines",
          "machine_calibrations",
          "inventories",
          "slice_results",
          "candidate_resource_estimates",
          "candidate_capacity_intervals",
          "eligibility_snapshots",
          "phase_resource_plans",
          "phase_resource_plan_jobs",
          "phase_resource_plan_slots",
          "phase_reservation_sets",
          "production_reservations",
          "inventory_reservations",
          "capacity_reservations",
          "outbox_messages",
          "idempotency_records",
        ],
      ],
    );

    expect(new Set(result.rows.map((row) => row.tablename))).toEqual(
      new Set([
        "revision_identities",
        "model_files",
        "model_geometries",
        "preflight_findings",
        "photo_assets",
        "print_config_revisions",
        "reference_profiles",
        "machine_capabilities",
        "machine_profiles",
        "nodes",
        "machines",
        "machine_calibrations",
        "inventories",
        "slice_results",
        "candidate_resource_estimates",
        "candidate_capacity_intervals",
        "eligibility_snapshots",
        "phase_resource_plans",
        "phase_resource_plan_jobs",
        "phase_resource_plan_slots",
        "phase_reservation_sets",
        "production_reservations",
        "inventory_reservations",
        "capacity_reservations",
        "outbox_messages",
        "idempotency_records",
      ]),
    );
  });

  it("seeds the Prague H2S foundation and immutable active revisions", async () => {
    const machine = await pool.query<{
      code: string;
      installed_nozzle_micrometers: number;
      build_volume_x_micrometers: string;
      build_volume_y_micrometers: string;
      build_volume_z_micrometers: string;
    }>(
      'SELECT machine."code", machine."installed_nozzle_micrometers", capability."build_volume_x_micrometers", capability."build_volume_y_micrometers", capability."build_volume_z_micrometers" FROM "nodes" node JOIN "machines" machine ON machine."node_id" = node."id" JOIN "machine_capabilities" capability ON capability."id" = machine."machine_capability_id" WHERE node."code" = $1 AND machine."code" = $2',
      ["PRG-01", "H2S-01"],
    );
    expect(machine.rows).toEqual([
      {
        code: "H2S-01",
        installed_nozzle_micrometers: 400,
        build_volume_x_micrometers: "340000",
        build_volume_y_micrometers: "320000",
        build_volume_z_micrometers: "340000",
      },
    ]);
    const inventories = await pool.query<{
      material: string;
      currency: string;
      machine_code: string;
    }>(
      'SELECT inventory."material"::text AS material, inventory."currency", machine."code" AS machine_code FROM "inventories" inventory JOIN "machines" machine ON machine."id" = inventory."machine_id" AND machine."node_id" = inventory."node_id" WHERE machine."code" = $1 ORDER BY inventory."material"',
      ["H2S-01"],
    );
    expect(inventories.rows).toEqual([
      { material: "PLA", currency: "CZK", machine_code: "H2S-01" },
      { material: "PETG", currency: "CZK", machine_code: "H2S-01" },
    ]);
    const revisions = await pool.query<{
      kind: string;
      infill_percent: number | null;
      state: string | null;
    }>(
      'SELECT identity."kind"::text AS kind, config."infill_percent", NULL::text AS state FROM "revision_identities" identity JOIN "print_config_revisions" config ON config."id" = identity."id" WHERE identity."id" = ANY($1::uuid[]) UNION ALL SELECT identity."kind"::text AS kind, NULL::integer AS infill_percent, profile."state"::text AS state FROM "revision_identities" identity JOIN "machine_profiles" profile ON profile."id" = identity."id" WHERE identity."id" = ANY($2::uuid[]) UNION ALL SELECT identity."kind"::text AS kind, NULL::integer AS infill_percent, calibration."state"::text AS state FROM "revision_identities" identity JOIN "machine_calibrations" calibration ON calibration."id" = identity."id" WHERE identity."id" = $3::uuid',
      [
        [
          "91111111-1111-4111-8111-111111111111",
          "92222222-2222-4222-8222-222222222222",
          "93333333-3333-4333-8333-333333333333",
        ],
        [
          "71111111-1111-4111-8111-111111111111",
          "72222222-2222-4111-8111-111111111111",
        ],
        "83333333-3333-4333-8333-333333333333",
      ],
    );
    expect(
      revisions.rows
        .filter((row) => row.kind === "PRINT_CONFIG")
        .map((row) => row.infill_percent)
        .sort(),
    ).toEqual([10, 20, 40]);
    expect(
      revisions.rows
        .filter((row) => row.kind !== "PRINT_CONFIG")
        .every((row) => row.state === "ACTIVE"),
    ).toBe(true);
    await inRollbackTransaction("seed-immutable", async (client) => {
      await expect(
        client.query(
          'UPDATE "print_config_revisions" SET "infill_percent" = 11 WHERE "id" = $1',
          ["91111111-1111-4111-8111-111111111111"],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("enforces asset deadline checks and geometry source lineage", async () => {
    await inRollbackTransaction(
      "model-file-deadline",
      async (client, fixtures) => {
        await expect(
          client.query(
            'INSERT INTO "model_files" ("id", "format", "original_filename", "storage_object_key", "content_hash", "size_bytes", "uploaded_at", "source_delete_after") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              fixtures.id("file"),
              "STL",
              "late.stl",
              `models/${fixtures.id("file")}`,
              "b".repeat(64),
              1,
              new Date("2026-08-27T12:00:00.000Z"),
              new Date("2026-08-27T11:59:59.000Z"),
            ],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      },
    );
    await inRollbackTransaction("photo-deadline", async (client, fixtures) => {
      await expect(
        client.query(
          'INSERT INTO "photo_assets" ("id", "kind", "scope_kind", "scope_id", "storage_object_key", "content_hash", "media_type", "size_bytes", "uploaded_at", "photo_delete_after") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            fixtures.id("photo"),
            "QC",
            "JOB",
            fixtures.id("future-job"),
            `photos/${fixtures.id("photo")}`,
            "c".repeat(64),
            "image/png",
            1,
            new Date("2026-08-27T12:00:00.000Z"),
            new Date("2026-08-27T11:59:59.000Z"),
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    await inRollbackTransaction(
      "geometry-lineage",
      async (client, fixtures) => {
        await expect(
          client.query(
            'INSERT INTO "model_geometries" ("id", "source_model_file_id", "canonical_object_key", "geometry_hash", "canonicalizer_revision", "volume_cubic_micrometers", "bounds_x_micrometers", "bounds_y_micrometers", "bounds_z_micrometers", "triangle_count") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              fixtures.id("geometry"),
              fixtures.id("missing-file"),
              `canonical/${fixtures.id("geometry")}`,
              "d".repeat(64),
              "test",
              1,
              1,
              1,
              1,
              1,
            ],
          ),
        ).rejects.toMatchObject({ code: "23503" });
      },
    );
  });

  it("allows identical canonical geometry under distinct source files", async () => {
    await inRollbackTransaction(
      "duplicate-geometry-hash",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const existing = await client.query<{ geometry_hash: string }>(
          'SELECT "geometry_hash" FROM "model_geometries" WHERE "id" = $1',
          [foundation.modelGeometryId],
        );
        const geometryHash = existing.rows[0]?.geometry_hash;
        if (!geometryHash) {
          throw new Error("foundation geometry hash was not persisted");
        }

        const secondFileId = fixtures.id("second-model-file");
        await client.query(
          'INSERT INTO "model_files" ("id", "format", "original_filename", "storage_object_key", "content_hash", "size_bytes", "uploaded_at", "source_delete_after") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            secondFileId,
            "STEP",
            "same-body.step",
            `models/${secondFileId}`,
            "f".repeat(64),
            1,
            new Date("2026-08-27T12:00:00.000Z"),
            new Date("2030-08-27T12:00:00.000Z"),
          ],
        );
        await client.query(
          'INSERT INTO "model_geometries" ("id", "source_model_file_id", "canonical_object_key", "geometry_hash", "canonicalizer_revision", "volume_cubic_micrometers", "bounds_x_micrometers", "bounds_y_micrometers", "bounds_z_micrometers", "triangle_count") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            fixtures.id("second-geometry"),
            secondFileId,
            `canonical/${fixtures.id("second-geometry")}`,
            geometryHash,
            "test",
            1,
            1,
            1,
            1,
            1,
          ],
        );

        const matching = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "model_geometries" WHERE "geometry_hash" = $1',
          [geometryHash],
        );
        expect(matching.rows).toEqual([{ count: "2" }]);
      },
    );
  });

  it("requires matching revision identity kinds and immutable payloads", async () => {
    await inRollbackTransaction("revision-kind", async (client, fixtures) => {
      const revisionId = fixtures.id("revision");
      await fixtures.createRevisionIdentity(revisionId, "PRINT_CONFIG");
      await expect(
        client.query(
          'INSERT INTO "reference_profiles" ("id", "material", "quality", "slicer_engine", "slicer_version", "settings") VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
          [revisionId, "PLA", "STANDARD", "orca", "test", JSON.stringify({})],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "revision_identity_kind_check",
      });
    });
    await inRollbackTransaction(
      "revision-immutable",
      async (client, fixtures) => {
        const revisionId = fixtures.id("revision");
        await fixtures.createRevisionIdentity(revisionId, "PRINT_CONFIG");
        await expect(
          client.query(
            'UPDATE "revision_identities" SET "digest" = $2 WHERE "id" = $1',
            [revisionId, "e".repeat(64)],
          ),
        ).rejects.toMatchObject({ code: "55000" });
      },
    );
  });

  it("rejects records that combine a node with another node's machine", async () => {
    await inRollbackTransaction("node-scoping", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation();
      const otherNodeId = fixtures.id("other-node");
      const calibrationId = fixtures.id("foreign-calibration");
      await client.query(
        'INSERT INTO "nodes" ("id", "code", "name", "time_zone", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6)',
        [
          otherNodeId,
          `other-${fixtures.id("other-node").slice(0, 24)}`,
          "Other node",
          "UTC",
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      await fixtures.createRevisionIdentity(
        calibrationId,
        "MACHINE_CALIBRATION",
      );

      await expect(
        client.query(
          'INSERT INTO "machine_calibrations" ("id", "node_id", "machine_id", "flow_ratio_parts_per_million", "xy_compensation_micrometers", "elephant_foot_compensation_micrometers", "settings") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
          [
            calibrationId,
            otherNodeId,
            foundation.machineId,
            1_000_000,
            0,
            0,
            JSON.stringify({}),
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("rejects candidate profiles that do not match the concrete machine", async () => {
    await inRollbackTransaction(
      "candidate-nozzle-mismatch",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        await client.query(
          'UPDATE "machines" SET "installed_nozzle_micrometers" = $2 WHERE "id" = $1',
          [foundation.machineId, 600],
        );

        await expect(
          fixtures.planProduction(foundation, "wrong-nozzle"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "candidate_resource_compatibility_check",
        });
      },
    );
    await inRollbackTransaction(
      "candidate-capability-mismatch",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const otherCapabilityId = fixtures.id("other-capability");
        await client.query(
          'INSERT INTO "machine_capabilities" ("id", "capability_key", "manufacturer", "model", "build_volume_x_micrometers", "build_volume_y_micrometers", "build_volume_z_micrometers", "supported_nozzle_micrometers", "supported_materials") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            otherCapabilityId,
            `other-${otherCapabilityId}`,
            "Other manufacturer",
            "Other model",
            200_000,
            200_000,
            200_000,
            [400],
            ["PLA"],
          ],
        );
        await client.query(
          'UPDATE "machines" SET "machine_capability_id" = $2 WHERE "id" = $1',
          [foundation.machineId, otherCapabilityId],
        );

        await expect(
          fixtures.planProduction(foundation, "wrong-capability"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "candidate_resource_compatibility_check",
        });
      },
    );
  });

  it("allows adjacent capacity reservations but rejects active overlaps", async () => {
    await inRollbackTransaction("capacity", async (client, fixtures) => {
      const startsAt = new Date("2027-01-01T10:00:00.000Z");
      const endsAt = new Date("2027-01-01T11:00:00.000Z");
      const { foundation, productions } = await fixtures.createReservationGraph(
        "capacity",
        [
          { startsAt, endsAt },
          {
            startsAt: endsAt,
            endsAt: new Date("2027-01-01T12:00:00.000Z"),
          },
        ],
      );
      const [first, adjacent] = productions;
      if (!first || !adjacent) {
        throw new Error(
          "capacity graph did not create both production fixtures",
        );
      }
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("first-capacity"),
          foundation.nodeId,
          first.productionReservationId,
          first.candidateCapacityIntervalId,
          foundation.machineId,
          startsAt,
          endsAt,
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("adjacent-capacity"),
          foundation.nodeId,
          adjacent.productionReservationId,
          adjacent.candidateCapacityIntervalId,
          foundation.machineId,
          endsAt,
          new Date("2027-01-01T12:00:00.000Z"),
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
    });
    await inRollbackTransaction(
      "capacity-overlap",
      async (client, fixtures) => {
        const startsAt = new Date("2027-01-01T10:00:00.000Z");
        const endsAt = new Date("2027-01-01T11:00:00.000Z");
        const { foundation, productions } =
          await fixtures.createReservationGraph("capacity-overlap", [
            { startsAt, endsAt },
            {
              startsAt: new Date("2027-01-01T10:30:00.000Z"),
              endsAt: new Date("2027-01-01T11:30:00.000Z"),
            },
          ]);
        const [first, overlapping] = productions;
        if (!first || !overlapping) {
          throw new Error(
            "capacity graph did not create both production fixtures",
          );
        }
        await client.query(
          'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            fixtures.id("first-capacity"),
            foundation.nodeId,
            first.productionReservationId,
            first.candidateCapacityIntervalId,
            foundation.machineId,
            new Date("2027-01-01T10:00:00.000Z"),
            new Date("2027-01-01T11:00:00.000Z"),
            new Date("2030-08-27T12:00:00.000Z"),
            new Date("2026-08-27T12:00:00.000Z"),
            new Date("2026-08-27T12:00:00.000Z"),
          ],
        );
        await expect(
          client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              fixtures.id("overlapping-capacity"),
              foundation.nodeId,
              overlapping.productionReservationId,
              overlapping.candidateCapacityIntervalId,
              foundation.machineId,
              new Date("2027-01-01T10:30:00.000Z"),
              new Date("2027-01-01T11:30:00.000Z"),
              new Date("2030-08-27T12:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
            ],
          ),
        ).rejects.toMatchObject({
          code: "23P01",
          constraint: "capacity_reservations_no_active_overlap",
        });
      },
    );
  });

  it("does not let concurrent inventory reservation inserts oversubscribe", async () => {
    const setup = await pool.connect();
    const setupFactory = factory(setup, "inventory-concurrency");
    let firstReservationId: string | undefined;
    try {
      const { foundation, productions } =
        await setupFactory.createReservationGraph("inventory-concurrency", [
          {
            startsAt: new Date("2027-01-01T10:00:00.000Z"),
            endsAt: new Date("2027-01-01T11:00:00.000Z"),
          },
          {
            startsAt: new Date("2027-01-01T11:00:00.000Z"),
            endsAt: new Date("2027-01-01T12:00:00.000Z"),
          },
        ]);
      const [first, second] = productions;
      if (!first || !second) {
        throw new Error(
          "inventory graph did not create both production fixtures",
        );
      }
      const reserve = async (
        productionReservationId: string,
        reservationId: string,
      ) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              reservationId,
              foundation.nodeId,
              productionReservationId,
              foundation.inventoryId,
              60,
              new Date("2030-08-27T12:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
            ],
          );
          await client.query("COMMIT");
          return reservationId;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };

      const attempts = await Promise.allSettled([
        reserve(first.productionReservationId, first.inventoryReservationId),
        reserve(second.productionReservationId, second.inventoryReservationId),
      ]);
      const successes = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<string> =>
          attempt.status === "fulfilled",
      );

      expect(successes).toHaveLength(1);
      firstReservationId = successes[0]?.value;
      expect(
        await setup.query<{ reserved_milligrams: string }>(
          'SELECT "reserved_milligrams" FROM "inventories" WHERE "id" = $1',
          [foundation.inventoryId],
        ),
      ).toMatchObject({ rows: [{ reserved_milligrams: "60" }] });
    } finally {
      if (firstReservationId) {
        await setup.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [firstReservationId, "RELEASED"],
        );
      }
      setup.release();
    }
  });

  it("rejects direct writes to the maintained inventory reservation counter", async () => {
    await inRollbackTransaction(
      "inventory-counter-write",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        await client.query(
          'UPDATE "inventories" SET "reserved_milligrams" = 1 WHERE "id" = $1',
          [foundation.inventoryId],
        );

        await expect(
          client.query(
            'SET CONSTRAINTS "inventories_reserved_counter_matches_reservations" IMMEDIATE',
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "inventory_reserved_counter_matches_reservations_check",
        });
      },
    );
  });

  it("cannot reserve a multi-plate candidate until every interval is reserved", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = factory(client, "multi-plate");
      const foundation = await fixtures.createFoundation("multi-plate");
      const production = await fixtures.planProduction(
        foundation,
        "multi-production",
        [
          {
            startsAt: new Date("2027-01-01T10:00:00.000Z"),
            endsAt: new Date("2027-01-01T11:00:00.000Z"),
          },
          {
            startsAt: new Date("2027-01-01T11:00:00.000Z"),
            endsAt: new Date("2027-01-01T12:00:00.000Z"),
          },
        ],
      );
      await fixtures.createResourcePlan(foundation, [production]);
      await fixtures.createPhaseReservationSet(foundation);
      await fixtures.createProductionReservation(foundation, production);
      await client.query(
        'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      const firstIntervalId = production.candidateCapacityIntervalIds[0];
      if (!firstIntervalId) {
        throw new Error(
          "multi-plate fixture did not create its first interval",
        );
      }
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("first-plate-capacity"),
          foundation.nodeId,
          production.productionReservationId,
          firstIntervalId,
          foundation.machineId,
          new Date("2027-01-01T10:00:00.000Z"),
          new Date("2027-01-01T11:00:00.000Z"),
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_complete_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("freezes plan membership once a reservation set exists", async () => {
    await inRollbackTransaction(
      "plan-membership-freeze",
      async (client, fixtures) => {
        const { foundation, productions } =
          await fixtures.createReservationGraph("graph");
        const production = productions[0];
        if (!production) {
          throw new Error(
            "reservation graph did not create a production fixture",
          );
        }
        await expect(
          client.query(
            'INSERT INTO "phase_resource_plan_jobs" ("id", "node_id", "phase_resource_plan_id", "candidate_resource_estimate_id", "planned_job_key") VALUES ($1, $2, $3, $4, $5)',
            [
              fixtures.id("late-plan-job"),
              foundation.nodeId,
              foundation.phaseResourcePlanId,
              production.candidateResourceEstimateId,
              "late-plan-membership",
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_resource_plan_membership_frozen_check",
        });
      },
    );
  });

  it("serializes plan membership changes with reservation creation", async () => {
    const setup = await pool.connect();
    const reserving = await pool.connect();
    const competing = await pool.connect();
    try {
      const scope = "plan-membership-concurrency";
      const setupFixtures = factory(setup, scope);
      const foundation = await setupFixtures.createFoundation(scope);
      const production = await setupFixtures.planProduction(
        foundation,
        "initial-production",
      );
      await setupFixtures.createResourcePlan(foundation, [production]);

      await reserving.query("BEGIN");
      await factory(reserving, scope).createPhaseReservationSet(foundation);

      await competing.query("BEGIN");
      await competing.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        competing.query(
          'INSERT INTO "phase_resource_plan_jobs" ("id", "node_id", "phase_resource_plan_id", "candidate_resource_estimate_id", "planned_job_key") VALUES ($1, $2, $3, $4, $5)',
          [
            setupFixtures.id("concurrent-plan-job"),
            foundation.nodeId,
            foundation.phaseResourcePlanId,
            production.candidateResourceEstimateId,
            "concurrent-plan-membership",
          ],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await reserving.query("ROLLBACK").catch(() => undefined);
      await competing.query("ROLLBACK").catch(() => undefined);
      setup.release();
      reserving.release();
      competing.release();
    }
  });

  it("rejects reservation sets outside their plan validity window", async () => {
    await inRollbackTransaction(
      "expired-reservation-plan",
      async (_client, fixtures) => {
        const planCreatedAt = new Date(Date.now() - 120_000);
        const planExpiresAt = new Date(Date.now() - 60_000);
        const foundation = await fixtures.createFoundation("expired-plan");
        const production = await fixtures.planProduction(
          foundation,
          "expired-plan-production",
        );
        await fixtures.createResourcePlan(
          foundation,
          [production],
          planExpiresAt,
          planCreatedAt,
        );

        await expect(
          fixtures.createPhaseReservationSet(
            foundation,
            planExpiresAt,
            "BUILDING",
            planCreatedAt,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_plan_expiry_check",
        });
      },
    );
    await inRollbackTransaction(
      "reservation-beyond-plan",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation("future-plan");
        const production = await fixtures.planProduction(
          foundation,
          "future-plan-production",
        );
        await fixtures.createResourcePlan(foundation, [production]);

        await expect(
          fixtures.createPhaseReservationSet(
            foundation,
            new Date("2030-08-27T12:00:01.000Z"),
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_plan_expiry_check",
        });
      },
    );
  });

  it("requires resource children to share the production expiry", async () => {
    await inRollbackTransaction(
      "inventory-expiry-mismatch",
      async (client, fixtures) => {
        const { foundation, productions } =
          await fixtures.createReservationGraph("inventory-expiry-mismatch");
        const production = productions[0];
        if (!production) {
          throw new Error(
            "reservation graph did not create a production fixture",
          );
        }

        await expect(
          client.query(
            'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              production.inventoryReservationId,
              foundation.nodeId,
              production.productionReservationId,
              foundation.inventoryId,
              60,
              new Date("2030-08-27T11:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "inventory_reservation_production_inventory_check",
        });
      },
    );
    await inRollbackTransaction(
      "capacity-expiry-mismatch",
      async (client, fixtures) => {
        const { foundation, productions } =
          await fixtures.createReservationGraph("capacity-expiry-mismatch");
        const production = productions[0];
        if (!production) {
          throw new Error(
            "reservation graph did not create a production fixture",
          );
        }

        await expect(
          client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              fixtures.id("mismatched-expiry-capacity"),
              foundation.nodeId,
              production.productionReservationId,
              production.candidateCapacityIntervalId,
              foundation.machineId,
              new Date("2027-01-01T10:00:00.000Z"),
              new Date("2027-01-01T11:00:00.000Z"),
              new Date("2030-08-27T11:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "capacity_reservation_production_binding_check",
        });
      },
    );
  });

  it("cannot commit an incomplete RESERVED phase reservation set", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = factory(client, "incomplete-reserved-set");
      const { foundation } = await fixtures.createReservationGraph(
        "incomplete-reserved-set",
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_complete_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("cannot commit an incomplete HELD phase reservation set", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = factory(client, "incomplete-held-set");
      const { foundation, productions } = await fixtures.createReservationGraph(
        "incomplete-held-set",
      );
      const production = productions[0];
      if (!production) {
        throw new Error(
          "reservation graph did not create a production fixture",
        );
      }
      await client.query(
        'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("held-capacity"),
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          new Date("2027-01-01T10:00:00.000Z"),
          new Date("2027-01-01T11:00:00.000Z"),
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [production.productionReservationId, "HELD"],
      );
      await client.query(
        'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
        [production.inventoryReservationId, "HELD"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [fixtures.id("held-capacity"), "HELD"],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "HELD"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [fixtures.id("held-capacity"), "RELEASED"],
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_complete_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("revalidates child changes after a HELD set was committed", async () => {
    const client = await pool.connect();
    let heldCommitted = false;
    const fixtures = factory(client, "committed-held-set");
    let foundation: Awaited<
      ReturnType<PersistenceFactory["createFoundation"]>
    > | null = null;
    let production: Awaited<
      ReturnType<PersistenceFactory["planProduction"]>
    > | null = null;
    const capacityReservationId = fixtures.id("held-capacity");
    try {
      await client.query("BEGIN");
      const graph = await fixtures.createReservationGraph("committed-held-set");
      foundation = graph.foundation;
      production = graph.productions[0] ?? null;
      if (!production) {
        throw new Error(
          "reservation graph did not create a production fixture",
        );
      }
      await client.query(
        'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          capacityReservationId,
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          new Date("2027-01-01T10:00:00.000Z"),
          new Date("2027-01-01T11:00:00.000Z"),
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [production.productionReservationId, "HELD"],
      );
      await client.query(
        'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
        [production.inventoryReservationId, "HELD"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [capacityReservationId, "HELD"],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "HELD"],
      );
      await client.query("COMMIT");
      heldCommitted = true;

      await client.query("BEGIN");
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [capacityReservationId, "RELEASED"],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_complete_check",
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RELEASED"],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_terminal_children_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      if (heldCommitted && foundation && production) {
        await client.query("BEGIN");
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RELEASED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.inventoryReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [capacityReservationId, "RELEASED"],
        );
        await client.query("COMMIT");
      }
      client.release();
    }
  });

  it("requires reservation rows to start at their lifecycle entry states", async () => {
    await inRollbackTransaction(
      "initial-phase-set-status",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "initial-phase-set-status",
        );
        const production = await fixtures.planProduction(
          foundation,
          "production",
        );
        await fixtures.createResourcePlan(foundation, [production]);

        await expect(
          fixtures.createPhaseReservationSet(
            foundation,
            new Date("2030-08-27T12:00:00.000Z"),
            "HELD",
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "reservation_lifecycle_initial_state_check",
        });
      },
    );

    await inRollbackTransaction(
      "initial-production-status",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "initial-production-status",
        );
        const production = await fixtures.planProduction(
          foundation,
          "production",
        );
        await fixtures.createResourcePlan(foundation, [production]);
        await fixtures.createPhaseReservationSet(foundation);

        await expect(
          fixtures.createProductionReservation(
            foundation,
            production,
            "SCHEDULED",
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "reservation_lifecycle_initial_state_check",
        });
      },
    );

    await inRollbackTransaction(
      "initial-capacity-status",
      async (client, fixtures) => {
        const { foundation, productions } =
          await fixtures.createReservationGraph("initial-capacity-status");
        const production = productions[0];
        if (!production) {
          throw new Error(
            "reservation graph did not create a production fixture",
          );
        }

        await expect(
          client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "status", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
            [
              fixtures.id("initial-capacity"),
              foundation.nodeId,
              production.productionReservationId,
              production.candidateCapacityIntervalId,
              foundation.machineId,
              new Date("2027-01-01T10:00:00.000Z"),
              new Date("2027-01-01T11:00:00.000Z"),
              "PRINTING",
              new Date("2030-08-27T12:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
              new Date("2026-08-27T12:00:00.000Z"),
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "reservation_lifecycle_initial_state_check",
        });
      },
    );
  });

  it("keeps a completed idempotency result immutable", async () => {
    const insertCompletedRecord = async (
      client: PoolClient,
      fixtures: PersistenceFactory,
    ): Promise<string> => {
      const id = fixtures.id("completed-idempotency-record");
      await client.query(
        'INSERT INTO "idempotency_records" ("id", "namespace", "idempotency_key", "request_fingerprint", "status", "response_status_code", "response_body", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)',
        [
          id,
          "test-command",
          `idempotency-${fixtures.id("key")}`,
          "b".repeat(64),
          "COMPLETED",
          201,
          JSON.stringify({ result: "original" }),
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      return id;
    };

    await inRollbackTransaction(
      "rewind-completed-idempotency",
      async (client, fixtures) => {
        const id = await insertCompletedRecord(client, fixtures);
        await expect(
          client.query(
            'UPDATE "idempotency_records" SET "status" = $2, "response_status_code" = NULL, "response_body" = NULL WHERE "id" = $1',
            [id, "PROCESSING"],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "idempotency_records_completed_result_immutable_check",
        });
      },
    );

    await inRollbackTransaction(
      "replace-completed-idempotency",
      async (client, fixtures) => {
        const id = await insertCompletedRecord(client, fixtures);
        await expect(
          client.query(
            'UPDATE "idempotency_records" SET "response_body" = $2::jsonb WHERE "id" = $1',
            [id, JSON.stringify({ result: "replacement" })],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "idempotency_records_completed_result_immutable_check",
        });
      },
    );
  });

  it("rejects active children added after a reservation set is terminal", async () => {
    const client = await pool.connect();
    const fixtures = factory(client, "terminal-set-late-children");
    try {
      await client.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "terminal-set-late-children",
      );
      const production = await fixtures.planProduction(
        foundation,
        "production",
      );
      await fixtures.createResourcePlan(foundation, [production]);
      await fixtures.createPhaseReservationSet(foundation);
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RELEASED"],
      );
      await client.query("COMMIT");

      await client.query("BEGIN");
      await fixtures.createProductionReservation(foundation, production);
      await client.query(
        'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("late-capacity"),
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          new Date("2027-01-01T10:00:00.000Z"),
          new Date("2027-01-01T11:00:00.000Z"),
          new Date("2030-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
          new Date("2026-08-27T12:00:00.000Z"),
        ],
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_terminal_children_check",
      });
      await client.query("ROLLBACK");

      const inventory = await client.query<{ reserved_milligrams: string }>(
        'SELECT "reserved_milligrams" FROM "inventories" WHERE "id" = $1',
        [foundation.inventoryId],
      );
      expect(inventory.rows[0]?.reserved_milligrams).toBe("0");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
