import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import {
  geometrySelectionSha256,
  machineOccupancyCacheIdentitySha256,
  referenceArtifactObjectKey,
  slicingInputFingerprint,
  type SlicingJob,
  type SlicingJobKind,
} from "@taven/slicer-contracts";
import { describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "./config.js";
import { RetryableSlicingResultError, SlicingWorkerError } from "./failures.js";
import { sha256, type WorkerObjectStore } from "./object-store.js";
import type { OrcaEngine, OrcaSliceRequest } from "./orca-engine.js";
import { SlicingProcessor } from "./processor.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

const ids = {
  source: "00000000-0000-4000-8000-000000000001",
  geometry: "00000000-0000-4000-8000-000000000002",
  job: "00000000-0000-4000-8000-000000000003",
  correlation: "00000000-0000-4000-8000-000000000004",
  machine: "00000000-0000-4000-8000-000000000005",
  machineProfile: "00000000-0000-4000-8000-000000000006",
  calibration: "00000000-0000-4000-8000-000000000007",
  printConfig: "00000000-0000-4000-8000-000000000008",
  arrangement: "00000000-0000-4000-8000-000000000009",
  shipment: "00000000-0000-4000-8000-000000000010",
};

const core3mfNamespace =
  "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

function storedZip(entries: Readonly<Record<string, string>>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(value);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(contents.byteLength, 18);
    localHeader.writeUInt32LE(contents.byteLength, 22);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(contents.byteLength, 20);
    centralHeader.writeUInt32LE(contents.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
    centralHeader.writeUInt32LE(offset, 42);
    local.push(localHeader, nameBytes, contents);
    central.push(centralHeader, nameBytes);
    offset +=
      localHeader.byteLength + nameBytes.byteLength + contents.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function repeatedBody3mf(count: number): Uint8Array {
  const items = Array.from(
    { length: count },
    () => '<item objectid="1"/>',
  ).join("");
  return storedZip({
    "3D/3dmodel.model": `<model xmlns="${core3mfNamespace}" unit="millimeter">
      <resources><object id="1"><mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
          <triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>
        </triangles>
      </mesh></object></resources>
      <build>${items}</build>
    </model>`,
  });
}

class MemoryStore implements WorkerObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly metadata = new Map<
    string,
    {
      immutableInputFingerprintSha256: string;
      metadataContentSha256: string;
    }
  >();
  readonly writes: string[] = [];

  async read(key: string, maximum: number, expected?: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    if (bytes.byteLength > maximum)
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "RESOURCE_LIMIT_EXCEEDED",
        "too large",
      );
    const digest = sha256(bytes);
    if (expected && expected !== digest)
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "INVALID_MODEL",
        "checksum mismatch",
      );
    return { bytes, sha256: digest, ...this.metadata.get(key) };
  }

  async write(
    key: string,
    bytes: Uint8Array,
    _contentType?: string,
    immutableInputFingerprintSha256?: string,
  ) {
    const existing = this.objects.get(key);
    const digest = sha256(bytes);
    const existingMetadata = this.metadata.get(key);
    if (
      existing &&
      (sha256(existing) !== digest ||
        (immutableInputFingerprintSha256 !== undefined &&
          (existingMetadata?.immutableInputFingerprintSha256 !==
            immutableInputFingerprintSha256 ||
            existingMetadata.metadataContentSha256 !== digest)))
    )
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "INVALID_MODEL",
        "conflict",
      );
    this.objects.set(key, new Uint8Array(bytes));
    if (immutableInputFingerprintSha256 !== undefined) {
      this.metadata.set(key, {
        immutableInputFingerprintSha256,
        metadataContentSha256: digest,
      });
    }
    this.writes.push(key);
    return { sha256: digest, cacheHit: existing !== undefined };
  }

  async delete(key: string) {
    this.objects.delete(key);
    this.metadata.delete(key);
  }
}

class ConflictingWriteStore extends MemoryStore {
  conflictKey: string | null = null;

