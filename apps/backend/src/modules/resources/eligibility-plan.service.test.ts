import { describe, expect, it, vi } from "vitest";
import { EligibilityPlanService } from "./eligibility-plan.service";

const nodeId = "00000000-0000-4000-8000-000000000001";
const orderPhaseId = "00000000-0000-4000-8000-000000000002";
const orderId = "00000000-0000-4000-8000-000000000003";
const slotId = "00000000-0000-4000-8000-000000000004";
const candidateId = "00000000-0000-4000-8000-000000000005";
const shipmentPlanId = "00000000-0000-4000-8000-000000000006";
const itemId = "00000000-0000-4000-8000-000000000007";
const geometryId = "00000000-0000-4000-8000-000000000008";
const configId = "00000000-0000-4000-8000-000000000009";
const machineId = "00000000-0000-4000-8000-00000000000a";
const profileId = "00000000-0000-4000-8000-00000000000b";
const calibrationId = "00000000-0000-4000-8000-00000000000c";
const inventoryId = "00000000-0000-4000-8000-00000000000d";
const intervalId = "00000000-0000-4000-8000-00000000000e";

describe("EligibilityPlanService", () => {
  it("rejects a candidate at the exact reservation TTL from the fresh planning clock", async () => {
    const observedAt = new Date("2030-01-01T00:00:00.000Z");
    const planningNow = new Date("2030-01-01T01:00:00.000Z");
    const candidateExpiresAt = new Date(
      planningNow.getTime() + 15 * 60 * 1_000,
    );
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ order_id: orderId }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          node_exists: true,
          phase_status: "QUOTED",
          observed_at: observedAt,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: slotId,
          packing_unit_key: "packing-unit-1",
          order_item_id: itemId,
          item_ordinal: 0,
          model_geometry_id: geometryId,
          print_config_revision_id: configId,
          material: "PLA",
          color: "red",
          shipment_plan_id: shipmentPlanId,
        },
      ])
      .mockResolvedValueOnce([{ planning_now: planningNow }])
      .mockResolvedValueOnce([
        {
          id: candidateId,
          estimate_key: "estimate-1",
          node_id: nodeId,
          machine_id: machineId,
          machine_profile_id: profileId,
          machine_calibration_id: calibrationId,
          inventory_id: inventoryId,
          shipment_plan_id: shipmentPlanId,
          model_geometry_id: geometryId,
          print_config_revision_id: configId,
          material: "PLA",
          color: "red",
          quantity: 1,
          required_material_milligrams: 60n,
          required_machine_seconds: 60n,
          expires_at: candidateExpiresAt,
          interval_id: intervalId,
          interval_index: 0,
          starts_at: new Date("2030-01-01T02:00:00.000Z"),
          ends_at: new Date("2030-01-01T03:00:00.000Z"),
          remaining_milligrams: 1_000n,
          reserved_milligrams: 0n,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ planning_now: planningNow }]);
    const transaction = {
      $queryRaw: queryRaw,
      phaseResourcePlan: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(transaction)),
    };

    await expect(
      new EligibilityPlanService(prisma as never).createCompletePlan({
        nodeId,
        orderPhaseId,
        planKey: "exact-ttl-plan",
      }),
    ).rejects.toMatchObject({
      message:
        "complete plan does not remain valid for the payment reservation TTL",
    });
    expect(queryRaw).toHaveBeenCalledTimes(8);
  });
});
