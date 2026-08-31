import { createHash } from "node:crypto";
import path from "node:path";
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
  boundingBox: InspectedBody["boundingBox"];
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
const MAX_COMPONENT_EDGES = 4_096;
const MAX_COMPONENT_DEPTH = 64;
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
    boundingBox: boundingBox(triangles),
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

function relationshipSource(name: string): string | null {
  if (name === "_rels/.rels") return "";
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/u.exec(name);
  return match ? `${match[1]!}/${match[2]!}` : null;
}

function relationshipTarget(sourcePart: string, target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    invalid("3MF relationship target is unsafe");
  }
  if (
    !decoded! ||
    decoded!.includes("\\") ||
    /[?#]/u.test(decoded!) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(decoded!)
  ) {
    invalid("3MF relationship target is unsafe");
  }
  const relative = decoded!.startsWith("/") ? decoded!.slice(1) : decoded!;
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    invalid("3MF relationship target is unsafe");
  }
  const base = decoded!.startsWith("/")
    ? ""
    : sourcePart.includes("/")
      ? path.posix.dirname(sourcePart)
      : "";
  return safeArchivePath(path.posix.join(base, relative));
}

function inspectRelationships(
  entries: Map<string, Uint8Array>,
): Map<string, Set<string>> {
  const modelRelationships = new Map<string, Set<string>>();
  for (const [name, bytes] of entries) {
    if (!name.endsWith(".rels")) continue;
    const sourcePart = relationshipSource(name);
    if (sourcePart === null) invalid("3MF relationship part is misplaced");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const match of source.matchAll(/<Relationship\b([^>]*)\/?\s*>/giu)) {
      const values = attributes(match[1]!);
      if (values.get("targetmode")?.toLowerCase() === "external") {
        invalid("3MF archive contains an external relationship");
      }
      const target = values.get("target");
      if (!target) invalid("3MF relationship has no target");
      const packageTarget = relationshipTarget(sourcePart!, target);
      if (!entries.has(packageTarget)) {
        invalid("3MF relationship references a missing package part");
      }
      if (values.get("type")?.toLowerCase().endsWith("/3dmodel")) {
        const targets = modelRelationships.get(sourcePart!) ?? new Set();
        targets.add(packageTarget);
        modelRelationships.set(sourcePart!, targets);
      }
    }
  }
  return modelRelationships;
}

type Transform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

type MeshDefinition = {
  triangles: Triangle[];
  paint: boolean;
  materials: Set<string>;
  extruders: Set<string>;
};

type ComponentDefinition = {
  objectId: string;
  partPath: string;
  transform: Transform;
};

type ObjectDefinition = {
  mesh: MeshDefinition | null;
  components: ComponentDefinition[];
};

type ModelPart = {
  path: string;
  unitHint: ModelInspection["unitHint"];
  objects: Map<string, ObjectDefinition>;
};

const IDENTITY_TRANSFORM: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function localAttribute(
  values: ReadonlyMap<string, string>,
  name: string,
): string | undefined {
  const matches = [...values].filter(
    ([key]) => key === name || key.endsWith(`:${name}`),
  );
  if (matches.length > 1) invalid(`3MF contains ambiguous ${name} attributes`);
  return matches[0]?.[1];
}

function transformValue(value: string | undefined): Transform {
  if (value === undefined) return IDENTITY_TRANSFORM;
  const parts = value.trim().split(/\s+/u);
  if (parts.length !== 12) invalid("3MF transform must contain 12 numbers");
  const result = parts.map((part) => finiteNumber(part, "transform value"));
  const determinant =
    result[0]! * (result[4]! * result[8]! - result[5]! * result[7]!) -
    result[1]! * (result[3]! * result[8]! - result[5]! * result[6]!) +
    result[2]! * (result[3]! * result[7]! - result[4]! * result[6]!);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    invalid("3MF transform is singular");
  }
  return result as unknown as Transform;
}

function transformedTriangles(
  triangles: readonly Triangle[],
  transform: Transform,
): Triangle[] {
  const determinant =
    transform[0] * (transform[4] * transform[8] - transform[5] * transform[7]) -
    transform[1] * (transform[3] * transform[8] - transform[5] * transform[6]) +
    transform[2] * (transform[3] * transform[7] - transform[4] * transform[6]);
  return triangles.map((triangle) => {
    const points = triangle.map((point): Point => {
      const transformed: Point = [
        point[0] * transform[0] +
          point[1] * transform[3] +
          point[2] * transform[6] +
          transform[9],
        point[0] * transform[1] +
          point[1] * transform[4] +
          point[2] * transform[7] +
          transform[10],
        point[0] * transform[2] +
          point[1] * transform[5] +
          point[2] * transform[8] +
          transform[11],
      ];
      if (
        transformed.some(
          (coordinate) =>
            !Number.isFinite(coordinate) ||
            Math.abs(coordinate) > 1_000_000_000,
        )
      ) {
        invalid("3MF transform produces an invalid coordinate");
      }
      return transformed;
    });
    return determinant < 0
      ? [points[0]!, points[2]!, points[1]!]
      : [points[0]!, points[1]!, points[2]!];
  });
}

