import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SLICING_MESSAGE_MAX_BYTES,
  SlicingJobSchema,
  slicingResultForJobSchema,
  productionArtifactObjectKey,
  referenceArtifactObjectKey,
  type SlicingJob,
  type SlicingResult,
} from "@taven/slicer-contracts";
import {
  failureOutcome,
  RetryableSlicingResultError,
  SlicingWorkerError,
} from "./failures.js";
import {
  canonicalizeModel,
  inspectModel,
  type ModelInspection,
} from "./model-inspection.js";
import { sha256, type WorkerObjectStore } from "./object-store.js";
import {
  parseOrcaArtifact,
  type OrcaEngine,
  type OrcaSliceOutput,
} from "./orca-engine.js";
import type { WorkerConfig } from "./config.js";

type Revision = { contentSha256: string };

function envelope(job: SlicingJob, engine: WorkerConfig["engine"]) {
  return {
    contractVersion: job.contractVersion,
    kind: job.kind,
    jobId: job.jobId,
    correlationId: job.correlationId,
    inputFingerprintSha256: job.inputFingerprintSha256,
    idempotencyKey: job.idempotencyKey,
    attempt: job.attempt,
    input: job.input,
    engine: {
      name: engine.name,
      version: engine.version,
      imageSha256: engine.imageSha256,
    },
  } as const;
}

function assertResultEnvelopeSize(
  result: unknown,
  operation: "Inspection" | "Production",
): void {
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > SLICING_MESSAGE_MAX_BYTES) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      `${operation} result exceeds the slicing message size limit`,
    );
  }
}

function inspectionMetrics(inspection: ModelInspection) {
  return {
    boundingBox: inspection.boundingBox,
    objectCount: inspection.objectCount,
    bodyCount: inspection.bodies.length,
    unitHint: inspection.unitHint,
    scaleAssessment:
      inspection.unitHint === "unknown"
        ? "confirmation_required"
        : inspection.unitHint === "millimeter"
          ? "trusted"
          : "converted",
    suggestedScaleFactorPpm:
      inspection.unitHint === "unknown" || inspection.unitHint === "millimeter"
        ? null
        : {
            micron: 1_000,
            centimeter: 10_000_000,
            inch: 25_400_000,
            foot: 304_800_000,
            meter: 1_000_000_000,
          }[inspection.unitHint],
    thinWallFeatureCount: 0,
    hasPaintAssignments: inspection.hasPaintAssignments,
    materialAssignmentCount: inspection.materialAssignmentCount,
    extruderAssignmentCount: inspection.extruderAssignmentCount,
  } as const;
}

function inspectionFindings(inspection: ModelInspection) {
  const invalidTopology = inspection.bodies.some(
    ({ topology }) =>
      !topology.watertight ||
      !topology.manifold ||
      topology.normals !== "consistent",
  );
  const paintedOrMultimaterial =
    inspection.hasPaintAssignments ||
    inspection.materialAssignmentCount > 1 ||
    inspection.extruderAssignmentCount > 1;
  return [
    ...(invalidTopology
      ? [
          {
            code: "INVALID_TOPOLOGY",
            severity: "blocking" as const,
            phase: "inspection" as const,
            message:
              "Open, non-manifold, or inconsistent mesh topology requires a repaired model or individual offer",
            acknowledgementKey: null,
          },
        ]
      : []),
    ...(paintedOrMultimaterial
      ? [
          {
            code: "PAINTED_OR_MULTIMATERIAL",
            severity: "blocking" as const,
            phase: "inspection" as const,
            message:
              "Painted or multimaterial input requires an individual offer",
            acknowledgementKey: null,
          },
        ]
      : []),
  ];
}

type PreflightMetrics = Pick<
  OrcaSliceOutput,
  "thinWallFeatureCount" | "supportVolumeRatioPpm"
>;

