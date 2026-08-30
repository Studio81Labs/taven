import { describe, expect, it } from "vitest";
import {
  selectCompleteResourcePlan,
  type FulfilmentSlotResourceInput,
  type ResourceCandidateEstimate,
  type ResourcePlanSelectorInput,
} from "./resource-plan.js";

const now = new Date("2026-08-30T10:00:00.000Z");
const later = new Date("2026-08-30T12:00:00.000Z");
const end = new Date("2026-08-30T13:00:00.000Z");

const slots: readonly FulfilmentSlotResourceInput[] = [
  {
    id: "slot-a",
    shipmentPlanId: "shipment-a",
    modelGeometryId: "geometry-a",
    printConfigRevisionId: "config-a",
    material: "PLA",
    color: "red",
  },
  {
    id: "slot-b",
    shipmentPlanId: "shipment-b",
    modelGeometryId: "geometry-b",
    printConfigRevisionId: "config-b",
    material: "PETG",
    color: "blue",
  },
];

const candidate = (
  id: string,
  slotIds: readonly string[],
  overrides: Partial<ResourceCandidateEstimate> = {},
): ResourceCandidateEstimate => ({
  id,
  nodeId: "node-1",
  machineId: `${id}-machine`,
  machineProfileId: `${id}-profile`,
  machineCalibrationId: `${id}-calibration`,
  inventoryId: `${id}-inventory`,
  shipmentPlanId: slots.find((slot) => slot.id === slotIds[0])!.shipmentPlanId,
  modelGeometryId: slots.find((slot) => slot.id === slotIds[0])!
    .modelGeometryId,
  printConfigRevisionId: slots.find((slot) => slot.id === slotIds[0])!
    .printConfigRevisionId,
  material: slots.find((slot) => slot.id === slotIds[0])!.material,
  color: slots.find((slot) => slot.id === slotIds[0])!.color,
  requiredMaterialMilligrams: 100n,
  requiredMachineSeconds: 60n,
  expiresAt: later,
  intervals: [
    {
      id: `${id}-interval`,
      nodeId: "node-1",
      machineId: `${id}-machine`,
      startsAt: later,
      endsAt: end,
    },
  ],
  fulfilmentSlotIds: slotIds,
  ...overrides,
});

const baseInput = (
  candidates: readonly ResourceCandidateEstimate[],
  overrides: Partial<ResourcePlanSelectorInput> = {},
): ResourcePlanSelectorInput => ({
  requiredFulfilmentSlots: slots,
  candidates,
  inventory: candidates.map((item) => ({
    id: item.inventoryId,
    availableMilligrams: 1_000n,
  })),
  now,
  ...overrides,
});