  override async write(
    key: string,
    bytes: Uint8Array,
    contentType?: string,
    immutableInputFingerprintSha256?: string,
  ) {
    if (key === this.conflictKey && !this.objects.has(key)) {
      this.objects.set(key, new TextEncoder().encode("different artifact"));
    }
    return super.write(
      key,
      bytes,
      contentType,
      immutableInputFingerprintSha256,
    );
  }
}

class FakeEngine implements OrcaEngine {
  readonly calls: OrcaSliceRequest[] = [];

  constructor(private readonly thinWallFeatureCount = 1) {}

  async slice(input: OrcaSliceRequest) {
    this.calls.push(input);
    const gcode = `; generated by OrcaSlicer 2.4.2 on 2026-08-31 at 12:00:00\n; total estimated time: ${input.copies}m 0s\n; filament used [g] = ${input.copies}\n; EXECUTABLE_BLOCK_START\nM83\n; CHANGE_LAYER\n; FEATURE: Outer wall\nG1 X1 E2\n; FEATURE: Support\nG1 X2 E1\n; FEATURE: Gap infill\nG1 X3 E1\nM104 S0\n; EXECUTABLE_BLOCK_END\n`;
    const plateCount = input.copiesPerPlate?.length ?? 1;
    const packageEntries: Record<string, string> = {
      "Metadata/slice_info.config": "<config/>\n",
    };
    for (let plate = 1; plate <= plateCount; plate += 1) {
      const name = `Metadata/plate_${plate}.gcode`;
      packageEntries[name] = gcode;
      packageEntries[`${name}.md5`] = createHash("md5")
        .update(gcode)
        .digest("hex")
        .toUpperCase();
    }
    return {
      estimatedPrintSeconds: BigInt(input.copies * 60),
      estimatedMaterialMilligrams: BigInt(input.copies * 1_000),
      thinWallFeatureCount: this.thinWallFeatureCount,
      supportVolumeRatioPpm: 250_000,
      artifactBytes:
        input.artifactFormat === "gcode_3mf"
          ? storedZip(packageEntries)
          : new TextEncoder().encode(gcode),
    };
  }
}

class InvalidProductionArtifactEngine extends FakeEngine {
  override async slice(input: OrcaSliceRequest) {
    const result = await super.slice(input);
    return input.requireMetrics === false
      ? { ...result, artifactBytes: new Uint8Array() }
      : result;
  }
}

const config: Pick<WorkerConfig, "engine" | "limits"> = {
  engine: {
    executable: "/opt/orca/AppRun",
    name: "orcaslicer",
    version: "2.4.2",
    imageSha256: "a".repeat(64),
    timeoutMilliseconds: 1_000,
    runnerRoot: "/unused",
  },
  limits: {
    sourceBytes: 10 * 1024 * 1024,
    artifactBytes: 10 * 1024 * 1024,
    diagnosticBytes: 1024,
  },
};

function envelope<K extends SlicingJobKind>(kind: K, input: unknown) {
  const fingerprint = slicingInputFingerprint(kind, input);
  return {
    contractVersion: 2,
    kind,
    jobId: ids.job,
    correlationId: ids.correlation,
    inputFingerprintSha256: fingerprint,
    idempotencyKey: `slicer:v2:${kind}:${ids.job}:${fingerprint}`,
    attempt: 1,
    input,
  };
}

