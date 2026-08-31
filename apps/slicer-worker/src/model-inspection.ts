import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SlicingWorkerError } from "./failures.js";
import { sha256 } from "./object-store.js";

type Point = readonly [number, number, number];
type Triangle = readonly [Point, Point, Point];

export type InspectedBody = {
  bodyId: string;
  bodySha256: string;
  boundingBox: {
    xMicrometers: string;
    yMicrometers: string;
    zMicrometers: string;
  };
  volumeCubicMicrometers: string;
  triangleCount: number;
  topology: {
    watertight: boolean;
    manifold: boolean;
    normals: "consistent" | "inconsistent" | "unknown";
  };
  hasPaintAssignments: boolean;
  materialAssignmentIds: string[];
  extruderAssignmentIds: string[];
};

type ParsedBody = InspectedBody & { triangles: Triangle[] };

export type ModelInspection = {
  unitHint: "millimeter" | "inch" | "meter" | "unknown";
  bodies: InspectedBody[];
  objectCount: number;
  hasPaintAssignments: boolean;
  materialAssignmentCount: number;
  extruderAssignmentCount: number;
};

type ParsedModel = Omit<ModelInspection, "bodies"> & { bodies: ParsedBody[] };

const MAX_ZIP_ENTRIES = 256;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_TRIANGLES = 1_000_000;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_LOCAL_FILE = 0x04034b50;

function invalid(message: string): never {
  throw new SlicingWorkerError(
    "deterministic_invalid",
    "INVALID_MODEL",
    message,
  );
}

