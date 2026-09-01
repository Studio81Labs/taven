import { createHash } from "node:crypto";
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { SlicingJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { PrismaService } from "../../prisma/prisma.service";
import {
  canonicalJson,
  type CanonicalJson,
} from "../resources/resource-identity";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../storage/object-storage.port";
import { slicerRevisionObjectKey } from "../storage/storage-keys";
import { toSlicerProductionArtifactFormat } from "./production-artifact-format";

type RevisionPointer = {
  revisionId: string;
  contentSha256: string;
};

type SnapshotExpectation = {
  label: string;
  pointer: RevisionPointer;
  settings: Prisma.JsonValue;
};

export type SlicerSettingsSnapshot = {
  bytes: Uint8Array;
  contentSha256: string;
  objectKey: string;
};

export class SlicerProfileSnapshotMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlicerProfileSnapshotMismatchError";
  }
}

/** Canonical bytes loaded directly by Orca and addressed by their own hash. */
export function slicerSettingsSnapshot(
  settings: Prisma.JsonValue,
): SlicerSettingsSnapshot {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new SlicerProfileSnapshotMismatchError(
      "slicer revision settings must be a JSON object",
    );
  }
  const bytes = Buffer.from(canonicalJson(settings as CanonicalJson), "utf8");
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    contentSha256,
    objectKey: slicerRevisionObjectKey(contentSha256),
  };
}

@Injectable()
export class SlicerProfileSnapshotService implements OnApplicationBootstrap {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const revisions = await Promise.all([
      this.prisma.referenceProfile.findMany({ select: { settings: true } }),
      this.prisma.machineProfile.findMany({ select: { settings: true } }),
      this.prisma.machineCalibration.findMany({ select: { settings: true } }),
      this.prisma.printConfigRevision.findMany({ select: { settings: true } }),
    ]);
    await this.provision(
      revisions.flatMap((rows) => rows.map(({ settings }) => settings)),
    );
  }

  async provisionSettings(
    settings: Prisma.JsonValue,
  ): Promise<SlicerSettingsSnapshot> {
    const snapshot = slicerSettingsSnapshot(settings);
    await this.objects.putImmutableObject({
      objectKey: snapshot.objectKey,
      bytes: snapshot.bytes,
      contentHash: snapshot.contentSha256,
      contentType: "application/json",
    });
    return snapshot;
  }

  async ensureJobSnapshots(job: SlicingJob): Promise<void> {
    const expectations = await this.expectationsFor(job);
    const snapshots = expectations.map((expectation) => ({
      expectation,
      snapshot: slicerSettingsSnapshot(expectation.settings),
    }));
    for (const { expectation, snapshot } of snapshots) {
      if (expectation.pointer.contentSha256 !== snapshot.contentSha256) {
        throw new SlicerProfileSnapshotMismatchError(
          `${expectation.label} content hash does not match persisted settings`,
        );
      }
    }
    await this.provision(expectations.map(({ settings }) => settings));
  }

  private async provision(
    settings: readonly Prisma.JsonValue[],
  ): Promise<void> {
    const unique = new Map<string, SlicerSettingsSnapshot>();
    for (const value of settings) {
      const snapshot = slicerSettingsSnapshot(value);
      unique.set(snapshot.contentSha256, snapshot);
    }
    for (const snapshot of unique.values()) {
      await this.objects.putImmutableObject({
        objectKey: snapshot.objectKey,
        bytes: snapshot.bytes,
        contentHash: snapshot.contentSha256,
        contentType: "application/json",
      });
    }
  }

  private async expectationsFor(
    job: SlicingJob,
  ): Promise<SnapshotExpectation[]> {
    if (job.kind === "model_inspection") return [];
    if (job.kind === "reference_slice") {
      const [profile, config] = await Promise.all([
        this.prisma.referenceProfile.findUnique({
          where: { id: job.input.referenceProfile.revisionId },
          select: { settings: true, slicerEngine: true, slicerVersion: true },
        }),
        this.prisma.printConfigRevision.findUnique({
          where: { id: job.input.printConfig.revisionId },
          select: { settings: true },
        }),
      ]);
      if (!profile || !config) {
        throw new SlicerProfileSnapshotMismatchError(
          "slicer job references a missing profile revision",
        );
      }
      if (
        profile.slicerEngine !== job.input.referenceProfile.slicerEngine ||
        profile.slicerVersion !== job.input.referenceProfile.slicerVersion
      ) {
        throw new SlicerProfileSnapshotMismatchError(
          "reference profile slicer identity does not match persisted state",
        );
      }
      return [
        {
          label: "reference profile",
          pointer: job.input.referenceProfile,
          settings: profile.settings,
        },
        {
          label: "print configuration",
          pointer: job.input.printConfig,
          settings: config.settings,
        },
      ];
    }

    const [profile, calibration, config] = await Promise.all([
      this.prisma.machineProfile.findUnique({
        where: { id: job.input.machineProfile.revisionId },
        select: {
          settings: true,
          slicerEngine: true,
          slicerVersion: true,
          productionArtifactFormat: true,
        },
      }),
      this.prisma.machineCalibration.findUnique({
        where: { id: job.input.machineCalibration.revisionId },
        select: { settings: true },
      }),
      this.prisma.printConfigRevision.findUnique({
        where: { id: job.input.printConfig.revisionId },
        select: { settings: true },
      }),
    ]);
    if (!profile || !calibration || !config) {
      throw new SlicerProfileSnapshotMismatchError(
        "slicer job references a missing profile revision",
      );
    }
    if (
      profile.slicerEngine !== job.input.machineProfile.slicerEngine ||
      profile.slicerVersion !== job.input.machineProfile.slicerVersion ||
      toSlicerProductionArtifactFormat(profile.productionArtifactFormat) !==
        job.input.machineProfile.productionArtifactFormat
    ) {
      throw new SlicerProfileSnapshotMismatchError(
        "machine profile slicer identity does not match persisted state",
      );
    }
    return [
      {
        label: "machine profile",
        pointer: job.input.machineProfile,
        settings: profile.settings,
      },
      {
        label: "machine calibration",
        pointer: job.input.machineCalibration,
        settings: calibration.settings,
      },
      {
        label: "print configuration",
        pointer: job.input.printConfig,
        settings: config.settings,
      },
    ];
  }
}