function parseMesh(
  source: string,
  objectAttributes: ReadonlyMap<string, string>,
  partPath: string,
): MeshDefinition {
  const vertices = [...source.matchAll(/<vertex\b([^>]*)\/?\s*>/giu)].map(
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
  const partIdentity = createHash("sha256")
    .update(partPath)
    .digest("hex")
    .slice(0, 12);
  const triangles = [...source.matchAll(/<triangle\b([^>]*)\/?\s*>/giu)].map(
    (match): Triangle => {
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
        const assigned =
          propertyIndices.length > 0
            ? propertyIndices
            : fallbackPropertyIndex
              ? [fallbackPropertyIndex]
              : [null];
        for (const propertyIndex of assigned) {
          materials.add(
            `material-${partIdentity}-${pid}${propertyIndex ? `-${propertyIndex}` : ""}`,
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
    },
  );
  if (triangles.length < 1) invalid("Model body contains no triangles");
  return { triangles, paint, materials, extruders };
}

function referencedPart(
  values: ReadonlyMap<string, string>,
  currentPart: string,
  rootPart: string,
  allowedRootTargets: ReadonlySet<string>,
): string {
  const reference = localAttribute(values, "path");
  if (reference === undefined) return currentPart;
  if (currentPart !== rootPart || !reference.startsWith("/")) {
    invalid("3MF production path is not permitted in this model part");
  }
  const target = relationshipTarget(rootPart, reference);
  if (!allowedRootTargets.has(target)) {
    invalid("3MF production path has no matching model relationship");
  }
  return target;
}

function parseModelPart(
  partPath: string,
  bytes: Uint8Array,
  rootPart: string,
  allowedRootTargets: ReadonlySet<string>,
): ModelPart {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
  const objects = new Map<string, ObjectDefinition>();
  const objectPattern = /<object\b([^>]*)>([\s\S]*?)<\/object>/giu;
  for (const objectMatch of source.matchAll(objectPattern)) {
    const objectAttributes = attributes(objectMatch[1]!);
    const objectId = objectAttributes.get("id");
    if (!objectId || !/^[0-9]{1,9}$/u.test(objectId)) {
      invalid("3MF object identifier is invalid");
    }
    if (objects.has(objectId))
      invalid("3MF contains duplicate object identifiers");
    const mesh = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/iu.exec(objectMatch[2]!);
    const componentsMatch =
      /<components\b[^>]*>([\s\S]*?)<\/components>/iu.exec(objectMatch[2]!);
    if ((mesh === null) === (componentsMatch === null)) {
      invalid("3MF object must contain exactly one mesh or component graph");
    }
    const components = componentsMatch
      ? [...componentsMatch[1]!.matchAll(/<component\b([^>]*)\/?\s*>/giu)].map(
          (match): ComponentDefinition => {
            const values = attributes(match[1]!);
            const referencedObjectId = values.get("objectid");
            if (
              !referencedObjectId ||
              !/^[0-9]{1,9}$/u.test(referencedObjectId)
            ) {
              invalid("3MF component object identifier is invalid");
            }
            return {
              objectId: referencedObjectId,
              partPath: referencedPart(
                values,
                partPath,
                rootPart,
                allowedRootTargets,
              ),
              transform: transformValue(values.get("transform")),
            };
          },
        )
      : [];
    if (componentsMatch && components.length < 1) {
      invalid("3MF component graph is empty");
    }
    objects.set(objectId, {
      mesh: mesh ? parseMesh(mesh[1]!, objectAttributes, partPath) : null,
      components,
    });
  }
  return { path: partPath, unitHint, objects };
}

function parseThreeMf(bytes: Uint8Array): ParsedModel {
  const entries = zipEntries(bytes);
  const relationships = inspectRelationships(entries);
  const packageRoots = [...(relationships.get("") ?? [])];
  const rootPart =
    packageRoots.length === 1
      ? packageRoots[0]!
      : packageRoots.length === 0 && entries.has("3D/3dmodel.model")
        ? "3D/3dmodel.model"
        : invalid("3MF archive must identify exactly one root model part");
  const rootBytes = entries.get(rootPart);
  if (!rootBytes) invalid("3MF archive root model part is missing");
  const allowedRootTargets = relationships.get(rootPart) ?? new Set<string>();
  const parts = new Map<string, ModelPart>();
  const loadPart = (partPath: string): ModelPart => {
    const existing = parts.get(partPath);
    if (existing) return existing;
    const partBytes = entries.get(partPath);
    if (!partBytes || !partPath.toLowerCase().endsWith(".model")) {
      invalid("3MF component references a missing model part");
    }
    const parsed = parseModelPart(
      partPath,
      partBytes,
      rootPart,
      allowedRootTargets,
    );
    parts.set(partPath, parsed);
    return parsed;
  };
  const root = loadPart(rootPart);
  const rootSource = new TextDecoder("utf-8", { fatal: true }).decode(
    rootBytes,
  );
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/iu.exec(rootSource);
  if (!build) invalid("3MF root model contains no build items");
  const buildItems = [...build[1]!.matchAll(/<item\b([^>]*)\/?\s*>/giu)].filter(
    (item) => {
      const printable = attributes(item[1]!).get("printable");
      if (printable !== undefined && printable !== "0" && printable !== "1") {
        invalid("3MF build item printable flag is invalid");
      }
      return printable !== "0";
    },
  );
  if (buildItems.length < 1) invalid("3MF root model contains no build items");
  if (buildItems.length > 256) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "3MF exceeds the selectable body limit",
    );
  }
  let expandedTriangles = 0;
  let traversedEdges = 0;
  const resolveObject = (
    partPath: string,
    objectId: string,
    stack: ReadonlySet<string>,
    depth: number,
  ): MeshDefinition => {
    if (depth > MAX_COMPONENT_DEPTH) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "RESOURCE_LIMIT_EXCEEDED",
        "3MF component graph exceeds the depth limit",
      );
    }
    const identity = `${partPath}\0${objectId}`;
    if (stack.has(identity)) invalid("3MF component graph contains a cycle");
    const part = loadPart(partPath);
    if (part.unitHint !== root.unitHint) {
      invalid("3MF component model parts use inconsistent units");
    }
    const definition = part.objects.get(objectId);
    if (!definition) invalid("3MF build references a missing object");
    if (definition.mesh) {
      expandedTriangles += definition.mesh.triangles.length;
      if (expandedTriangles > MAX_TRIANGLES) {
        throw new SlicingWorkerError(
          "deterministic_invalid",
          "RESOURCE_LIMIT_EXCEEDED",
          "3MF exceeds the expanded triangle limit",
        );
      }
      return {
        triangles: definition.mesh.triangles,
        paint: definition.mesh.paint,
        materials: new Set(definition.mesh.materials),
        extruders: new Set(definition.mesh.extruders),
      };
    }
    const nextStack = new Set(stack).add(identity);
    const combined: MeshDefinition = {
      triangles: [],
      paint: false,
      materials: new Set(),
      extruders: new Set(),
    };
    for (const component of definition.components) {
      traversedEdges += 1;
      if (traversedEdges > MAX_COMPONENT_EDGES) {
        throw new SlicingWorkerError(
          "deterministic_invalid",
          "RESOURCE_LIMIT_EXCEEDED",
          "3MF component graph exceeds the expansion limit",
        );
      }
      const child = resolveObject(
        component.partPath,
        component.objectId,
        nextStack,
        depth + 1,
      );
      combined.triangles.push(
        ...transformedTriangles(child.triangles, component.transform),
      );
      combined.paint ||= child.paint;
      child.materials.forEach((value) => combined.materials.add(value));
      child.extruders.forEach((value) => combined.extruders.add(value));
    }
    return combined;
  };
  const parsedBodies = buildItems.map((item, index) => {
    const values = attributes(item[1]!);
    const objectId = values.get("objectid");
    if (!objectId || !/^[0-9]{1,9}$/u.test(objectId)) {
      invalid("3MF build item object identifier is invalid");
    }
    const itemPart = referencedPart(
      values,
      rootPart,
      rootPart,
      allowedRootTargets,
    );
    const realized = resolveObject(itemPart, objectId, new Set(), 1);
    return body(
      `body-${String(index + 1).padStart(4, "0")}`,
      transformedTriangles(
        realized.triangles,
        transformValue(values.get("transform")),
      ),
      {
        paint: realized.paint,
        materials: realized.materials,
        extruders: realized.extruders,
      },
    );
  });
  const materialIds = new Set(
    parsedBodies.flatMap((item) => item.materialAssignmentIds),
  );
  const extruderIds = new Set(
    parsedBodies.flatMap((item) => item.extruderAssignmentIds),
  );
  return {
    unitHint: root.unitHint,
    bodies: parsedBodies,
    boundingBox: boundingBox(parsedBodies.flatMap((item) => item.triangles)),
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
      boundingBox: boundingBox(triangles),
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

export function inspectionFingerprint(inspection: ModelInspection): string {
  return createHash("sha256").update(JSON.stringify(inspection)).digest("hex");
}