function finiteNumber(value: string | undefined, label: string): number {
  if (value === undefined) invalid(`Model is missing ${label}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1_000_000_000) {
    invalid(`Model contains an invalid ${label}`);
  }
  return parsed;
}

function xmlValue(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/giu,
    (entity) => {
      if (entity === "&amp;") return "&";
      if (entity === "&quot;") return '"';
      if (entity === "&apos;") return "'";
      if (entity === "&lt;") return "<";
      if (entity === "&gt;") return ">";
      const hexadecimal = /^&#x([0-9a-f]+);$/iu.exec(entity)?.[1];
      const decimal = /^&#(\d+);$/u.exec(entity)?.[1];
      const codePoint = Number.parseInt(
        hexadecimal ?? decimal ?? "0",
        hexadecimal ? 16 : 10,
      );
      if (!Number.isSafeInteger(codePoint) || codePoint < 32) {
        invalid("Model XML contains an invalid entity");
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function attributes(source: string): Map<string, string> {
  const values = new Map<string, string>();
  const pattern = /([A-Za-z_][\w.:-]*)\s*=\s*(["'])(.*?)\2/gsu;
  for (const match of source.matchAll(pattern)) {
    values.set(match[1]!.toLowerCase(), xmlValue(match[3]!));
  }
  return values;
}

function boundingBox(triangles: readonly Triangle[]) {
  const coordinates = triangles.flatMap((triangle) => triangle);
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of coordinates) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
    }
  }
  return {
    xMicrometers: String(
      Math.max(0, Math.round((maximum[0] - minimum[0]) * 1_000)),
    ),
    yMicrometers: String(
      Math.max(0, Math.round((maximum[1] - minimum[1]) * 1_000)),
    ),
    zMicrometers: String(
      Math.max(0, Math.round((maximum[2] - minimum[2]) * 1_000)),
    ),
  };
}

function pointIdentity(point: Point): string {
  return point.map((coordinate) => coordinate.toPrecision(15)).join(",");
}

function topology(triangles: readonly Triangle[]) {
  const edges = new Map<string, { count: number; direction: number }>();
  for (const triangle of triangles) {
    for (const [left, right] of [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ] as const) {
      const leftKey = pointIdentity(left);
      const rightKey = pointIdentity(right);
      const key =
        leftKey < rightKey
          ? `${leftKey}|${rightKey}`
          : `${rightKey}|${leftKey}`;
      const direction = leftKey < rightKey ? 1 : -1;
      const current = edges.get(key) ?? { count: 0, direction: 0 };
      current.count += 1;
      current.direction += direction;
      edges.set(key, current);
    }
  }
  const manifold = [...edges.values()].every(({ count }) => count <= 2);
  const watertight =
    manifold && [...edges.values()].every(({ count }) => count === 2);
  const consistent =
    watertight && [...edges.values()].every(({ direction }) => direction === 0);
  return {
    watertight,
    manifold,
    normals: watertight
      ? consistent
        ? "consistent"
        : "inconsistent"
      : "unknown",
  } as const;
}

function volume(triangles: readonly Triangle[]): string {
  let signedSixTimesVolume = 0;
  for (const [a, b, c] of triangles) {
    signedSixTimesVolume +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return String(
    Math.max(
      0,
      Math.round((Math.abs(signedSixTimesVolume) / 6) * 1_000_000_000),
    ),
  );
}

function body(
  bodyId: string,
  triangles: Triangle[],
  assignment: {
    paint: boolean;
    materials: Iterable<string>;
    extruders: Iterable<string>;
  },
): ParsedBody {
  if (triangles.length < 1) invalid("Model body contains no triangles");
  if (triangles.length > MAX_TRIANGLES) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "Model body exceeds the triangle limit",
    );
  }
  const canonical = Buffer.from(
    JSON.stringify(triangles.map((triangle) => triangle.flat())),
    "utf8",
  );
  return {
    bodyId,
    bodySha256: sha256(canonical),
    boundingBox: boundingBox(triangles),
    volumeCubicMicrometers: volume(triangles),
    triangleCount: triangles.length,
    topology: topology(triangles),
    hasPaintAssignments: assignment.paint,
    materialAssignmentIds: [...new Set(assignment.materials)].sort(),
    extruderAssignmentIds: [...new Set(assignment.extruders)].sort(),
    triangles,
  };
}

function parseBinaryStl(bytes: Uint8Array): Triangle[] | null {
  if (bytes.byteLength < 84) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (count < 1 || 84 + count * 50 !== bytes.byteLength) return null;
  if (count > MAX_TRIANGLES) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "STL exceeds the triangle limit",
    );
  }
  const triangles: Triangle[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 84 + index * 50 + 12;
    const points = [0, 1, 2].map((vertex): Point => {
      const base = offset + vertex * 12;
      const point = [
        view.getFloat32(base, true),
        view.getFloat32(base + 4, true),
        view.getFloat32(base + 8, true),
      ] as const;
      if (point.some((coordinate) => !Number.isFinite(coordinate))) {
        invalid("STL contains non-finite coordinates");
      }
      return point;
    });
    triangles.push([points[0]!, points[1]!, points[2]!]);
  }
  return triangles;
}

function parseAsciiStl(bytes: Uint8Array): Triangle[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^\s*solid(?:\s|$)/iu.test(source) || !/\bendsolid\b/iu.test(source)) {
    invalid("STL is neither canonical binary nor valid ASCII");
  }
  const vertices = [
    ...source.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/giu),
  ].map((match): Point => [
    finiteNumber(match[1], "STL x coordinate"),
    finiteNumber(match[2], "STL y coordinate"),
    finiteNumber(match[3], "STL z coordinate"),
  ]);
  if (vertices.length < 3 || vertices.length % 3 !== 0) {
    invalid("ASCII STL contains incomplete triangles");
  }
  const count = vertices.length / 3;
  if (count > MAX_TRIANGLES) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "STL exceeds the triangle limit",
    );
  }
  return Array.from({ length: count }, (_, index) => [
    vertices[index * 3]!,
    vertices[index * 3 + 1]!,
    vertices[index * 3 + 2]!,
  ]);
}

function parseStl(bytes: Uint8Array): ParsedModel {
  const triangles = parseBinaryStl(bytes) ?? parseAsciiStl(bytes);
  return {
    unitHint: "unknown",
    bodies: [
      body("body-0001", triangles, {
        paint: false,
        materials: [],
        extruders: [],
      }),
    ],
    objectCount: 1,
    hasPaintAssignments: false,
    materialAssignmentCount: 0,
    extruderAssignmentCount: 0,
  };
}

function safeArchivePath(name: string): string {
  const normalized = name.replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    invalid("3MF archive contains an unsafe entry path");
  }
  return normalized;
}

function zipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (
    let offset = Math.max(0, bytes.byteLength - 65_557);
    offset <= bytes.byteLength - 22;
    offset += 1
  ) {
    if (view.getUint32(offset, true) === ZIP_EOCD) eocd = offset;
  }
  if (eocd < 0) invalid("3MF archive has no end directory");
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (
    count < 1 ||
    count > MAX_ZIP_ENTRIES ||
    directoryOffset + directorySize > eocd
  ) {
    invalid("3MF archive directory is invalid");
  }
  const entries = new Map<string, Uint8Array>();
  let offset = directoryOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (
      offset + 46 > eocd ||
      view.getUint32(offset, true) !== ZIP_CENTRAL_FILE
    ) {
      invalid("3MF archive central entry is invalid");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      uncompressedSize > MAX_XML_BYTES
    ) {
      invalid("3MF archive uses an unsupported entry encoding");
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_ARCHIVE_OUTPUT_BYTES) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "RESOURCE_LIMIT_EXCEEDED",
        "3MF archive exceeds the decompressed byte limit",
      );
    }
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > eocd) {
      invalid("3MF archive entry exceeds its directory");
    }
    const name = safeArchivePath(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset + 46, nameEnd),
      ),
    );
    if (entries.has(name)) invalid("3MF archive contains duplicate entries");
    if (
      localOffset + 30 > directoryOffset ||
      view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE
    ) {
      invalid("3MF archive local entry is invalid");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > directoryOffset) {
      invalid("3MF archive entry data is truncated");
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let contents: Uint8Array;
    try {
      contents =
        method === 0
          ? new Uint8Array(compressed)
          : inflateRawSync(compressed, { maxOutputLength: MAX_XML_BYTES });
    } catch {
      invalid("3MF archive entry cannot be decompressed safely");
    }
    if (contents.byteLength !== uncompressedSize) {
      invalid("3MF archive entry size does not match its directory");
    }
    entries.set(name, contents);
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function inspectRelationships(entries: Map<string, Uint8Array>): void {
  for (const [name, bytes] of entries) {
    if (!name.endsWith(".rels")) continue;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const match of source.matchAll(/<Relationship\b([^>]*)\/?\s*>/giu)) {
      const values = attributes(match[1]!);
      if (values.get("targetmode")?.toLowerCase() === "external") {
        invalid("3MF archive contains an external relationship");
      }
      const target = values.get("target");
      if (!target) invalid("3MF relationship has no target");
      const decodedTarget = decodeURIComponent(target);
      const packageTarget = decodedTarget.startsWith("/")
        ? decodedTarget.slice(1)
        : decodedTarget;
      if (
        !packageTarget ||
        packageTarget.includes("\\") ||
        packageTarget.split("/").some((part) => part === ".." || part === "")
      ) {
        invalid("3MF relationship target is unsafe");
      }
    }
  }
}

function parseThreeMf(bytes: Uint8Array): ParsedModel {
  const entries = zipEntries(bytes);
  inspectRelationships(entries);
  const modelBytes = entries.get("3D/3dmodel.model");
  if (!modelBytes) invalid("3MF archive has no canonical model part");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(modelBytes);
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) {
    invalid("3MF XML declarations are unsupported");
  }
  const modelTag = /<model\b([^>]*)>/iu.exec(source);
  if (!modelTag) invalid("3MF model element is missing");
  const declaredUnit = attributes(modelTag[1]!).get("unit")?.toLowerCase();
  const unitHint =
    declaredUnit === "millimeter" ||
    declaredUnit === "inch" ||
    declaredUnit === "meter"
      ? declaredUnit
      : "unknown";
  const parsedBodies: ParsedBody[] = [];
  const objectPattern = /<object\b([^>]*)>([\s\S]*?)<\/object>/giu;
  for (const objectMatch of source.matchAll(objectPattern)) {
    const objectAttributes = attributes(objectMatch[1]!);
    const objectId = objectAttributes.get("id");
    if (!objectId || !/^[0-9]{1,9}$/u.test(objectId)) {
      invalid("3MF object identifier is invalid");
    }
    const mesh = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/iu.exec(objectMatch[2]!);
    if (!mesh) continue;
    const vertices = [...mesh[1]!.matchAll(/<vertex\b([^>]*)\/?\s*>/giu)].map(
      (match): Point => {
        const values = attributes(match[1]!);
        return [
          finiteNumber(values.get("x"), "3MF x coordinate"),
          finiteNumber(values.get("y"), "3MF y coordinate"),
          finiteNumber(values.get("z"), "3MF z coordinate"),
        ];
      },
    );
    const materials = new Set<string>();
    const extruders = new Set<string>();
    let paint = false;
    const triangles = [
      ...mesh[1]!.matchAll(/<triangle\b([^>]*)\/?\s*>/giu),
    ].map((match): Triangle => {
      const values = attributes(match[1]!);
      const indices = ["v1", "v2", "v3"].map((name) => {
        const value = values.get(name);
        if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
          invalid("3MF triangle index is invalid");
        }
        return Number(value);
      });
      const pid = values.get("pid") ?? objectAttributes.get("pid");
      const propertyIndices = ["p1", "p2", "p3"]
        .map((name) => values.get(name))
        .filter((value): value is string => value !== undefined);
      const fallbackPropertyIndex =
        values.get("pindex") ?? objectAttributes.get("pindex");
      if (pid) {
        const indices =
          propertyIndices.length > 0
            ? propertyIndices
            : fallbackPropertyIndex
              ? [fallbackPropertyIndex]
              : [null];
        for (const propertyIndex of indices) {
          materials.add(
            `material-${pid}${propertyIndex ? `-${propertyIndex}` : ""}`,
          );
        }
      }
      const paintValue =
        values.get("paint_color") ?? values.get("slic3rpe:mmu_segmentation");
      if (paintValue !== undefined) {
        paint = true;
        for (const segment of paintValue.split(/[\s,]+/u)) {
          if (!/^\d+$/u.test(segment)) continue;
          const assignment = Number(segment) >> 2;
          if (assignment > 0) extruders.add(`extruder-${assignment}`);
        }
      }
      const selected = indices.map((index) => vertices[index]);
      if (selected.some((point) => point === undefined)) {
        invalid("3MF triangle references a missing vertex");
      }
      return [selected[0]!, selected[1]!, selected[2]!];
    });
    const padded = objectId.padStart(4, "0");
    if (parsedBodies.some((item) => item.bodyId === `body-${padded}`)) {
      invalid("3MF contains duplicate object identifiers");
    }
    parsedBodies.push(
      body(`body-${padded}`, triangles, {
        paint,
        materials,
        extruders,
      }),
    );
  }
  parsedBodies.sort((left, right) => left.bodyId.localeCompare(right.bodyId));
  if (parsedBodies.length < 1)
    invalid("3MF contains no independently selectable mesh bodies");
  if (parsedBodies.length > 256) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "3MF exceeds the selectable body limit",
    );
  }
  const materialIds = new Set(
    parsedBodies.flatMap((item) => item.materialAssignmentIds),
  );
  const extruderIds = new Set(
    parsedBodies.flatMap((item) => item.extruderAssignmentIds),
  );
  return {
    unitHint,
    bodies: parsedBodies,
    objectCount: parsedBodies.length,
    hasPaintAssignments: parsedBodies.some((item) => item.hasPaintAssignments),
    materialAssignmentCount: materialIds.size,
    extruderAssignmentCount: extruderIds.size,
  };
}

function parseModel(
  format: "stl" | "3mf" | "step",
  bytes: Uint8Array,
): ParsedModel {
  if (format === "step") {
    throw new SlicingWorkerError(
      "unsupported_input",
      "UNSUPPORTED_FORMAT",
      "STEP inspection is deferred for this release",
    );
  }
  try {
    return format === "stl" ? parseStl(bytes) : parseThreeMf(bytes);
  } catch (error) {
    if (error instanceof SlicingWorkerError) throw error;
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "INVALID_MODEL",
      "Model container could not be parsed",
    );
  }
}

export function inspectModel(
  format: "stl" | "3mf" | "step",
  bytes: Uint8Array,
): ModelInspection {
  const parsed = parseModel(format, bytes);
  return {
    ...parsed,
    bodies: parsed.bodies.map(({ triangles: _triangles, ...value }) => value),
  };
}

function scaledTriangle(triangle: Triangle, factor: number): Triangle {
  return triangle.map(
    (point) =>
      point.map((coordinate) => coordinate * factor) as unknown as Point,
  ) as unknown as Triangle;
}

function canonicalBinaryStl(triangles: readonly Triangle[]): Uint8Array {
  const bytes = Buffer.alloc(84 + triangles.length * 50);
  bytes.write("Taven canonical STL v1", 0, "ascii");
  bytes.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, index) => {
    const offset = 84 + index * 50;
    triangle.forEach((point, vertex) => {
      point.forEach((coordinate, axis) => {
        bytes.writeFloatLE(coordinate, offset + 12 + vertex * 12 + axis * 4);
      });
    });
  });
  return bytes;
}

export function canonicalizeModel(
  format: "stl" | "3mf" | "step",
  bytes: Uint8Array,
  selectedBodyIds: readonly string[],
  scaleFactorPpm: number,
): {
  bytes: Uint8Array;
  sha256: string;
  inspection: ModelInspection;
} {
  const parsed = parseModel(format, bytes);
  const byId = new Map(parsed.bodies.map((item) => [item.bodyId, item]));
  const selected = selectedBodyIds.map((bodyId) => byId.get(bodyId));
  if (selected.some((item) => item === undefined)) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "INVALID_GEOMETRY",
      "Selected body does not belong to the inspected model",
    );
  }
  const selectedMaterials = new Set(
    selected.flatMap((item) => item!.materialAssignmentIds),
  );
  const selectedExtruders = new Set(
    selected.flatMap((item) => item!.extruderAssignmentIds),
  );
  if (
    selected.some(
      (item) =>
        item!.hasPaintAssignments ||
        item!.materialAssignmentIds.length > 1 ||
        item!.extruderAssignmentIds.length > 1,
    ) ||
    selectedMaterials.size > 1 ||
    selectedExtruders.size > 1
  ) {
    throw new SlicingWorkerError(
      "unsupported_input",
      "PAINTED_OR_MULTIMATERIAL",
      "Painted or multimaterial geometry requires an individual offer",
    );
  }
  const factor = scaleFactorPpm / 1_000_000;
  const scaledBodies = selected.map((item) =>
    body(
      item!.bodyId,
      item!.triangles.map((triangle) => scaledTriangle(triangle, factor)),
      {
        paint: item!.hasPaintAssignments,
        materials: item!.materialAssignmentIds,
        extruders: item!.extruderAssignmentIds,
      },
    ),
  );
  const triangles = scaledBodies.flatMap((item) => item.triangles);
  const canonical = canonicalBinaryStl(triangles);
  return {
    bytes: canonical,
    sha256: sha256(canonical),
    inspection: {
      unitHint: "millimeter",
      bodies: scaledBodies.map(({ triangles: _triangles, ...value }) => value),
      objectCount: scaledBodies.length,
      hasPaintAssignments: scaledBodies.some(
        (item) => item.hasPaintAssignments,
      ),
      materialAssignmentCount: new Set(
        scaledBodies.flatMap((item) => item.materialAssignmentIds),
      ).size,
      extruderAssignmentCount: new Set(
        scaledBodies.flatMap((item) => item.extruderAssignmentIds),
      ).size,
    },
  };
}

export function aggregateBounds(bodies: readonly InspectedBody[]) {
  return bodies.reduce(
    (result, item) => ({
      xMicrometers: String(
        BigInt(result.xMicrometers) > BigInt(item.boundingBox.xMicrometers)
          ? BigInt(result.xMicrometers)
          : BigInt(item.boundingBox.xMicrometers),
      ),
      yMicrometers: String(
        BigInt(result.yMicrometers) > BigInt(item.boundingBox.yMicrometers)
          ? BigInt(result.yMicrometers)
          : BigInt(item.boundingBox.yMicrometers),
      ),
      zMicrometers: String(
        BigInt(result.zMicrometers) > BigInt(item.boundingBox.zMicrometers)
          ? BigInt(result.zMicrometers)
          : BigInt(item.boundingBox.zMicrometers),
      ),
    }),
    { xMicrometers: "0", yMicrometers: "0", zMicrometers: "0" },
  );
}

export function inspectionFingerprint(inspection: ModelInspection): string {
  return createHash("sha256").update(JSON.stringify(inspection)).digest("hex");
}