function referenceFindings(metrics: PreflightMetrics) {
  return [
    ...(metrics.thinWallFeatureCount > 0
      ? [
          {
            code: "THIN_WALLS",
            severity: "warning" as const,
            phase: "reference_slice" as const,
            message:
              "The reference slice contains thin-wall toolpaths that may need review",
            acknowledgementKey: "thin-walls",
          },
        ]
      : []),
    ...(metrics.supportVolumeRatioPpm > 0
      ? [
          {
            code: "SUPPORT_MATERIAL",
            severity: "warning" as const,
            phase: "reference_slice" as const,
            message:
              "The reference slice requires support material that affects finishing",
            acknowledgementKey: "support-material",
          },
        ]
      : []),
  ];
}

function sliceMetrics(
  inspection: ModelInspection,
  seconds: bigint,
  material: bigint,
  preflight: PreflightMetrics,
  plateCount: number,
  bodyCount = inspection.bodies.length,
) {
  const topology = inspection.bodies.reduce<{
    watertight: boolean;
    manifold: boolean;
    normals: "consistent" | "inconsistent" | "unknown";
  }>(
    (value, item) => ({
      watertight: value.watertight && item.topology.watertight,
      manifold: value.manifold && item.topology.manifold,
      normals:
        value.normals === "inconsistent" ||
        item.topology.normals === "inconsistent"
          ? ("inconsistent" as const)
          : value.normals === "unknown" || item.topology.normals === "unknown"
            ? ("unknown" as const)
            : ("consistent" as const),
    }),
    { watertight: true, manifold: true, normals: "consistent" },
  );
  return {
    boundingBox: inspection.boundingBox,
    objectCount: 1,
    bodyCount,
    topology,
    thinWallFeatureCount: preflight.thinWallFeatureCount,
    supportVolumeRatioPpm: preflight.supportVolumeRatioPpm,
    hasPaintAssignments: inspection.hasPaintAssignments,
    materialAssignmentCount: inspection.materialAssignmentCount,
    estimatedPrintSeconds: seconds.toString(),
    estimatedMaterialMilligrams: material.toString(),
    plateCount,
  };
}

export class SlicingProcessor {
  constructor(
    private readonly store: WorkerObjectStore,
    private readonly engine: OrcaEngine,
    private readonly config: Pick<WorkerConfig, "engine" | "limits">,
  ) {}

  async process(input: unknown): Promise<SlicingResult> {
    const job = SlicingJobSchema.parse(input);
    try {
      const result = await this.processInWorkspace(job);
      return slicingResultForJobSchema(job).parse(result);
    } catch (error) {
      const result = slicingResultForJobSchema(job).parse({
        ...envelope(job, this.config.engine),
        outcome: failureOutcome(error),
      });
      if (
        result.outcome.status === "failed" &&
        result.outcome.failureClass === "retryable_infrastructure"
      ) {
        throw new RetryableSlicingResultError(result);
      }
      return result;
    }
  }

