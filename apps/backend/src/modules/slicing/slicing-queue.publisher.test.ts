import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type { SlicingJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { PrismaService } from "../../prisma/prisma.service";
import { CandidateEstimateService } from "../resources/candidate-estimate.service";
import { SlicingQueuePublisher } from "./slicing-queue.publisher";

type ProductionAuthorizer = {
  assertProductionSliceAuthorized(
    job: Extract<SlicingJob, { kind: "production_slice" }>,
  ): Promise<void>;
};

describe("SlicingQueuePublisher production authorization", () => {
  it("authorizes package quantity through the planned candidate, not the analysis slice", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "accepted-job" });
    const publisher = new SlicingQueuePublisher(
      { job: { findFirst } } as unknown as PrismaService,
      {} as Queue,
      {} as CandidateEstimateService,
    );
    const job = {
      input: {
        acceptedJobId: "accepted-job",
        productionReservationId: "reservation",
        machineId: "machine",
        quantity: 5,
        partsPerPlate: 2,
        geometry: {
          modelGeometryId: "geometry",
          sourceModelFileId: "source",
          canonicalObjectKey: "geometries/geometry/canonical",
          geometrySha256: "a".repeat(64),
          sourceContentSha256: "b".repeat(64),
        },
        printConfig: { revisionId: "config", contentSha256: "c".repeat(64) },
        machineProfile: {
          revisionId: "profile",
          contentSha256: "d".repeat(64),
        },
        machineCalibration: {
          revisionId: "calibration",
          contentSha256: "e".repeat(64),
        },
        arrangementRevision: {
          revisionId: "arrangement",
          contentSha256: "f".repeat(64),
        },
      },
    } as unknown as Extract<SlicingJob, { kind: "production_slice" }>;

    await expect(
      (
        publisher as unknown as ProductionAuthorizer
      ).assertProductionSliceAuthorized(job),
    ).resolves.toBeUndefined();

    const where = findFirst.mock.calls[0]![0].where;
    const reservation = where.productionReservations.some;
    expect(reservation.occupancySliceResult).not.toHaveProperty(
      "packageQuantity",
    );
    expect(
      reservation.phaseResourcePlanJob.candidateResourceEstimate,
    ).toMatchObject({
      quantity: 5,
      partsPerPlate: 2,
      arrangementRevisionId: "arrangement",
      arrangementRevision: { contentSha256: "f".repeat(64) },
    });
  });
});
