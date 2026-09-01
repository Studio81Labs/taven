import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { CandidateEstimateService } from "./candidate-estimate.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { SlicerProfileSnapshotService } from "../slicing/slicer-profile-snapshot.service";

type CandidateResourceLocker = {
  lockCandidateResources(
    transaction: Prisma.TransactionClient,
    resources: {
      nodeId: string;
      inventoryId: string;
      machineId: string;
      machineProfileId: string;
      machineCalibrationId: string;
    },
  ): Promise<{
    observed_at: Date;
    remaining_milligrams: bigint;
    reserved_milligrams: bigint;
  }>;
};

describe("CandidateEstimateService resource locks", () => {
  it("acquires profile, machine, calibration, then inventory locks", async () => {
    const observedAt = new Date("2026-08-30T12:00:00.000Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: "profile" }])
      .mockResolvedValueOnce([{ id: "machine" }])
      .mockResolvedValueOnce([{ id: "calibration" }])
      .mockResolvedValueOnce([
        {
          observed_at: observedAt,
          remaining_milligrams: 1_000n,
          reserved_milligrams: 0n,
        },
      ]);
    const transaction = {
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;
    const service = new CandidateEstimateService(
      {} as PrismaService,
      {} as SlicerProfileSnapshotService,
    );

    await expect(
      (service as unknown as CandidateResourceLocker).lockCandidateResources(
        transaction,
        {
          nodeId: "node",
          inventoryId: "inventory",
          machineId: "machine",
          machineProfileId: "profile",
          machineCalibrationId: "calibration",
        },
      ),
    ).resolves.toMatchObject({ observed_at: observedAt });

    const statements = queryRaw.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(""),
    );
    expect(statements).toHaveLength(4);
    expect(
      statements.map((statement) => statement.match(/FROM (\w+)/)?.[1]),
    ).toEqual([
      "machine_profiles",
      "machines",
      "machine_calibrations",
      "inventories",
    ]);
    for (const statement of statements) {
      expect(statement).toContain("FOR UPDATE");
    }
  });
});