  private async processInWorkspace(job: SlicingJob): Promise<unknown> {
    let workspace: string;
    try {
      workspace = await mkdtemp(path.join(tmpdir(), "taven-slicer-"));
    } catch {
      throw new SlicingWorkerError(
        "retryable_infrastructure",
        "TEMPORARY_CAPACITY",
        "Temporary slicing workspace is unavailable",
      );
    }
    try {
      return await this.processJob(job, workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  private async processJob(
    job: SlicingJob,
    workspace: string,
  ): Promise<unknown> {
    if (job.kind === "model_inspection") {
      return this.inspect(job, workspace);
    }
    const geometry = await this.store.read(
      job.input.geometry.canonicalObjectKey,
      this.config.limits.sourceBytes,
      job.input.geometry.geometrySha256,
    );
    if (!geometry) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "INVALID_GEOMETRY",
        "Canonical geometry object is missing",
      );
    }
    const geometryPath = path.join(workspace, "geometry.stl");
    await writeFile(geometryPath, geometry.bytes, { mode: 0o400 });
    const inspected = inspectModel("stl", geometry.bytes);
    if (job.kind === "reference_slice") {
      const profiles = await this.profiles(workspace, [
        job.input.referenceProfile,
        job.input.printConfig,
      ]);
      const objectKey = referenceArtifactObjectKey(job.inputFingerprintSha256);
      const artifact = await this.reusableArtifact(
        objectKey,
        "text/x.gcode",
        async () =>
          (
            await this.engine.slice({
              workspace,
              geometryPath,
              profilePaths: profiles,
              copies: job.input.partsPerPlate,
              artifactFormat: "gcode",
            })
          ).artifactBytes,
      );
      const metrics = parseOrcaArtifact(
        artifact.bytes,
        this.config.engine.version,
      );
      return {
        ...envelope(job, this.config.engine),
        outcome: {
          status: "succeeded",
          metrics: sliceMetrics(
            inspected,
            metrics.estimatedPrintSeconds,
            metrics.estimatedMaterialMilligrams,
            metrics,
            1,
            job.input.geometry.bodyIds.length,
          ),
          findings: referenceFindings(metrics),
          artifact: {
            objectKey,
            sha256: artifact.sha256,
          },
        },
      };
    }
    const profiles = await this.profiles(workspace, [
      job.input.machineProfile,
      job.input.machineCalibration,
      job.input.printConfig,
    ]);
    if (job.kind === "candidate_estimate") {
      const occupancySlices = [];
      for (const target of job.input.occupancySliceTargets) {
        occupancySlices.push(
          await this.machineOccupancy(
            job,
            workspace,
            geometryPath,
            profiles,
            target,
          ),
        );
      }
      const byParts = new Map(
        occupancySlices.map((slice) => [slice.partsPerPlate, slice]),
      );
      const parts = plateParts(job.input.quantity, job.input.partsPerPlate);
      const plates = parts.map((partsOnPlate, index) => {
        const occupancy = byParts.get(partsOnPlate)!;
        return {
          plateOrdinal: index + 1,
          partsOnPlate,
          estimatedPrintSeconds: occupancy.estimatedPrintSeconds,
          estimatedMaterialMilligrams: occupancy.estimatedMaterialMilligrams,
        };
      });
      const totals = sumPlates(plates);
      const preflight = aggregatePreflight(parts, (partsOnPlate) =>
        byParts.get(partsOnPlate)!,
      );
      return {
        ...envelope(job, this.config.engine),
        outcome: {
          status: "succeeded",
          metrics: sliceMetrics(
            inspected,
            totals.seconds,
            totals.material,
            preflight,
            plates.length,
            job.input.geometry.bodyIds.length,
          ),
          plates,
          occupancySlices: occupancySlices.map((slice) => ({
            partsPerPlate: slice.partsPerPlate,
            cacheIdentitySha256: slice.cacheIdentitySha256,
            estimatedPrintSeconds: slice.estimatedPrintSeconds,
            estimatedMaterialMilligrams: slice.estimatedMaterialMilligrams,
            artifact: slice.artifact,
          })),
        },
      };
    }
    const parts = plateParts(job.input.quantity, job.input.partsPerPlate);
    const occupancy = new Map<number, OrcaSliceOutput>();
    for (const count of new Set(parts)) {
      occupancy.set(
        count,
        await this.engine.slice({
          workspace,
          geometryPath,
          profilePaths: profiles,
          copies: count,
          artifactFormat: "gcode",
        }),
      );
    }
    const plates = parts.map((partsOnPlate, index) => ({
      plateOrdinal: index + 1,
      partsOnPlate,
      estimatedPrintSeconds: occupancy
        .get(partsOnPlate)!
        .estimatedPrintSeconds.toString(),
      estimatedMaterialMilligrams: occupancy
        .get(partsOnPlate)!
        .estimatedMaterialMilligrams.toString(),
    }));
    const objectKey = productionArtifactObjectKey(
      job.input.acceptedJobId,
      job.input.machineProfile.productionArtifactFormat,
    );
    if (
      parts.length > 1 &&
      job.input.machineProfile.productionArtifactFormat !== "gcode_3mf"
    ) {
      throw new SlicingWorkerError(
        "unsupported_input",
        "UNSUPPORTED_FEATURE",
        "Multi-plate production requires a G-code 3MF package",
      );
    }
    const totals = sumPlates(plates);
    const preflight = aggregatePreflight(parts, (partsOnPlate) =>
      occupancy.get(partsOnPlate)!,
    );
    const resultForArtifact = (artifactSha256: string) => ({
      ...envelope(job, this.config.engine),
      outcome: {
        status: "succeeded" as const,
        metrics: sliceMetrics(
          inspected,
          totals.seconds,
          totals.material,
          preflight,
          plates.length,
          job.input.geometry.bodyIds.length,
        ),
        plates,
        artifact: {
          format: job.input.machineProfile.productionArtifactFormat,
          objectKey,
          sha256: artifactSha256,
        },
      },
    });
    const artifact = await this.reusableArtifact(
      objectKey,
      "application/octet-stream",
      async () =>
        (
          await this.engine.slice({
            workspace,
            geometryPath,
            profilePaths: profiles,
            copies: job.input.quantity,
            copiesPerPlate: parts,
            artifactFormat: job.input.machineProfile.productionArtifactFormat,
            requireMetrics: false,
          })
        ).artifactBytes,
      job.inputFingerprintSha256,
      ({ sha256: artifactSha256 }) => {
        const result = resultForArtifact(artifactSha256);
        assertResultEnvelopeSize(result, "Production");
        slicingResultForJobSchema(job).parse(result);
      },
    );
    return resultForArtifact(artifact.sha256);
  }

  private async inspect(
    job: Extract<SlicingJob, { kind: "model_inspection" }>,
    _workspace: string,
  ) {
    const source = await this.store.read(
      job.input.source.objectKey,
      this.config.limits.sourceBytes,
      job.input.source.contentSha256,
    );
    if (!source) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "INVALID_MODEL",
        "Source model object is missing",
      );
    }
    if (job.input.operation.mode === "inspect_source") {
      const inspection = inspectModel(job.input.source.format, source.bytes);
      const result = {
        ...envelope(job, this.config.engine),
        outcome: {
          status: "succeeded",
          canonicalGeometry: null,
          metrics: inspectionMetrics(inspection),
          bodies: inspection.bodies,
          findings: inspectionFindings(inspection),
        },
      };
      assertResultEnvelopeSize(result, "Inspection");
      return result;
    }
    const operation = job.input.operation;
    const canonical = canonicalizeModel(
      job.input.source.format,
      source.bytes,
      operation.bodyIds,
      operation.confirmedUnitConversion.scaleFactorPpm,
    );
    const bodies = canonical.inspection.bodies.map((item, index) => ({
      ...item,
      bodyId: operation.bodyIds[index]!,
    }));
    const resultInspection = { ...canonical.inspection, bodies };
    const result = {
      ...envelope(job, this.config.engine),
      outcome: {
        status: "succeeded",
        canonicalGeometry: {
          ...operation.targetGeometry,
          geometrySha256: canonical.sha256,
          bodyIds: operation.bodyIds,
          selectionSha256: operation.selectionSha256,
          appliedUnitConversion: operation.confirmedUnitConversion,
        },
        metrics: inspectionMetrics(resultInspection),
        bodies,
        findings: inspectionFindings(resultInspection),
      },
    };
    assertResultEnvelopeSize(result, "Inspection");
    await this.store.write(
      operation.targetGeometry.canonicalObjectKey,
      canonical.bytes,
      "model/stl",
    );
    return result;
  }

  private async profiles(
    workspace: string,
    revisions: readonly Revision[],
  ): Promise<string[]> {
    const directory = path.join(workspace, "profiles");
    await mkdir(directory, { recursive: true });
    const unique = [
      ...new Set(revisions.map((revision) => revision.contentSha256)),
    ];
    return Promise.all(
      unique.map(async (digest) => {
        const profile = await this.store.read(
          `slicer-revisions/${digest}/settings.json`,
          1024 * 1024,
          digest,
        );
        if (!profile) {
          throw new SlicingWorkerError(
            "deterministic_invalid",
            "INVALID_PROFILE",
            "Immutable slicer profile snapshot is missing",
          );
        }
        const destination = path.join(directory, `${digest}.json`);
        await writeFile(destination, profile.bytes, { mode: 0o400 });
        return destination;
      }),
    );
  }

  private async reusableArtifact(
    objectKey: string,
    contentType: string,
    produce: () => Promise<Uint8Array>,
    immutableInputFingerprintSha256?: string,
    validate?: (artifact: { bytes: Uint8Array; sha256: string }) => void,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const cached = await this.store.read(
      objectKey,
      this.config.limits.artifactBytes,
    );
    if (cached) {
      this.assertReusableIdentity(cached, immutableInputFingerprintSha256);
      validate?.(cached);
      return cached;
    }
    const bytes = await produce();
    const producedSha256 = sha256(bytes);
    validate?.({ bytes, sha256: producedSha256 });
    try {
      const stored = await this.store.write(
        objectKey,
        bytes,
        contentType,
        immutableInputFingerprintSha256,
      );
      return { bytes, sha256: stored.sha256 };
    } catch (error) {
      const winner = await this.store.read(
        objectKey,
        this.config.limits.artifactBytes,
      );
      if (winner?.sha256 === producedSha256) {
        this.assertReusableIdentity(winner, immutableInputFingerprintSha256);
        validate?.(winner);
        return winner;
      }
      throw error;
    }
  }

  private assertReusableIdentity(
    stored: {
      sha256: string;
      immutableInputFingerprintSha256?: string;
      metadataContentSha256?: string;
    },
    immutableInputFingerprintSha256?: string,
  ): void {
    if (
      immutableInputFingerprintSha256 !== undefined &&
      (stored.immutableInputFingerprintSha256 !==
        immutableInputFingerprintSha256 ||
        stored.metadataContentSha256 !== stored.sha256)
    ) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "INVALID_MODEL",
        "Cached production artifact does not match its immutable slicing input",
      );
    }
  }

  private async machineOccupancy(
    job: Extract<SlicingJob, { kind: "candidate_estimate" }>,
    workspace: string,
    geometryPath: string,
    profiles: readonly string[],
    target: (typeof job.input.occupancySliceTargets)[number],
  ) {
    const cached = await this.store.read(target.analysisObjectKey, 64 * 1024);
    if (cached) {
      try {
        const value = JSON.parse(new TextDecoder().decode(cached.bytes)) as {
          schemaVersion: number;
          cacheIdentitySha256: string;
          partsPerPlate: number;
          estimatedPrintSeconds: string;
          estimatedMaterialMilligrams: string;
          thinWallFeatureCount: number;
          supportVolumeRatioPpm: number;
        };
        if (
          value.schemaVersion === 2 &&
          value.cacheIdentitySha256 === target.cacheIdentitySha256 &&
          value.partsPerPlate === target.partsPerPlate &&
          /^[1-9]\d*$/u.test(value.estimatedPrintSeconds) &&
          /^[1-9]\d*$/u.test(value.estimatedMaterialMilligrams) &&
          Number.isSafeInteger(value.thinWallFeatureCount) &&
          value.thinWallFeatureCount >= 0 &&
          value.thinWallFeatureCount <= 1_000_000 &&
          Number.isSafeInteger(value.supportVolumeRatioPpm) &&
          value.supportVolumeRatioPpm >= 0 &&
          value.supportVolumeRatioPpm <= 1_000_000
        ) {
          return {
            partsPerPlate: target.partsPerPlate,
            cacheIdentitySha256: target.cacheIdentitySha256,
            estimatedPrintSeconds: value.estimatedPrintSeconds,
            estimatedMaterialMilligrams: value.estimatedMaterialMilligrams,
            thinWallFeatureCount: value.thinWallFeatureCount,
            supportVolumeRatioPpm: value.supportVolumeRatioPpm,
            artifact: {
              objectKey: target.analysisObjectKey,
              sha256: cached.sha256,
            },
          };
        }
      } catch {
        // Fall through to the immutable cache-corruption failure below.
      }
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "INVALID_PROFILE",
        "Persisted occupancy cache does not match its immutable identity",
      );
    }
    const sliced = await this.engine.slice({
      workspace,
      geometryPath,
      profilePaths: profiles,
      copies: target.partsPerPlate,
      artifactFormat: "gcode",
    });
    const payload = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        cacheIdentitySha256: target.cacheIdentitySha256,
        partsPerPlate: target.partsPerPlate,
        estimatedPrintSeconds: sliced.estimatedPrintSeconds.toString(),
        estimatedMaterialMilligrams:
          sliced.estimatedMaterialMilligrams.toString(),
        thinWallFeatureCount: sliced.thinWallFeatureCount,
        supportVolumeRatioPpm: sliced.supportVolumeRatioPpm,
      }),
    );
    const stored = await this.store.write(
      target.analysisObjectKey,
      payload,
      "application/json",
    );
    return {
      partsPerPlate: target.partsPerPlate,
      cacheIdentitySha256: target.cacheIdentitySha256,
      estimatedPrintSeconds: sliced.estimatedPrintSeconds.toString(),
      estimatedMaterialMilligrams:
        sliced.estimatedMaterialMilligrams.toString(),
      thinWallFeatureCount: sliced.thinWallFeatureCount,
      supportVolumeRatioPpm: sliced.supportVolumeRatioPpm,
      artifact: { objectKey: target.analysisObjectKey, sha256: stored.sha256 },
    };
  }
}