describe("selectCompleteResourcePlan", () => {
  it("requires one complete mapping and returns canonical assignments/locks", () => {
    const result = selectCompleteResourcePlan(
      baseInput([
        candidate("candidate-b", ["slot-b"]),
        candidate("candidate-a", ["slot-a"]),
      ]),
    );

    expect(result?.candidateResourceEstimateIds).toEqual([
      "candidate-a",
      "candidate-b",
    ]);
    expect(result?.assignments).toEqual([
      {
        fulfilmentSlotId: "slot-a",
        candidateResourceEstimateId: "candidate-a",
      },
      {
        fulfilmentSlotId: "slot-b",
        candidateResourceEstimateId: "candidate-b",
      },
    ]);
    expect(result?.lockTargets.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
      "candidate_resource_estimate:candidate-a",
      "candidate_resource_estimate:candidate-b",
      "machine_profile:candidate-a-profile",
      "machine_profile:candidate-b-profile",
      "machine:candidate-a-machine",
      "machine:candidate-b-machine",
      "machine_calibration:candidate-a-calibration",
      "machine_calibration:candidate-b-calibration",
      "inventory:candidate-a-inventory",
      "inventory:candidate-b-inventory",
      "candidate_capacity_interval:candidate-a-interval",
      "candidate_capacity_interval:candidate-b-interval",
    ]);
  });

  it("allows one candidate to cover multiple matching slots", () => {
    const result = selectCompleteResourcePlan(
      baseInput([
        candidate("complete", ["slot-a", "slot-b"], {
          shipmentPlanId: "shared-shipment",
          modelGeometryId: "shared-geometry",
          printConfigRevisionId: "shared-config",
          material: "PLA",
          color: "red",
        }),
      ]),
    );
    // A single candidate still must match both immutable slot snapshots; a
    // shared candidate cannot hide a cross-item mismatch.
    expect(result).toBeUndefined();

    const matchingSlots = slots.map((slot) => ({
      ...slot,
      shipmentPlanId: "shipment",
      modelGeometryId: "geometry",
      printConfigRevisionId: "config",
      material: "PLA",
      color: "red",
    }));
    expect(
      selectCompleteResourcePlan(
        baseInput(
          [
            candidate("complete", ["slot-a", "slot-b"], {
              shipmentPlanId: "shipment",
              modelGeometryId: "geometry",
              printConfigRevisionId: "config",
              material: "PLA",
              color: "red",
            }),
          ],
          { requiredFulfilmentSlots: matchingSlots },
        ),
      )?.candidateResourceEstimateIds,
    ).toEqual(["complete"]);
  });

  it("does not substitute reference metrics, expired candidates, or duplicate coverage", () => {
    const result = selectCompleteResourcePlan(
      baseInput([
        candidate("reference", ["slot-a"], { source: "reference" }),
        candidate("expired", ["slot-a"], { expiresAt: now }),
        candidate("duplicate", ["slot-a", "slot-a"]),
        candidate("valid", ["slot-b"]),
      ]),
    );
    expect(result).toBeUndefined();
  });

  it("rejects non-positive resources, already-started capacity, and uses estimate keys", () => {
    expect(() =>
      selectCompleteResourcePlan(
        baseInput([
          candidate("zero", ["slot-a"], {
            requiredMaterialMilligrams: 0n,
          }),
          candidate("valid", ["slot-b"]),
        ]),
      ),
    ).toThrow("must be positive");
    expect(
      selectCompleteResourcePlan(
        baseInput([
          candidate("started", ["slot-a"], {
            intervals: [
              {
                machineId: "started-machine",
                startsAt: new Date(now.getTime() - 1),
                endsAt: later,
              },
            ],
          }),
          candidate("valid", ["slot-b"]),
        ]),
      ),
    ).toBeUndefined();

    const lateId = candidate("a-id", ["slot-a"], { estimateKey: "z-key" });
    const earlyKey = candidate("z-id", ["slot-a"], {
      estimateKey: "a-key",
    });
    expect(
      selectCompleteResourcePlan(
        baseInput([lateId, earlyKey, candidate("slot-b", ["slot-b"])]),
      )?.assignments.find(
        ({ fulfilmentSlotId }) => fulfilmentSlotId === "slot-a",
      )?.candidateResourceEstimateId,
    ).toBe("z-id");
  });

  it("enforces aggregate inventory and existing/selected machine capacity", () => {
    const sharedInventory = { id: "inventory", availableMilligrams: 150n };
    const first = candidate("first", ["slot-a"], {
      inventoryId: sharedInventory.id,
      machineId: "machine",
      intervals: [{ machineId: "machine", startsAt: later, endsAt: end }],
    });
    const second = candidate("second", ["slot-b"], {
      inventoryId: sharedInventory.id,
      machineId: "machine",
      intervals: [{ machineId: "machine", startsAt: later, endsAt: end }],
    });
    expect(
      selectCompleteResourcePlan(
        baseInput([first, second], {
          inventory: [sharedInventory],
        }),
      ),
    ).toBeUndefined();
    expect(
      selectCompleteResourcePlan(
        baseInput([first, second], {
          inventory: [
            { id: first.inventoryId, availableMilligrams: 1_000n },
            { id: second.inventoryId, availableMilligrams: 1_000n },
          ],
          occupiedCapacity: [
            { machineId: "machine", startsAt: later, endsAt: end },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("permits adjacent intervals and uses remaining minus reserved inventory", () => {
    const first = candidate("first", ["slot-a"], {
      inventoryId: "inventory",
      machineId: "machine",
      intervals: [
        {
          machineId: "machine",
          startsAt: later,
          endsAt: new Date("2026-08-30T12:30:00.000Z"),
        },
      ],
    });
    const second = candidate("second", ["slot-b"], {
      inventoryId: "inventory",
      machineId: "machine",
      intervals: [
        {
          machineId: "machine",
          startsAt: new Date("2026-08-30T12:30:00.000Z"),
          endsAt: end,
        },
      ],
    });
    expect(
      selectCompleteResourcePlan(
        baseInput([first, second], {
          inventory: [
            {
              id: "inventory",
              remainingMilligrams: 250n,
              reservedMilligrams: 50n,
            },
          ],
        }),
      )?.candidateResourceEstimateIds,
    ).toEqual(["first", "second"]);
  });
});
