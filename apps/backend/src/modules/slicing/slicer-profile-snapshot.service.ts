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
  ImmutableObjectConflictError,
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../storage/object-storage.port";
import { slicerRevisionObjectKey } from "../storage/storage-keys";
import { toSlicerProductionArtifactFormat } from "./production-artifact-format";
import {
  assertPresetBundleAggregateLimits,
  assertRevisionPresetBundle,
  PresetBundleValidationError,
} from "./preset-bundle";

type RevisionPointer = {
  revisionId: string;
  contentSha256: string;
};

type SnapshotExpectation = {
  label: string;
  revision: "reference" | "machine" | "print" | "calibration";
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

export class SlicerProfileSnapshotNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlicerProfileSnapshotNotFoundError";
  }
}

export class SlicerProfileSnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlicerProfileSnapshotIntegrityError";
  }
}

export class SlicerProfileSnapshotUnavailableError extends Error {
  constructor(message = "slicer snapshot storage is unavailable") {
    super(message);
    this.name = "SlicerProfileSnapshotUnavailableError";
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
    // Bootstrap only repairs immutable bytes for rows that may predate this
    // contract. Activation and dispatch validate the bundle before it can be
    // executed, so an unvalidated draft cannot prevent the API from starting.
    await this.provision(
      [
        ...revisions[0].map(({ settings }) => ({
          settings,
          revision: "reference" as const,
        })),
        ...revisions[1].map(({ settings }) => ({
          settings,
          revision: "machine" as const,
        })),
        ...revisions[2].map(({ settings }) => ({
          settings,
          revision: "calibration" as const,
        })),
        ...revisions[3].map(({ settings }) => ({
          settings,
          revision: "print" as const,
        })),
      ],
      false,
    );
  }

  async provisionReferenceProfile(
    revisionId: string,
  ): Promise<SlicerSettingsSnapshot> {
    const revision = await this.prisma.referenceProfile.findUnique({
      where: { id: revisionId },
      select: { settings: true },
    });
    if (!revision) {
      throw new SlicerProfileSnapshotNotFoundError(
        "reference profile revision was not found",
      );
    }
    return this.provisionCommittedSettings(revision.settings, "reference");
  }

  async provisionMachineProfile(
    revisionId: string,
  ): Promise<SlicerSettingsSnapshot> {
    const revision = await this.prisma.machineProfile.findUnique({
      where: { id: revisionId },
      select: { settings: true },
    });
    if (!revision) {
      throw new SlicerProfileSnapshotNotFoundError(
        "machine profile revision was not found",
      );
    }
    return this.provisionCommittedSettings(revision.settings, "machine");
  }

  async provisionMachineCalibration(
    nodeId: string | undefined,
    revisionId: string,
  ): Promise<SlicerSettingsSnapshot> {
    const revision = await this.prisma.machineCalibration.findFirst({
      where: { id: revisionId, ...(nodeId ? { nodeId } : {}) },
      select: { settings: true },
    });
    if (!revision) {
      throw new SlicerProfileSnapshotNotFoundError(
        "machine calibration revision was not found",
      );
    }
    return this.provisionCommittedSettings(revision.settings, "calibration");
  }

  async ensureJobSnapshots(job: SlicingJob): Promise<void> {
    const expectations = await this.expectationsFor(job);
    const snapshots = expectations.map((expectation) => ({
      expectation,
      snapshot: this.snapshot(expectation.settings, expectation.revision),
    }));
    for (const { expectation, snapshot } of snapshots) {
      if (expectation.pointer.contentSha256 !== snapshot.contentSha256) {
        throw new SlicerProfileSnapshotMismatchError(
          `${expectation.label} content hash does not match persisted settings`,
        );
      }
    }
    if (expectations.length > 0) {
      try {
        const uniqueSettings = new Map(
          snapshots.map(({ snapshot, expectation }) => [
            snapshot.contentSha256,
            expectation.settings,
          ]),
        );
        assertPresetBundleAggregateLimits([...uniqueSettings.values()]);
      } catch (error) {
        if (error instanceof PresetBundleValidationError) {
          throw new SlicerProfileSnapshotIntegrityError(error.message);
        }
        throw error;
      }
    }
    await this.provision(expectations);
  }

  private snapshot(
    settings: Prisma.JsonValue,
    revision: SnapshotExpectation["revision"],
  ): SlicerSettingsSnapshot {
    try {
      assertRevisionPresetBundle(settings, revision);
      return slicerSettingsSnapshot(settings);
    } catch (error) {
      if (error instanceof PresetBundleValidationError) {
        throw new SlicerProfileSnapshotIntegrityError(error.message);
      }
      throw error;
    }
  }

  private async provision(
    expectations: readonly Pick<SnapshotExpectation, "settings" | "revision">[],
    validateBundle = true,
  ): Promise<void> {
    const unique = new Map<string, SlicerSettingsSnapshot>();
    for (const { settings, revision } of expectations) {
      const snapshot = validateBundle
        ? this.snapshot(settings, revision)
        : slicerSettingsSnapshot(settings);
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

  private async provisionCommittedSettings(
    settings: Prisma.JsonValue,
    revision: SnapshotExpectation["revision"],
  ): Promise<SlicerSettingsSnapshot> {
    let snapshot: SlicerSettingsSnapshot;
    try {
      snapshot = this.snapshot(settings, revision);
    } catch (error) {
      if (error instanceof SlicerProfileSnapshotMismatchError) {
        throw new SlicerProfileSnapshotIntegrityError(error.message);
      }
      throw error;
    }
    try {
      await this.objects.putImmutableObject({
        objectKey: snapshot.objectKey,
        bytes: snapshot.bytes,
        contentHash: snapshot.contentSha256,
        contentType: "application/json",
      });
    } catch (error) {
      if (error instanceof ImmutableObjectConflictError) {
        throw new SlicerProfileSnapshotIntegrityError(error.message);
      }
      throw new SlicerProfileSnapshotUnavailableError();
    }
    return snapshot;
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
          revision: "reference",
          pointer: job.input.referenceProfile,
          settings: profile.settings,
        },
        {
          label: "print configuration",
          revision: "print",
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
        revision: "machine",
        pointer: job.input.machineProfile,
        settings: profile.settings,
      },
      {
        label: "machine calibration",
        revision: "calibration",
        pointer: job.input.machineCalibration,
        settings: calibration.settings,
      },
      {
        label: "print configuration",
        revision: "print",
        pointer: job.input.printConfig,
        settings: config.settings,
      },
    ];
  }
}
