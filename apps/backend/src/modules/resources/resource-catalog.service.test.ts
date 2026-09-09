import { RevisionState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../prisma/prisma.service";
import type { SlicerProfileSnapshotService } from "../slicing/slicer-profile-snapshot.service";
import { ResourceSnapshotIntegrityError } from "./resource-errors";
import { ResourceCatalogService } from "./resource-catalog.service";

describe("ResourceCatalogService activation verification", () => {
  it("requires a service-produced verification receipt before using a supplied transaction", async () => {
    const now = new Date("2026-09-09T10:00:00.000Z");
    const revisionId = "7ca25181-4360-46c5-b160-58b6f9e810e3";
    const rootReferenceProfile = {
      findUnique: vi
        .fn()
        .mockResolvedValue({ settings: { layer_height: 120 } }),
    };
    const transactionReferenceProfile = {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: revisionId, state: RevisionState.ACTIVE }),
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ observed_at: now }]),
      referenceProfile: transactionReferenceProfile,
    };
    const prisma = {
      referenceProfile: rootReferenceProfile,
      $transaction: vi.fn(),
    } as unknown as PrismaService;
    const snapshots = {
      provisionReferenceProfile: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentSha256: "a".repeat(64),
        objectKey: `slicer-revisions/${"a".repeat(64)}/settings.json`,
      }),
    } as unknown as SlicerProfileSnapshotService;
    const service = new ResourceCatalogService(prisma, snapshots);

    await expect(
      service.activateReferenceProfile(revisionId, transaction as never),
    ).rejects.toBeInstanceOf(ResourceSnapshotIntegrityError);
    expect(rootReferenceProfile.findUnique).not.toHaveBeenCalled();
    expect(transactionReferenceProfile.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();

    const verification =
      await service.verifyReferenceProfileSnapshot(revisionId);
    await expect(
      service.activateReferenceProfile(
        revisionId,
        transaction as never,
        verification,
      ),
    ).resolves.toMatchObject({ id: revisionId, state: RevisionState.ACTIVE });
    expect(transactionReferenceProfile.updateMany).toHaveBeenCalledWith({
      where: { id: revisionId, state: RevisionState.DRAFT },
      data: { state: RevisionState.ACTIVE, activatedAt: now },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