describe("SlicingProcessor", () => {
  it("rejects with a validated envelope when workspace creation fails", async () => {
    vi.mocked(mkdtemp).mockRejectedValueOnce(
      Object.assign(new Error("temporary workspace is full"), {
        code: "ENOSPC",
      }),
    );
    const input = {
      source: {
        modelFileId: ids.source,
        format: "stl",
        objectKey: `models/${ids.source}/source`,
        contentSha256: "a".repeat(64),
      },
      operation: { mode: "inspect_source" },
      inspectionRevision: "inspection-v1",
      inspectionConfigSha256: "b".repeat(64),
      canonicalizerRevision: "canonicalizer-v1",
      canonicalizerConfigSha256: "c".repeat(64),
    };

    await expect(
      new SlicingProcessor(new MemoryStore(), new FakeEngine(), config).process(
        envelope("model_inspection", input),
      ),
    ).rejects.toMatchObject({
      name: "RetryableSlicingResultError",
      result: {
        outcome: {
          status: "failed",
          failureClass: "retryable_infrastructure",
          code: "TEMPORARY_CAPACITY",
        },
      },
    } satisfies Partial<RetryableSlicingResultError>);
  });

  it("rejects with a validated envelope for retryable infrastructure failures", async () => {
    const store = new MemoryStore();
    store.read = async () => {
      throw new SlicingWorkerError(
        "retryable_infrastructure",
        "OBJECT_STORE_UNAVAILABLE",
        "temporary object storage failure",
        5_000,
      );
    };
    const input = {
      source: {
        modelFileId: ids.source,
        format: "stl",
        objectKey: `models/${ids.source}/source`,
        contentSha256: "a".repeat(64),
      },
      operation: { mode: "inspect_source" },
      inspectionRevision: "inspection-v1",
      inspectionConfigSha256: "b".repeat(64),
      canonicalizerRevision: "canonicalizer-v1",
      canonicalizerConfigSha256: "c".repeat(64),
    };

    await expect(
      new SlicingProcessor(store, new FakeEngine(), config).process(
        envelope("model_inspection", input),
      ),
    ).rejects.toMatchObject({
      name: "RetryableSlicingResultError",
      result: {
        outcome: {
          status: "failed",
          failureClass: "retryable_infrastructure",
          code: "OBJECT_STORE_UNAVAILABLE",
        },
      },
    } satisfies Partial<RetryableSlicingResultError>);
  });

  it("returns inspection metadata and no canonical artifact during discovery", async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine();
    const model = await readFile(
      path.resolve("../../tools/slicing-fixtures/fixtures/single-pla/cube.stl"),
    );
    const sourceHash = sha256(model);
    store.objects.set(`models/${ids.source}/source`, model);
    const input = {
      source: {
        modelFileId: ids.source,
        format: "stl",
        objectKey: `models/${ids.source}/source`,
        contentSha256: sourceHash,
      },
      operation: { mode: "inspect_source" },
      inspectionRevision: "inspection-v1",
      inspectionConfigSha256: "b".repeat(64),
      canonicalizerRevision: "canonicalizer-v1",
      canonicalizerConfigSha256: "c".repeat(64),
    };
    const result = await new SlicingProcessor(store, engine, config).process(
      envelope("model_inspection", input),
    );
    expect(result.outcome.status).toBe("succeeded");
    if (
      result.kind !== "model_inspection" ||
      result.outcome.status !== "succeeded"
    )
      return;
    expect(result.outcome.canonicalGeometry).toBeNull();
    expect(result.outcome.metrics.scaleAssessment).toBe(
      "confirmation_required",
    );
    expect(store.writes).toEqual([]);
    expect(engine.calls).toHaveLength(0);
  });

  it("rejects oversized inspection results before artifact upload", async () => {
    const store = new MemoryStore();
    const processor = new SlicingProcessor(store, new FakeEngine(), config);
    const source = repeatedBody3mf(256);
    const sourceHash = sha256(source);
    const sourceKey = `models/${ids.source}/source`;
    const canonicalKey = `geometries/${ids.geometry}/canonical`;
    store.objects.set(sourceKey, source);
    const sourceInput = {
      source: {
        modelFileId: ids.source,
        format: "3mf" as const,
        objectKey: sourceKey,
        contentSha256: sourceHash,
      },
      operation: { mode: "inspect_source" as const },
      inspectionRevision: "inspection-v1",
      inspectionConfigSha256: "b".repeat(64),
      canonicalizerRevision: "canonicalizer-v1",
      canonicalizerConfigSha256: "c".repeat(64),
    };
    const discoveryResult = await processor.process(
      envelope("model_inspection", sourceInput),
    );
    expect(discoveryResult.outcome).toMatchObject({
      status: "failed",
      failureClass: "deterministic_invalid",
      code: "RESOURCE_LIMIT_EXCEEDED",
      retryable: false,
    });
    const bodyIds = Array.from(
      { length: 256 },
      (_, index) => `body-${String(index + 1).padStart(4, "0")}`,
    );
    const input = {
      ...sourceInput,
      operation: {
        mode: "canonicalize_selection" as const,
        sourceInspectionFingerprintSha256: slicingInputFingerprint(
          "model_inspection",
          sourceInput,
        ),
        bodyIds,
        selectionSha256: geometrySelectionSha256(bodyIds),
        confirmedUnitConversion: {
          sourceUnit: "millimeter" as const,
          targetUnit: "millimeter" as const,
          scaleFactorPpm: 1_000_000,
        },
        targetGeometry: {
          modelGeometryId: ids.geometry,
          canonicalObjectKey: canonicalKey,
        },
      },
    };

    const result = await processor.process(envelope("model_inspection", input));

    expect(result.outcome).toMatchObject({
      status: "failed",
      failureClass: "deterministic_invalid",
      code: "RESOURCE_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(store.writes).toEqual([]);
    expect(store.objects.has(canonicalKey)).toBe(false);
  });

  it("blocks automatic quoting for open mesh topology", async () => {
    const store = new MemoryStore();
    const model = await readFile(
      path.resolve("../../tools/slicing-fixtures/fixtures/single-pla/cube.stl"),
    );
    const openModel = new TextEncoder().encode(
      new TextDecoder()
        .decode(model)
        .replace(/ {2}facet normal 0 0 -1[\s\S]*? {2}endfacet\n/u, ""),
    );
    const sourceHash = sha256(openModel);
    store.objects.set(`models/${ids.source}/source`, openModel);
    const input = {
      source: {
        modelFileId: ids.source,
        format: "stl",
        objectKey: `models/${ids.source}/source`,
        contentSha256: sourceHash,
      },
      operation: { mode: "inspect_source" },
      inspectionRevision: "inspection-v1",
      inspectionConfigSha256: "b".repeat(64),
      canonicalizerRevision: "canonicalizer-v1",
      canonicalizerConfigSha256: "c".repeat(64),
    };

    const result = await new SlicingProcessor(
      store,
      new FakeEngine(),
      config,
    ).process(envelope("model_inspection", input));

    expect(result.outcome).toMatchObject({
      status: "succeeded",
      bodies: [{ topology: { watertight: false } }],
      findings: [
        {
          code: "INVALID_TOPOLOGY",
          severity: "blocking",
          phase: "inspection",
          acknowledgementKey: null,
        },
      ],
    });

    const bodyIds = ["body-0001"];
    const canonicalInput = {
      ...input,
      operation: {
        mode: "canonicalize_selection",
        sourceInspectionFingerprintSha256: slicingInputFingerprint(
          "model_inspection",
          input,
        ),
        bodyIds,
        selectionSha256: geometrySelectionSha256(bodyIds),
        confirmedUnitConversion: {
          sourceUnit: "millimeter",
          targetUnit: "millimeter",
          scaleFactorPpm: 1_000_000,
        },
        targetGeometry: {
          modelGeometryId: ids.geometry,
          canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
        },
      },
    };
    const canonicalResult = await new SlicingProcessor(
      store,
      new FakeEngine(),
      config,
    ).process(envelope("model_inspection", canonicalInput));
    expect(canonicalResult.outcome).toMatchObject({
      status: "succeeded",
      canonicalGeometry: { modelGeometryId: ids.geometry },
      findings: [{ code: "INVALID_TOPOLOGY", severity: "blocking" }],
    });
  });

  it("loads a historical reference-profile snapshot and reuses its dispatch artifact", async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine();
    const geometry = await readFile(
      path.resolve("../../tools/slicing-fixtures/fixtures/single-pla/cube.stl"),
    );
    const geometryHash = sha256(geometry);
    store.objects.set(`geometries/${ids.geometry}/canonical`, geometry);
    const referenceProfile = new TextEncoder().encode(
      '{"é":"composed","é":"decomposed"}',
    );
    const printConfig = new TextEncoder().encode(
      JSON.stringify({ name: "print-config" }),
    );
    const referenceHash = sha256(referenceProfile);
    expect(referenceHash).toBe(
      "9b8a3754182aaa9d6e9302ea33bd78d8915b9228d2e96eed6be0f5c5837269b1",
    );
    const configHash = sha256(printConfig);
    store.objects.set(
      `slicer-revisions/${referenceHash}/settings.json`,
      referenceProfile,
    );
    store.objects.set(
      `slicer-revisions/${configHash}/settings.json`,
      printConfig,
    );
    const bodyIds = ["body-0001"];
    const job = envelope("reference_slice", {
      geometry: {
        sourceModelFileId: ids.source,
        sourceContentSha256: "d".repeat(64),
        modelGeometryId: ids.geometry,
        canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
        geometrySha256: geometryHash,
        bodyIds,
        selectionSha256: geometrySelectionSha256(bodyIds),
      },
      referenceProfile: {
        revisionId: ids.machineProfile,
        contentSha256: referenceHash,
        slicerEngine: "orcaslicer",
        slicerVersion: "2.4.2",
      },
      printConfig: {
        revisionId: ids.printConfig,
        contentSha256: configHash,
      },
      partsPerPlate: 1,
    }) as SlicingJob;
    const processor = new SlicingProcessor(store, engine, config);
    const replayJob = {
      ...job,
      jobId: ids.shipment,
      correlationId: ids.shipment,
      idempotencyKey: `slicer:v2:reference_slice:${ids.shipment}:${job.inputFingerprintSha256}`,
    } as SlicingJob;

    const first = await processor.process(job);
    const second = await processor.process(replayJob);

    expect(first.outcome.status).toBe("succeeded");
    expect(second.outcome).toEqual(first.outcome);
    expect(first.outcome).toMatchObject({
      metrics: {
        thinWallFeatureCount: 1,
        supportVolumeRatioPpm: 250_000,
      },
      findings: [
        { code: "THIN_WALLS", acknowledgementKey: "thin-walls" },
        {
          code: "SUPPORT_MATERIAL",
          acknowledgementKey: "support-material",
        },
      ],
    });
    expect(engine.calls).toHaveLength(1);
    expect(store.writes).toEqual([
      referenceArtifactObjectKey(job.inputFingerprintSha256),
    ]);
  });

  it("reuses immutable candidate occupancy caches and never persists G-code", async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine();
    const geometry = await readFile(
      path.resolve("../../tools/slicing-fixtures/fixtures/single-pla/cube.stl"),
    );
    const geometryHash = sha256(geometry);
    store.objects.set(`geometries/${ids.geometry}/canonical`, geometry);
    const revisionContents = [
      "machine-profile",
      "calibration",
      "print-config",
    ].map((value) => new TextEncoder().encode(JSON.stringify({ name: value })));
    const revisionHashes = revisionContents.map((value) => sha256(value));
    revisionContents.forEach((value, index) =>
      store.objects.set(
        `slicer-revisions/${revisionHashes[index]!}/settings.json`,
        value,
      ),
    );
    const bodyIds = ["body-0001"];
    const base = {
      geometry: {
        sourceModelFileId: ids.source,
        sourceContentSha256: "d".repeat(64),
        modelGeometryId: ids.geometry,
        canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
        geometrySha256: geometryHash,
        bodyIds,
        selectionSha256: geometrySelectionSha256(bodyIds),
      },
      machineId: ids.machine,
      machineProfile: {
        revisionId: ids.machineProfile,
        contentSha256: revisionHashes[0]!,
        slicerEngine: "orcaslicer",
        slicerVersion: "2.4.2",
        productionArtifactFormat: "gcode_3mf" as const,
      },
      machineCalibration: {
        revisionId: ids.calibration,
        contentSha256: revisionHashes[1]!,
      },
      printConfig: {
        revisionId: ids.printConfig,
        contentSha256: revisionHashes[2]!,
      },
      partsPerPlate: 2,
      quantity: 3,
      shipmentPlanId: ids.shipment,
      arrangementRevision: {
        revisionId: ids.arrangement,
        contentSha256: "e".repeat(64),
      },
    };
    const targets = [2, 1].map((partsPerPlate) => {
      const identity = machineOccupancyCacheIdentitySha256(base, partsPerPlate);
      return {
        partsPerPlate,
        cacheIdentitySha256: identity,
        analysisObjectKey: `slice-metrics/${identity}/result.json`,
      };
    });
    const job = envelope("candidate_estimate", {
      ...base,
      occupancySliceTargets: targets,
    }) as SlicingJob;
    const processor = new SlicingProcessor(store, engine, config);
    const first = await processor.process(job);
    const second = await processor.process(job);
    expect(first).toEqual(second);
    expect(first.outcome.status).toBe("succeeded");
    expect(engine.calls).toHaveLength(2);
    expect(
      store.writes.filter((key) => key.startsWith("slice-metrics/")),
    ).toHaveLength(2);
    expect(
      [...store.objects.keys()].some((key) => key.startsWith("gcode/")),
    ).toBe(false);
    expect(
      [...store.objects.keys()].some((key) =>
        key.startsWith("reference-slices/"),
      ),
    ).toBe(false);
  });

  it("passes the accepted full-and-tail plate plan to production slicing", async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine();
    const geometry = await readFile(
      path.resolve("../../tools/slicing-fixtures/fixtures/single-pla/cube.stl"),
    );
    const geometryHash = sha256(geometry);
    store.objects.set(`geometries/${ids.geometry}/canonical`, geometry);
    const revisions = ["machine", "calibration", "config"].map((name) =>
      new TextEncoder().encode(JSON.stringify({ name })),
    );
    const hashes = revisions.map((value) => sha256(value));
    revisions.forEach((value, index) => {
      store.objects.set(
        `slicer-revisions/${hashes[index]!}/settings.json`,
        value,
      );
    });
    const bodyIds = ["body-0001"];
    const input = {
      geometry: {
        sourceModelFileId: ids.source,
        sourceContentSha256: "d".repeat(64),
        modelGeometryId: ids.geometry,
        canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
        geometrySha256: geometryHash,
        bodyIds,
        selectionSha256: geometrySelectionSha256(bodyIds),
      },
      machineId: ids.machine,
      machineProfile: {
        revisionId: ids.machineProfile,
        contentSha256: hashes[0]!,
        slicerEngine: "orcaslicer",
        slicerVersion: "2.4.2",
        productionArtifactFormat: "gcode_3mf" as const,
      },
      machineCalibration: {
        revisionId: ids.calibration,
        contentSha256: hashes[1]!,
      },
      printConfig: {
        revisionId: ids.printConfig,
        contentSha256: hashes[2]!,
      },
      partsPerPlate: 2,
      quantity: 5,
      acceptedJobId: ids.job,
      productionReservationId: "00000000-0000-4000-8000-000000000011",
      arrangementRevision: {
        revisionId: ids.arrangement,
        contentSha256: "e".repeat(64),
      },
    };

    const job = envelope("production_slice", input);
    const result = await new SlicingProcessor(store, engine, config).process(
      job,
    );

    expect(result.outcome.status).toBe("succeeded");
    expect(engine.calls.at(-1)).toMatchObject({
      copies: 5,
      copiesPerPlate: [2, 2, 1],
      artifactFormat: "gcode_3mf",
    });
    const productionKey = `gcode/${ids.job}/toolpaths.gcode.3mf`;
    expect(store.metadata.get(productionKey)).toEqual({
      immutableInputFingerprintSha256: job.inputFingerprintSha256,
      metadataContentSha256: sha256(store.objects.get(productionKey)!),
    });
    const callsAfterFirstRun = engine.calls.length;
    await expect(
      new SlicingProcessor(store, engine, config).process(job),
    ).resolves.toMatchObject({ outcome: { status: "succeeded" } });
    expect(engine.calls).toHaveLength(callsAfterFirstRun + 2);

    store.metadata.delete(productionKey);
    await expect(
      new SlicingProcessor(store, engine, config).process(job),
    ).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failureClass: "deterministic_invalid",
        code: "INVALID_MODEL",
      },
    });

    const plainResult = await new SlicingProcessor(
      store,
      engine,
      config,
    ).process(
      envelope("production_slice", {
        ...input,
        machineProfile: {
          ...input.machineProfile,
          productionArtifactFormat: "gcode" as const,
        },
      }),
    );
    expect(plainResult.outcome).toMatchObject({
      status: "failed",
      failureClass: "unsupported_input",
      code: "UNSUPPORTED_FEATURE",
    });
    expect(store.objects.has(`gcode/${ids.job}/toolpaths.gcode`)).toBe(false);

    store.objects.delete(productionKey);
    store.metadata.delete(productionKey);
    store.writes.length = 0;
    const excessivePreflight = new FakeEngine(1_000_000);
    const rejected = await new SlicingProcessor(
      store,
      excessivePreflight,
      config,
    ).process(job);
    expect(rejected.outcome).toMatchObject({
      status: "failed",
      failureClass: "deterministic_invalid",
      code: "RESOURCE_LIMIT_EXCEEDED",
    });
    expect(excessivePreflight.calls).toHaveLength(2);
    expect(store.writes).toEqual([]);
    expect(store.objects.has(productionKey)).toBe(false);

    const invalidArtifactEngine = new InvalidProductionArtifactEngine();
    const invalidArtifact = await new SlicingProcessor(
      store,
      invalidArtifactEngine,
      config,
    ).process(job);
    expect(invalidArtifact.outcome).toMatchObject({
      status: "failed",
      failureClass: "deterministic_invalid",
      code: "INVALID_GEOMETRY",
    });
    expect(invalidArtifactEngine.calls).toHaveLength(3);
    expect(store.writes).toEqual([]);
    expect(store.objects.has(productionKey)).toBe(false);
  });

  it("does not accept a different immutable artifact after a write race", async () => {
    const store = new ConflictingWriteStore();
    const engine = new FakeEngine();
    const geometry = await readFile(
      path.resolve("../../tools/slicing-fixtures/fixtures/single-pla/cube.stl"),
    );
    const geometryHash = sha256(geometry);
    store.objects.set(`geometries/${ids.geometry}/canonical`, geometry);
    const referenceProfile = new TextEncoder().encode("{}");
    const printConfig = new TextEncoder().encode('{"name":"config"}');
    const referenceHash = sha256(referenceProfile);
    const configHash = sha256(printConfig);
    store.objects.set(
      `slicer-revisions/${referenceHash}/settings.json`,
      referenceProfile,
    );
    store.objects.set(
      `slicer-revisions/${configHash}/settings.json`,
      printConfig,
    );
    const bodyIds = ["body-0001"];
    const input = {
      geometry: {
        sourceModelFileId: ids.source,
        sourceContentSha256: "d".repeat(64),
        modelGeometryId: ids.geometry,
        canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
        geometrySha256: geometryHash,
        bodyIds,
        selectionSha256: geometrySelectionSha256(bodyIds),
      },
      referenceProfile: {
        revisionId: ids.machineProfile,
        contentSha256: referenceHash,
        slicerEngine: "orcaslicer",
        slicerVersion: "2.4.2",
      },
      printConfig: {
        revisionId: ids.printConfig,
        contentSha256: configHash,
      },
      partsPerPlate: 1,
    };
    store.conflictKey = referenceArtifactObjectKey(
      slicingInputFingerprint("reference_slice", input),
    );

    const result = await new SlicingProcessor(store, engine, config).process(
      envelope("reference_slice", input),
    );

    expect(result.outcome.status).toBe("failed");
    expect(store.objects.get(store.conflictKey!)).toEqual(
      new TextEncoder().encode("different artifact"),
    );
  });
});
