import { describe, expect, it, vi } from "vitest";
import { ProductionArtifactFormat, type Prisma } from "@prisma/client";
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

type PresetBundleJson = Prisma.JsonObject & {
  bundleVersion: number;
  presets: Prisma.JsonObject[];
};

const bundle = (...presets: Prisma.JsonObject[]): PresetBundleJson =>
  ({
    bundleVersion: 1,
    presets,
  }) as PresetBundleJson;
const machineBundle = () =>
  bundle(
    { type: "machine", name: "machine" },
    { type: "process", name: "process" },
    { type: "filament", name: "filament" },
  );

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

  it("uses the initial UTF-16 snapshot bytes, hash, and object key", () => {
    const snapshot = slicerSettingsSnapshot({
      a: 1,
      B: 2,
    });

    expect(new TextDecoder().decode(snapshot.bytes)).toBe('{"B":2,"a":1}');
    expect(snapshot.contentSha256).toBe(
      "1b16a30c88c01fbb4fcc0385bd01a0dc71c997ffacff6ebefe8f1f529eba16d9",
    );
    expect(snapshot.objectKey).toBe(
      "slicer-revisions/1b16a30c88c01fbb4fcc0385bd01a0dc71c997ffacff6ebefe8f1f529eba16d9/settings.json",
    );
  });

  it("validates exact job hashes before provisioning immutable snapshots", async () => {
    const machine = machineBundle();
    const calibration = bundle({ flow_ratio: "1" });
    const config = bundle({ layer_height: "0.2" });
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
    const settings = machineBundle();
    const calibrationSettings = bundle({ flow_ratio: "1" });
    const putImmutableObject = vi.fn().mockResolvedValue(undefined);
    const referenceProfile = {
      findUnique: vi.fn().mockResolvedValue({ settings }),
    };
    const machineProfile = {
      findUnique: vi.fn(),
    };
    const machineCalibration = {
      findFirst: vi.fn().mockResolvedValue({ settings: calibrationSettings }),
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
    ).resolves.toEqual(slicerSettingsSnapshot(calibrationSettings));
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
          findUnique: vi.fn().mockResolvedValue({ settings: machineBundle() }),
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
          findUnique: vi.fn().mockResolvedValue({ settings: machineBundle() }),
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

  it("repairs snapshots without applying dispatch validation at bootstrap", async () => {
    const referenceSettings = machineBundle();
    const machineSettings = machineBundle();
    const calibrationSettings = bundle({ flow_ratio: "1" });
    const printSettings = bundle({ layer_height: "0.2" });
    const unvalidatedDraftSettings = { draftOnly: true };
    const putImmutableObject = vi.fn().mockResolvedValue(undefined);
    const referenceProfile = {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { settings: referenceSettings },
          { settings: unvalidatedDraftSettings },
        ]),
    };
    const machineProfile = {
      findMany: vi.fn().mockResolvedValue([{ settings: machineSettings }]),
    };
    const machineCalibration = {
      findMany: vi.fn().mockResolvedValue([{ settings: calibrationSettings }]),
    };
    const printConfigRevision = {
      findMany: vi.fn().mockResolvedValue([{ settings: printSettings }]),
    };
    const service = new SlicerProfileSnapshotService(
      {
        referenceProfile,
        machineProfile,
        machineCalibration,
        printConfigRevision,
      } as unknown as PrismaService,
      { putImmutableObject } as unknown as ObjectStorage,
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(referenceProfile.findMany).toHaveBeenCalledOnce();
    expect(machineProfile.findMany).toHaveBeenCalledOnce();
    expect(machineCalibration.findMany).toHaveBeenCalledOnce();
    expect(printConfigRevision.findMany).toHaveBeenCalledOnce();
    expect(putImmutableObject).toHaveBeenCalledTimes(4);
  });

  it.each(["post_process", "print_host", "printhost_url", "bbl_use_printhost"])(
    "rejects unsafe %s settings before dispatch",
    async (key) => {
      const settings = machineBundle();
      settings.presets[1]![key] = "unsafe";
      const service = new SlicerProfileSnapshotService(
        {
          referenceProfile: {
            findUnique: vi.fn().mockResolvedValue({ settings }),
          },
          printConfigRevision: {
            findUnique: vi.fn().mockResolvedValue({ settings: bundle({}) }),
          },
        } as unknown as PrismaService,
        { putImmutableObject: vi.fn() } as unknown as ObjectStorage,
      );
      await expect(
        service.provisionReferenceProfile("reference-id"),
      ).rejects.toBeInstanceOf(SlicerProfileSnapshotIntegrityError);
    },
  );
});