function plateParts(quantity: number, partsPerPlate: number): number[] {
  const result: number[] = [];
  for (let remaining = quantity; remaining > 0; remaining -= partsPerPlate) {
    result.push(Math.min(remaining, partsPerPlate));
  }
  return result;
}

function sumPlates(
  plates: readonly {
    estimatedPrintSeconds: string;
    estimatedMaterialMilligrams: string;
  }[],
) {
  return plates.reduce(
    (total, plate) => ({
      seconds: total.seconds + BigInt(plate.estimatedPrintSeconds),
      material: total.material + BigInt(plate.estimatedMaterialMilligrams),
    }),
    { seconds: 0n, material: 0n },
  );
}

function aggregatePreflight<
  T extends PreflightMetrics & {
    estimatedMaterialMilligrams: string | bigint;
  },
>(
  plateParts: readonly number[],
  metricsForParts: (partsPerPlate: number) => T,
): PreflightMetrics {
  let material = 0n;
  let weightedSupport = 0n;
  let thinWallFeatureCount = 0;
  for (const partsPerPlate of plateParts) {
    const metrics = metricsForParts(partsPerPlate);
    const plateMaterial = BigInt(metrics.estimatedMaterialMilligrams);
    material += plateMaterial;
    weightedSupport += plateMaterial * BigInt(metrics.supportVolumeRatioPpm);
    thinWallFeatureCount += metrics.thinWallFeatureCount;
  }
  if (thinWallFeatureCount > 1_000_000) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "Slicer preflight feature count exceeds the supported limit",
    );
  }
  return {
    thinWallFeatureCount,
    supportVolumeRatioPpm:
      material === 0n
        ? 0
        : Number((weightedSupport + material / 2n) / material),
  };
}
