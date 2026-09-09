import { describe, expect, it, vi } from "vitest";
import { ProductionArtifactFormat } from "@prisma/client";
import type { SlicingJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import type { PrismaService } from "../../prisma/prisma.service";
import {
  ImmutableObjectConflictError,
  type ObjectStorage,
} from "../storage/object-storage.port";
import {
  SlicerProfileSnapshotIntegrityError,
  SlicerProfileSnapshotMismatchError,
  SlicerProfileSnapshotNotFoundError,
  SlicerProfileSnapshotService,
  SlicerProfileSnapshotUnavailableError,
  slicerSettingsSnapshot,
} from "./slicer-profile-snapshot.service";

function candidateJob(
  hashes: {
    machine: string;
    calibration: string;
    config: string;
  },
  productionArtifactFormat = "gcode_3mf",
): SlicingJob {
  return {
    kind: "candidate_estimate",
    input: {
      machineProfile: {
        revisionId: "machine",
        contentSha256: hashes.machine,
        slicerEngine: "orcaslicer",
        slicerVersion: "2.4.2",
        productionArtifactFormat,
      },
      machineCalibration: {
        revisionId: "calibration",
        contentSha256: hashes.calibration,
      },
      printConfig: {
        revisionId: "config",
        contentSha256: hashes.config,
      },
    },
  } as unknown as SlicingJob;
}

describe("SlicerProfileSnapshotService", () => {
  it("hashes canonical settings bytes independently of object key order", () => {
    const first = slicerSettingsSnapshot({
      z: 1,
      nested: { b: true, a: "value" },
    });
    const reordered = slicerSettingsSnapshot({
      nested: { a: "value", b: true },
      z: 1,
    });

    expect(reordered).toEqual(first);
    expect(first.objectKey).toBe(
      `slicer-revisions/${first.contentSha256}/settings.json`,
    );
    expect(new TextDecoder().decode(first.bytes)).toBe(
      '{"nested":{"a":"value","b":true},"z":1}',
    );
  });

  it("validates exact job hashes before provisioning immutable snapshots", async () => {
    const machine = { machine: "h2s" };
    const calibration = { flow_ratio: "1" };
    const config = { layer_height: "0.2" };
    const putImmutableObject = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      machineProfile: {
        findUnique: vi.fn().mockResolvedValue({
          settings: machine,
          slicerEngine: "orcaslicer",
          slicerVersion: "2.4.2",
          productionArtifactFormat: ProductionArtifactFormat.GCODE_3MF,
        }),
      },
      machineCalibration: {
        findUnique: vi.fn().mockResolvedValue({ settings: calibration }),
      },
      printConfigRevision: {
        findUnique: vi.fn().mockResolvedValue({ settings: config }),
      },
    } as unknown as PrismaService;
    const service = new SlicerProfileSnapshotService(prisma, {
      putImmutableObject,
    } as unknown as ObjectStorage);
    const hashes = {
      machine: slicerSettingsSnapshot(machine).contentSha256,
      calibration: slicerSettingsSnapshot(calibration).contentSha256,
      config: slicerSettingsSnapshot(config).contentSha256,
    };

    await expect(
      service.ensureJobSnapshots(candidateJob(hashes)),
    ).resolves.toBeUndefined();
    expect(putImmutableObject).toHaveBeenCalledTimes(3);

    putImmutableObject.mockClear();
    await expect(
      service.ensureJobSnapshots(
        candidateJob({ ...hashes, config: "a".repeat(64) }),
      ),
    ).rejects.toBeInstanceOf(SlicerProfileSnapshotMismatchError);
    expect(putImmutableObject).not.toHaveBeenCalled();

    await expect(
      service.ensureJobSnapshots(candidateJob(hashes, "gcode")),
    ).rejects.toBeInstanceOf(SlicerProfileSnapshotMismatchError);
  });

  it("materializes activation snapshots only from committed revision settings", async () => {
    const settings = { layer_height: "0.2" };
    const putImmutableObject = vi.fn().mockResolvedValue(undefined);
    const referenceProfile = {
      findUnique: vi.fn().mockResolvedValue({ settings }),
    };
    const machineProfile = {
      findUnique: vi.fn(),
    };
    const machineCalibration = {
      findFirst: vi.fn().mockResolvedValue({ settings }),
    };
    const prisma = {
      referenceProfile,
      machineProfile,
      machineCalibration,
    } as unknown as PrismaService;
    const service = new SlicerProfileSnapshotService(prisma, {
      putImmutableObject,
    } as unknown as ObjectStorage);

    const snapshot = await service.provisionReferenceProfile("reference-id");
    expect(snapshot).toEqual(slicerSettingsSnapshot(settings));
    expect(referenceProfile.findUnique).toHaveBeenCalledWith({
      where: { id: "reference-id" },
      select: { settings: true },
    });
    expect(putImmutableObject).toHaveBeenCalledWith({
      objectKey: snapshot.objectKey,
      bytes: snapshot.bytes,
      contentHash: snapshot.contentSha256,
      contentType: "application/json",
    });

    await expect(
      service.provisionMachineCalibration("node-id", "calibration-id"),
    ).resolves.toEqual(snapshot);
    expect(machineCalibration.findFirst).toHaveBeenCalledWith({
      where: { id: "calibration-id", nodeId: "node-id" },
      select: { settings: true },
    });
    expect(machineProfile.findUnique).not.toHaveBeenCalled();
  });

  it("classifies missing, immutable-conflict, and transient activation snapshots", async () => {
    const missing = new SlicerProfileSnapshotService(
      {
        referenceProfile: { findUnique: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      { putImmutableObject: vi.fn() } as unknown as ObjectStorage,
    );
    await expect(
      missing.provisionReferenceProfile("missing-reference"),
    ).rejects.toBeInstanceOf(SlicerProfileSnapshotNotFoundError);

    const conflict = new SlicerProfileSnapshotService(
      {
        referenceProfile: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ settings: { quality: "fine" } }),
        },
      } as unknown as PrismaService,
      {
        putImmutableObject: vi
          .fn()
          .mockRejectedValue(new ImmutableObjectConflictError()),
      } as unknown as ObjectStorage,
    );
    await expect(
      conflict.provisionReferenceProfile("conflicted-reference"),
    ).rejects.toBeInstanceOf(SlicerProfileSnapshotIntegrityError);

    const unavailable = new SlicerProfileSnapshotService(
      {
        referenceProfile: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ settings: { quality: "fine" } }),
        },
      } as unknown as PrismaService,
      {
        putImmutableObject: vi.fn().mockRejectedValue(new Error("S3 timeout")),
      } as unknown as ObjectStorage,
    );
    await expect(
      unavailable.provisionReferenceProfile("unavailable-reference"),
    ).rejects.toBeInstanceOf(SlicerProfileSnapshotUnavailableError);
  });

  it("repairs snapshots from all committed revision families at bootstrap", async () => {
    const reference = { reference: true };
    const machine = { machine: true };
    const calibration = { calibration: true };
    const configuration = { configuration: true };
    const putImmutableObject = vi.fn().mockResolvedValue(undefined);
    const service = new SlicerProfileSnapshotService(
      {
        referenceProfile: {
          findMany: vi.fn().mockResolvedValue([{ settings: reference }]),
        },
        machineProfile: {
          findMany: vi.fn().mockResolvedValue([{ settings: machine }]),
        },
        machineCalibration: {
          findMany: vi.fn().mockResolvedValue([{ settings: calibration }]),
        },
        printConfigRevision: {
          findMany: vi.fn().mockResolvedValue([{ settings: configuration }]),
        },
      } as unknown as PrismaService,
      { putImmutableObject } as unknown as ObjectStorage,
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(putImmutableObject).toHaveBeenCalledTimes(4);
    for (const settings of [reference, machine, calibration, configuration]) {
      const snapshot = slicerSettingsSnapshot(settings);
      expect(putImmutableObject).toHaveBeenCalledWith({
        objectKey: snapshot.objectKey,
        bytes: snapshot.bytes,
        contentHash: snapshot.contentSha256,
        contentType: "application/json",
      });
    }
  });
});
