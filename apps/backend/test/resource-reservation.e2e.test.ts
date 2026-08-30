import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { EligibilityPlanService } from "../src/modules/resources/eligibility-plan.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { PersistenceFactory } from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const testScope = `resource-reservation-${randomUUID()}`;
let pool: Pool;
let prisma: PrismaService;
let eligibility: EligibilityPlanService;

async function inRollbackTransaction<T>(
  name: string,
  work: (client: PoolClient, fixtures: PersistenceFactory) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    return await work(
      client,
      new PersistenceFactory(client, `${testScope}:${name}`),
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function reserveAndCommit(
  nodeId: string,
  phaseResourcePlanId: string,
  reservationKey: string,
): Promise<string> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    const result = await client.query<{
      phase_reservation_set_id: string;
    }>("SELECT * FROM taven_create_phase_reservation($1, $2, $3)", [
      nodeId,
      phaseResourcePlanId,
      reservationKey,
    ]);
    await client.query("COMMIT");
    const reservationSetId = result.rows[0]?.phase_reservation_set_id;
    if (!reservationSetId) throw new Error("reservation returned no set");
    return reservationSetId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("phase resource reservation execution", () => {
  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for reservation e2e tests");
    }
    pool = new Pool({ connectionString: databaseUrl });
    prisma = new PrismaService();
    await prisma.onModuleInit();
    eligibility = new EligibilityPlanService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await pool.end();
  });

  it("persists a complete live eligibility plan through the backend service", async () => {
    const setupClient = await pool.connect();
    await setupClient.query("BEGIN");
    let nodeId: string;
    let orderPhaseId: string;
    let candidateId: string;
    try {
      const fixtures = new PersistenceFactory(
        setupClient,
        `${testScope}:eligibility-service`,
      );
      const foundation = await fixtures.createFoundation("eligibility-service");
      const now = new Date();
      const production = await fixtures.planProduction(
        foundation,
        "eligibility-service-production",
        {
          startsAt: new Date(now.getTime() + 60 * 60 * 1_000),
          endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
        },
      );
      await setupClient.query(
        'UPDATE "inventories" SET "remaining_milligrams" = 1_000 WHERE "id" = $1',
        [foundation.inventoryId],
      );
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
      nodeId = foundation.nodeId;
      orderPhaseId = foundation.orderPhaseId;
      candidateId = production.candidateResourceEstimateId;
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }

    const planKey = `eligibility:${testScope}`;
    const [created, replay] = await Promise.all([
      eligibility.createCompletePlan({
        nodeId,
        orderPhaseId,
        planKey,
      }),
      eligibility.createCompletePlan({
        nodeId,
        orderPhaseId,
        planKey,
      }),
    ]);
    expect(replay).toEqual(created);
    expect(created.candidateResourceEstimateIds).toEqual([candidateId]);
    expect(created.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 15 * 60 * 1_000,
    );

    const topology = await pool.query<{
      job_count: string;
      slot_count: string;
      snapshot_candidate_ids: string[];
    }>(
      `SELECT count(DISTINCT plan_job.id)::text AS job_count,
              count(DISTINCT plan_slot.id)::text AS slot_count,
              snapshot.eligible_candidate_estimate_ids AS snapshot_candidate_ids
       FROM phase_resource_plans plan
       JOIN eligibility_snapshots snapshot
         ON snapshot.id = plan.eligibility_snapshot_id
        AND snapshot.node_id = plan.node_id
       JOIN phase_resource_plan_jobs plan_job
         ON plan_job.phase_resource_plan_id = plan.id
       JOIN phase_resource_plan_slots plan_slot
         ON plan_slot.phase_resource_plan_id = plan.id
       WHERE plan.id = $1
       GROUP BY snapshot.eligible_candidate_estimate_ids`,
      [created.phaseResourcePlanId],
    );
    expect(topology.rows).toEqual([
      {
        job_count: "1",
        slot_count: "1",
        snapshot_candidate_ids: [candidateId],
      },
    ]);

    await expect(
      eligibility.createCompletePlan({ nodeId, orderPhaseId, planKey }),
    ).resolves.toEqual(created);
  });

  it("requires unheld candidate sources through the latest capacity interval", async () => {
    const setupClient = await pool.connect();
    await setupClient.query("BEGIN");
    let nodeId: string;
    let orderPhaseId: string;
    try {
      const fixtures = new PersistenceFactory(
        setupClient,
        `${testScope}:eligibility-source-horizon`,
      );
      const foundation = await fixtures.createFoundation(
        "eligibility-source-horizon",
        {
          deleteAfter: new Date(Date.now() + 105 * 60 * 1_000),
          quoteExpiresAt: new Date(
            Date.now() + 105 * 60 * 1_000 - 90 * 24 * 60 * 60 * 1_000,
          ),
        },
      );
      const now = new Date();
      await fixtures.planProduction(
        foundation,
        "eligibility-source-horizon-production",
        [
          {
            startsAt: new Date(now.getTime() + 60 * 60 * 1_000),
            endsAt: new Date(now.getTime() + 90 * 60 * 1_000),
          },
          {
            startsAt: new Date(now.getTime() + 90 * 60 * 1_000),
            endsAt: new Date(now.getTime() + 120 * 60 * 1_000),
          },
        ],
      );
      await setupClient.query(
        'UPDATE "inventories" SET "remaining_milligrams" = 1_000 WHERE "id" = $1',
        [foundation.inventoryId],
      );
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
      nodeId = foundation.nodeId;
      orderPhaseId = foundation.orderPhaseId;
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }

    await expect(
      eligibility.createCompletePlan({
        nodeId,
        orderPhaseId,
        planKey: `eligibility-source-horizon:${testScope}`,
      }),
    ).rejects.toMatchObject({
      message: "no complete machine-specific resource plan covers the phase",
    });
  });

  it("combines partial candidate jobs to cover every slot of one item", async () => {
    const setupClient = await pool.connect();
    await setupClient.query("BEGIN");
    let nodeId: string;
    let orderPhaseId: string;
    let candidateIds: string[];
    try {
      const fixtures = new PersistenceFactory(
        setupClient,
        `${testScope}:split-item-eligibility`,
      );
      const foundation = await fixtures.createFoundation(
        "split-item-eligibility",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ quantity: 2 }],
      );
      const now = new Date();
      const first = await fixtures.planProduction(
        foundation,
        "split-item-first-production",
        {
          startsAt: new Date(now.getTime() + 60 * 60 * 1_000),
          endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
        },
        60,
        60,
        1,
        0,
      );
      const second = await fixtures.planProduction(
        foundation,
        "split-item-second-production",
        {
          startsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
          endsAt: new Date(now.getTime() + 3 * 60 * 60 * 1_000),
        },
        60,
        60,
        1,
        1,
      );
      await setupClient.query(
        'UPDATE "inventories" SET "remaining_milligrams" = 1_000 WHERE "id" = $1',
        [foundation.inventoryId],
      );
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
      nodeId = foundation.nodeId;
      orderPhaseId = foundation.orderPhaseId;
      candidateIds = [
        first.candidateResourceEstimateId,
        second.candidateResourceEstimateId,
      ].sort();
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }

    const created = await eligibility.createCompletePlan({
      nodeId,
      orderPhaseId,
      planKey: `split-item-eligibility:${testScope}`,
    });
    expect(created.candidateResourceEstimateIds).toEqual(candidateIds);

    const topology = await pool.query<{
      job_count: string;
      slot_count: string;
    }>(
      `SELECT count(DISTINCT plan_job.id)::text AS job_count,
              count(DISTINCT plan_slot.id)::text AS slot_count
       FROM phase_resource_plan_jobs plan_job
       JOIN phase_resource_plan_slots plan_slot
         ON plan_slot.phase_resource_plan_job_id = plan_job.id
       WHERE plan_job.phase_resource_plan_id = $1`,
      [created.phaseResourcePlanId],
    );
    expect(topology.rows).toEqual([{ job_count: "2", slot_count: "2" }]);
  });

  it("creates exactly one complete 15-minute reservation set and releases it as a whole", async () => {
    await inRollbackTransaction("atomic", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("atomic");
      const now = new Date();
      const interval = {
        startsAt: new Date(now.getTime() + 60 * 60 * 1_000),
        endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
      };
      const production = await fixtures.planProduction(
        foundation,
        "atomic-production",
        interval,
      );
      await fixtures.createResourcePlan(
        foundation,
        [production],
        new Date(now.getTime() + 30 * 60 * 1_000),
        now,
      );
      await client.query(
        'UPDATE "inventories" SET "remaining_milligrams" = 1_000 WHERE "id" = $1',
        [foundation.inventoryId],
      );

      const key = `reserve-${testScope}`;
      const first = await client.query<{
        phase_reservation_set_id: string;
        phase_reservation_set_status: string;
        expires_at: Date;
      }>("SELECT * FROM taven_create_phase_reservation($1, $2, $3)", [
        foundation.nodeId,
        foundation.phaseResourcePlanId,
        key,
      ]);
      const reserved = first.rows[0];
      expect(reserved?.phase_reservation_set_status).toBe("RESERVED");

      const replay = await client.query<{
        phase_reservation_set_id: string;
      }>("SELECT * FROM taven_create_phase_reservation($1, $2, $3)", [
        foundation.nodeId,
        foundation.phaseResourcePlanId,
        key,
      ]);
      expect(replay.rows[0]?.phase_reservation_set_id).toBe(
        reserved?.phase_reservation_set_id,
      );

      const topology = await client.query<{
        child_count: string;
        ttl_seconds: string;
        reserved_milligrams: string;
      }>(
        `SELECT
           count(production.id)::text AS child_count,
           extract(epoch FROM reservation_set.expires_at - reservation_set.created_at)::text AS ttl_seconds,
           inventory.reserved_milligrams::text AS reserved_milligrams
         FROM phase_reservation_sets reservation_set
         JOIN production_reservations production
           ON production.phase_reservation_set_id = reservation_set.id
         JOIN inventories inventory ON inventory.id = production.inventory_id
         WHERE reservation_set.id = $1
         GROUP BY reservation_set.id, inventory.reserved_milligrams`,
        [reserved?.phase_reservation_set_id],
      );
      expect(topology.rows).toEqual([
        expect.objectContaining({
          child_count: "1",
          ttl_seconds: "900.000000",
          reserved_milligrams: "60",
        }),
      ]);

      await client.query("SELECT taven_release_phase_reservation_set($1)", [
        reserved?.phase_reservation_set_id,
      ]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const terminal = await client.query<{
        set_status: string;
        production_status: string;
        inventory_status: string;
        capacity_status: string;
        reserved_milligrams: string;
      }>(
        `SELECT reservation_set.status::text AS set_status,
                production.status::text AS production_status,
                inventory_reservation.status::text AS inventory_status,
                capacity_reservation.status::text AS capacity_status,
                inventory.reserved_milligrams::text AS reserved_milligrams
         FROM phase_reservation_sets reservation_set
         JOIN production_reservations production
           ON production.phase_reservation_set_id = reservation_set.id
         JOIN inventory_reservations inventory_reservation
           ON inventory_reservation.production_reservation_id = production.id
         JOIN capacity_reservations capacity_reservation
           ON capacity_reservation.production_reservation_id = production.id
         JOIN inventories inventory ON inventory.id = production.inventory_id
         WHERE reservation_set.id = $1`,
        [reserved?.phase_reservation_set_id],
      );
      expect(terminal.rows).toEqual([
        {
          set_status: "RELEASED",
          production_status: "RELEASED",
          inventory_status: "RELEASED",
          capacity_status: "RELEASED",
          reserved_milligrams: "0",
        },
      ]);
    });
  });

  it("allows one concurrent winner for the same stock and capacity with no loser children", async () => {
    const setupClient = await pool.connect();
    await setupClient.query("BEGIN");
    let nodeId: string;
    let firstPlanId: string;
    let secondPlanId: string;
    const firstKey = `concurrent-first-${testScope}`;
    const secondKey = `concurrent-second-${testScope}`;
    try {
      const fixtures = new PersistenceFactory(
        setupClient,
        `${testScope}:concurrent`,
      );
      const foundation = await fixtures.createFoundation(
        "concurrent",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "QUOTED",
        undefined,
        {},
        "INDIVIDUAL",
      );
      await setupClient.query(
        'UPDATE "inventories" SET "remaining_milligrams" = 100 WHERE "id" = $1',
        [foundation.inventoryId],
      );
      const now = new Date();
      const production = await fixtures.planProduction(
        foundation,
        "shared-production",
        {
          startsAt: new Date(now.getTime() + 60 * 60 * 1_000),
          endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
        },
        60,
        60,
      );
      await fixtures.createResourcePlan(
        foundation,
        [production],
        new Date(now.getTime() + 30 * 60 * 1_000),
        now,
      );

      const competingFoundation = {
        ...foundation,
        eligibilitySnapshotId: fixtures.id("competing-snapshot"),
        phaseResourcePlanId: fixtures.id("competing-plan"),
      };
      const competingProduction = {
        ...production,
        phaseResourcePlanJobId: fixtures.id("competing-plan-job"),
        plannedJobKey: `planned-${fixtures.id("competing-plan-job")}`,
      };
      await fixtures.createResourcePlan(
        competingFoundation,
        [competingProduction],
        new Date(now.getTime() + 30 * 60 * 1_000),
        now,
      );
      await setupClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setupClient.query("COMMIT");
      nodeId = foundation.nodeId;
      firstPlanId = foundation.phaseResourcePlanId;
      secondPlanId = competingFoundation.phaseResourcePlanId;
    } catch (error) {
      await setupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      setupClient.release();
    }

    const attempts = await Promise.allSettled([
      reserveAndCommit(nodeId, firstPlanId, firstKey),
      reserveAndCommit(nodeId, secondPlanId, secondKey),
    ]);
    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );

    const topology = await pool.query<{
      reservation_key: string;
      set_count: string;
      production_count: string;
      inventory_count: string;
      capacity_count: string;
    }>(
      `SELECT requested.reservation_key,
              count(DISTINCT reservation_set.id)::text AS set_count,
              count(DISTINCT production.id)::text AS production_count,
              count(DISTINCT inventory_reservation.id)::text AS inventory_count,
              count(DISTINCT capacity_reservation.id)::text AS capacity_count
       FROM unnest($1::text[]) AS requested(reservation_key)
       LEFT JOIN phase_reservation_sets reservation_set
         ON reservation_set.reservation_key = requested.reservation_key
       LEFT JOIN production_reservations production
         ON production.phase_reservation_set_id = reservation_set.id
       LEFT JOIN inventory_reservations inventory_reservation
         ON inventory_reservation.production_reservation_id = production.id
       LEFT JOIN capacity_reservations capacity_reservation
         ON capacity_reservation.production_reservation_id = production.id
       GROUP BY requested.reservation_key
       ORDER BY requested.reservation_key`,
      [[firstKey, secondKey]],
    );
    expect(topology.rows.map(({ set_count }) => set_count).sort()).toEqual([
      "0",
      "1",
    ]);
    expect(
      topology.rows.map(({ production_count }) => production_count).sort(),
    ).toEqual(["0", "1"]);
    expect(
      topology.rows.map(({ inventory_count }) => inventory_count).sort(),
    ).toEqual(["0", "1"]);
    expect(
      topology.rows.map(({ capacity_count }) => capacity_count).sort(),
    ).toEqual(["0", "1"]);
  });

  it("reacquires a fresh complete set from a persisted open payment window and replays safely", async () => {
    await inRollbackTransaction("reacquire", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("reacquire");
      const now = new Date();
      const production = await fixtures.planProduction(
        foundation,
        "reacquire-production",
        {
          startsAt: new Date(now.getTime() + 60 * 60 * 1_000),
          endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
        },
      );
      await fixtures.createResourcePlan(
        foundation,
        [production],
        new Date(now.getTime() + 30 * 60 * 1_000),
        now,
      );
      await client.query(
        'UPDATE "inventories" SET "remaining_milligrams" = 1_000 WHERE "id" = $1',
        [foundation.inventoryId],
      );
      const first = await client.query<{
        phase_reservation_set_id: string;
      }>("SELECT * FROM taven_create_phase_reservation($1, $2, $3)", [
        foundation.nodeId,
        foundation.phaseResourcePlanId,
        `initial-${testScope}`,
      ]);
      const previousSetId = first.rows[0]?.phase_reservation_set_id;
      expect(previousSetId).toBeTruthy();
      await fixtures.finalizePayment(foundation);
      await client.query("SELECT taven_release_phase_reservation_set($1)", [
        previousSetId,
      ]);

      const replacementFoundation = {
        ...foundation,
        eligibilitySnapshotId: fixtures.id("reacquire-replacement-snapshot"),
        phaseResourcePlanId: fixtures.id("reacquire-replacement-plan"),
      };
      const replacementProduction = {
        ...production,
        phaseResourcePlanJobId: fixtures.id("reacquire-replacement-plan-job"),
        plannedJobKey: `planned-${fixtures.id("reacquire-replacement-plan-job")}`,
      };
      await fixtures.createResourcePlan(
        replacementFoundation,
        [replacementProduction],
        new Date(now.getTime() + 30 * 60 * 1_000),
        now,
      );

      const replacementKey = `replacement-${testScope}`;
      const replacement = await client.query<{
        phase_reservation_set_id: string;
        phase_reservation_set_status: string;
      }>(
        "SELECT * FROM taven_reacquire_phase_reservation_for_capture($1, $2, $3, $4, $5)",
        [
          previousSetId,
          foundation.nodeId,
          replacementFoundation.phaseResourcePlanId,
          replacementKey,
          foundation.paymentId,
        ],
      );
      expect(replacement.rows[0]?.phase_reservation_set_status).toBe(
        "RESERVED",
      );

      const replay = await client.query<{
        phase_reservation_set_id: string;
      }>(
        "SELECT * FROM taven_reacquire_phase_reservation_for_capture($1, $2, $3, $4, $5)",
        [
          previousSetId,
          foundation.nodeId,
          replacementFoundation.phaseResourcePlanId,
          replacementKey,
          foundation.paymentId,
        ],
      );
      expect(replay.rows[0]?.phase_reservation_set_id).toBe(
        replacement.rows[0]?.phase_reservation_set_id,
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });

  it("releases only the failed pre-print production group and preserves held siblings", async () => {
    await inRollbackTransaction(
      "pre-print-release",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "pre-print-release",
          {},
          undefined,
          undefined,
          undefined,
          2,
        );
        const now = new Date();
        const productions = [
          await fixtures.planProduction(
            foundation,
            "pre-print-first",
            {
              startsAt: new Date(now.getTime() + 60 * 60 * 1_000),
              endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
            },
            60,
            60,
            1,
            0,
          ),
          await fixtures.planProduction(
            foundation,
            "pre-print-second",
            {
              startsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
              endsAt: new Date(now.getTime() + 3 * 60 * 60 * 1_000),
            },
            60,
            60,
            1,
            1,
          ),
        ];
        await fixtures.createResourcePlan(
          foundation,
          productions,
          new Date(now.getTime() + 30 * 60 * 1_000),
          now,
        );
        await client.query(
          'UPDATE "inventories" SET "remaining_milligrams" = 1_000 WHERE "id" = $1',
          [foundation.inventoryId],
        );
        const reserved = await client.query<{
          phase_reservation_set_id: string;
        }>("SELECT * FROM taven_create_phase_reservation($1, $2, $3)", [
          foundation.nodeId,
          foundation.phaseResourcePlanId,
          `pre-print-${testScope}`,
        ]);
        const reservationSetId = reserved.rows[0]?.phase_reservation_set_id;
        expect(reservationSetId).toBeTruthy();

        await client.query(
          `UPDATE inventory_reservations inventory_reservation
         SET status = 'HELD'
         FROM production_reservations production
         WHERE production.phase_reservation_set_id = $1
           AND inventory_reservation.production_reservation_id = production.id`,
          [reservationSetId],
        );
        await client.query(
          `UPDATE capacity_reservations capacity_reservation
         SET status = 'HELD'
         FROM production_reservations production
         WHERE production.phase_reservation_set_id = $1
           AND capacity_reservation.production_reservation_id = production.id`,
          [reservationSetId],
        );
        for (const production of productions) {
          await fixtures.createJob(foundation, production);
          await client.query(
            `UPDATE production_reservations
           SET status = 'HELD', job_id = $2
           WHERE phase_reservation_set_id = $1
             AND phase_resource_plan_job_id = $3`,
            [
              reservationSetId,
              production.jobId,
              production.phaseResourcePlanJobId,
            ],
          );
        }
        await client.query(
          "UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1",
          [reservationSetId],
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

        const firstProduction = await client.query<{ id: string }>(
          `SELECT id FROM production_reservations
         WHERE phase_reservation_set_id = $1
           AND phase_resource_plan_job_id = $2`,
          [reservationSetId, productions[0]!.phaseResourcePlanJobId],
        );
        const releasedStatus = await client.query<{
          phase_reservation_set_status: string;
        }>(
          "SELECT taven_release_production_reservation_before_print($1) AS phase_reservation_set_status",
          [firstProduction.rows[0]?.id],
        );
        expect(releasedStatus.rows[0]?.phase_reservation_set_status).toBe(
          "HELD",
        );

        const topology = await client.query<{
          planned_job_key: string;
          production_status: string;
          inventory_status: string;
          capacity_status: string;
          set_status: string;
          reserved_milligrams: string;
        }>(
          `SELECT production.planned_job_key,
                production.status::text AS production_status,
                inventory_reservation.status::text AS inventory_status,
                capacity_reservation.status::text AS capacity_status,
                reservation_set.status::text AS set_status,
                inventory.reserved_milligrams::text AS reserved_milligrams
         FROM production_reservations production
         JOIN phase_reservation_sets reservation_set
           ON reservation_set.id = production.phase_reservation_set_id
         JOIN inventory_reservations inventory_reservation
           ON inventory_reservation.production_reservation_id = production.id
         JOIN capacity_reservations capacity_reservation
           ON capacity_reservation.production_reservation_id = production.id
         JOIN inventories inventory ON inventory.id = production.inventory_id
         WHERE production.phase_reservation_set_id = $1
         ORDER BY production.planned_job_key`,
          [reservationSetId],
        );
        expect(topology.rows).toHaveLength(2);
        expect(topology.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              planned_job_key: productions[0]!.plannedJobKey,
              production_status: "RELEASED",
              inventory_status: "RELEASED",
              capacity_status: "RELEASED",
              set_status: "HELD",
              reserved_milligrams: "60",
            }),
            expect.objectContaining({
              planned_job_key: productions[1]!.plannedJobKey,
              production_status: "HELD",
              inventory_status: "HELD",
              capacity_status: "HELD",
              set_status: "HELD",
              reserved_milligrams: "60",
            }),
          ]),
        );
      },
    );
  });

  it("records actual printing consumption and returns only unused material", async () => {
    await inRollbackTransaction(
      "actual-consumption",
      async (client, fixtures) => {
        const foundation =
          await fixtures.createFoundation("actual-consumption");
        const now = new Date();
        const production = await fixtures.planProduction(
          foundation,
          "actual-consumption-production",
          {
            startsAt: new Date(now.getTime() + 60 * 60 * 1_000),
            endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
          },
          60,
          60,
        );
        await fixtures.createResourcePlan(
          foundation,
          [production],
          new Date(now.getTime() + 30 * 60 * 1_000),
          now,
        );
        await client.query(
          'UPDATE "inventories" SET "remaining_milligrams" = 1_000 WHERE "id" = $1',
          [foundation.inventoryId],
        );
        const reserved = await client.query<{
          phase_reservation_set_id: string;
        }>("SELECT * FROM taven_create_phase_reservation($1, $2, $3)", [
          foundation.nodeId,
          foundation.phaseResourcePlanId,
          `actual-${testScope}`,
        ]);
        const reservationSetId = reserved.rows[0]?.phase_reservation_set_id;
        const productionRow = await client.query<{ id: string }>(
          "SELECT id FROM production_reservations WHERE phase_reservation_set_id = $1",
          [reservationSetId],
        );
        const productionReservationId = productionRow.rows[0]?.id;
        expect(productionReservationId).toBeTruthy();

        await client.query(
          "UPDATE inventory_reservations SET status = 'HELD' WHERE production_reservation_id = $1",
          [productionReservationId],
        );
        await client.query(
          "UPDATE capacity_reservations SET status = 'HELD' WHERE production_reservation_id = $1",
          [productionReservationId],
        );
        await fixtures.createJob(foundation, production);
        await client.query(
          "UPDATE production_reservations SET status = 'HELD', job_id = $2 WHERE id = $1",
          [productionReservationId, production.jobId],
        );
        await client.query(
          "UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1",
          [reservationSetId],
        );
        await client.query(
          "UPDATE inventory_reservations SET status = 'ALLOCATED' WHERE production_reservation_id = $1",
          [productionReservationId],
        );
        await client.query(
          "UPDATE capacity_reservations SET status = 'SCHEDULED' WHERE production_reservation_id = $1",
          [productionReservationId],
        );
        await client.query(
          "UPDATE production_reservations SET status = 'SCHEDULED' WHERE id = $1",
          [productionReservationId],
        );
        await client.query(
          "UPDATE capacity_reservations SET status = 'PRINTING' WHERE production_reservation_id = $1",
          [productionReservationId],
        );
        await client.query(
          "UPDATE production_reservations SET status = 'PRINTING' WHERE id = $1",
          [productionReservationId],
        );

        const settled = await client.query<{
          phase_reservation_set_status: string;
        }>(
          "SELECT taven_settle_printing_production_reservation($1, $2) AS phase_reservation_set_status",
          [productionReservationId, 25],
        );
        expect(settled.rows[0]?.phase_reservation_set_status).toBe("SETTLED");

        const accounting = await client.query<{
          set_status: string;
          production_status: string;
          inventory_status: string;
          capacity_status: string;
          consumed_milligrams: string;
          remaining_milligrams: string;
          reserved_milligrams: string;
        }>(
          `SELECT reservation_set.status::text AS set_status,
                production.status::text AS production_status,
                inventory_reservation.status::text AS inventory_status,
                capacity_reservation.status::text AS capacity_status,
                inventory_reservation.consumed_milligrams::text AS consumed_milligrams,
                inventory.remaining_milligrams::text AS remaining_milligrams,
                inventory.reserved_milligrams::text AS reserved_milligrams
         FROM phase_reservation_sets reservation_set
         JOIN production_reservations production
           ON production.phase_reservation_set_id = reservation_set.id
         JOIN inventory_reservations inventory_reservation
           ON inventory_reservation.production_reservation_id = production.id
         JOIN capacity_reservations capacity_reservation
           ON capacity_reservation.production_reservation_id = production.id
         JOIN inventories inventory ON inventory.id = production.inventory_id
         WHERE reservation_set.id = $1`,
          [reservationSetId],
        );
        expect(accounting.rows).toEqual([
          {
            set_status: "SETTLED",
            production_status: "CONSUMED",
            inventory_status: "CONSUMED",
            capacity_status: "COMPLETED",
            consumed_milligrams: "25",
            remaining_milligrams: "975",
            reserved_milligrams: "0",
          },
        ]);
      },
    );
  });
});
