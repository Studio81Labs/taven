import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SlicingJobSchema,
  slicingResultForJobSchema,
  productionArtifactObjectKey,
  type SlicingJob,
  type SlicingResult,
} from "@taven/slicer-contracts";
import { failureOutcome, SlicingWorkerError } from "./failures.js";
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

function inspectionMetrics(inspection: ModelInspection) {
  return {
    boundingBox: inspection.boundingBox,
    objectCount: inspection.objectCount,
    bodyCount: inspection.bodies.length,
    unitHint: inspection.unitHint,
    scaleAssessment:
      inspection.unitHint === "unknown" ? "confirmation_required" : "trusted",
    suggestedScaleFactorPpm:
      inspection.unitHint === "unknown"
        ? null
        : { millimeter: 1_000_000, inch: 25_400_000, meter: 1_000_000_000 }[
            inspection.unitHint
          ],
    thinWallFeatureCount: 0,
    hasPaintAssignments: inspection.hasPaintAssignments,
    materialAssignmentCount: inspection.materialAssignmentCount,
    extruderAssignmentCount: inspection.extruderAssignmentCount,
  } as const;
}

function paintedFinding(inspection: ModelInspection) {
  const blocked =
    inspection.hasPaintAssignments ||
    inspection.materialAssignmentCount > 1 ||
    inspection.extruderAssignmentCount > 1;
  return blocked
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
    : [];
}

function sliceMetrics(
  inspection: ModelInspection,
  seconds: bigint,
  material: bigint,
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
    thinWallFeatureCount: 0,
    supportVolumeRatioPpm: 0,
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
    const workspace = await mkdtemp(path.join(tmpdir(), "taven-slicer-"));
    try {
      const result = await this.processJob(job, workspace);
      return slicingResultForJobSchema(job).parse(result);
    } catch (error) {
      return slicingResultForJobSchema(job).parse({
        ...envelope(job, this.config.engine),
        outcome: failureOutcome(error),
      });
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
      const objectKey = `reference-slices/${job.jobId}/toolpath.gcode`;
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
            1,
            job.input.geometry.bodyIds.length,
          ),
          findings: [],
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
      return {
        ...envelope(job, this.config.engine),
        outcome: {
          status: "succeeded",
          metrics: sliceMetrics(
            inspected,
            totals.seconds,
            totals.material,
            plates.length,
            job.input.geometry.bodyIds.length,
          ),
          plates,
          occupancySlices,
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
    );
    const totals = sumPlates(plates);
    return {
      ...envelope(job, this.config.engine),
      outcome: {
        status: "succeeded",
        metrics: sliceMetrics(
          inspected,
          totals.seconds,
          totals.material,
          plates.length,
          job.input.geometry.bodyIds.length,
        ),
        plates,
        artifact: {
          format: job.input.machineProfile.productionArtifactFormat,
          objectKey,
          sha256: artifact.sha256,
        },
      },
    };
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
      return {
        ...envelope(job, this.config.engine),
        outcome: {
          status: "succeeded",
          canonicalGeometry: null,
          metrics: inspectionMetrics(inspection),
          bodies: inspection.bodies,
          findings: paintedFinding(inspection),
        },
      };
    }
    const operation = job.input.operation;
    const canonical = canonicalizeModel(
      job.input.source.format,
      source.bytes,
      operation.bodyIds,
      operation.confirmedUnitConversion.scaleFactorPpm,
    );
    await this.store.write(
      operation.targetGeometry.canonicalObjectKey,
      canonical.bytes,
      "model/stl",
    );
    const bodies = canonical.inspection.bodies.map((item, index) => ({
      ...item,
      bodyId: operation.bodyIds[index]!,
    }));
    const resultInspection = { ...canonical.inspection, bodies };
    return {
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
        findings: [],
      },
    };
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
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const cached = await this.store.read(
      objectKey,
      this.config.limits.artifactBytes,
    );
    if (cached) return cached;
    const bytes = await produce();
    const producedSha256 = sha256(bytes);
    try {
      const stored = await this.store.write(objectKey, bytes, contentType);
      return { bytes, sha256: stored.sha256 };
    } catch (error) {
      const winner = await this.store.read(
        objectKey,
        this.config.limits.artifactBytes,
      );
      if (winner?.sha256 === producedSha256) return winner;
      throw error;
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
        };
        if (
          value.schemaVersion === 1 &&
          value.cacheIdentitySha256 === target.cacheIdentitySha256 &&
          value.partsPerPlate === target.partsPerPlate &&
          /^[1-9]\d*$/u.test(value.estimatedPrintSeconds) &&
          /^[1-9]\d*$/u.test(value.estimatedMaterialMilligrams)
        ) {
          return {
            partsPerPlate: target.partsPerPlate,
            cacheIdentitySha256: target.cacheIdentitySha256,
            estimatedPrintSeconds: value.estimatedPrintSeconds,
            estimatedMaterialMilligrams: value.estimatedMaterialMilligrams,
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
        schemaVersion: 1,
        cacheIdentitySha256: target.cacheIdentitySha256,
        partsPerPlate: target.partsPerPlate,
        estimatedPrintSeconds: sliced.estimatedPrintSeconds.toString(),
        estimatedMaterialMilligrams:
          sliced.estimatedMaterialMilligrams.toString(),
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
