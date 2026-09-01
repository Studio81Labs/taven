import { describe, expect, it, vi } from "vitest";
import type { SlicingJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import type { PrismaService } from "../../prisma/prisma.service";
import type { ObjectStorage } from "../storage/object-storage.port";
import {
  SlicerProfileSnapshotMismatchError,
  SlicerProfileSnapshotService,
  slicerSettingsSnapshot,
} from "./slicer-profile-snapshot.service";

function candidateJob(hashes: {
  machine: string;
  calibration: string;
  config: string;
}): SlicingJob {
  return {
    kind: "candidate_estimate",
    input: {
      machineProfile: {
        revisionId: "machine",
        contentSha256: hashes.machine,
        slicerEngine: "orcaslicer",
        slicerVersion: "2.4.2",
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
  });
});
