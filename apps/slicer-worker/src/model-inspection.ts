import { createHash } from "node:crypto";
import path from "node:path";
import { orient2d, orient3d } from "robust-predicates";
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";
import { readBoundedZipEntries } from "./bounded-zip.js";
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
  unitHint:
    | "micron"
    | "millimeter"
    | "centimeter"
    | "inch"
    | "foot"
    | "meter"
    | "unknown";
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
const MAX_MODEL_OBJECTS = 4_096;
const MAX_ASSIGNMENT_IDS = 256;
const MAX_SHELL_PAIR_CHECKS = 2_000_000;
const MAX_CONTAINMENT_TRIANGLE_CHECKS = 4_000_000;
const MAX_INTERSHELL_GEOMETRY_CHECKS = 4_000_000;
const TRIANGLE_BVH_LEAF_SIZE = 8;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const CORE_3MF_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const PRODUCTION_3MF_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
const MATERIAL_3MF_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const SLIC3R_3MF_NAMESPACE = "http://schemas.slic3r.org/3mf/2017/06";

function invalid(message: string): never {
  throw new SlicingWorkerError(
    "deterministic_invalid",
    "INVALID_MODEL",
    message,
  );
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

function finiteNumber(value: string | undefined, label: string): number {
  if (value === undefined) invalid(`Model is missing ${label}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1_000_000_000) {
    invalid(`Model contains an invalid ${label}`);
  }
  return parsed;
}

function attribute(
  tag: SaxesTagNS,
  local: string,
  uri = "",
): string | undefined {
  return Object.values(tag.attributes).find(
    (candidate: SaxesAttributeNS) =>
      candidate.local === local && candidate.uri === uri,
  )?.value;
}

function parseXml(
  bytes: Uint8Array,
  configure: (parser: SaxesParser<{ xmlns: true }>) => void,
): void {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("3MF XML is not valid UTF-8");
  }
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on("doctype", () => invalid("3MF XML declarations are unsupported"));
  parser.on("error", () => invalid("3MF XML is not well formed"));
  configure(parser);
  try {
    parser.write(source!).close();
  } catch (error) {
    if (error instanceof SlicingWorkerError) throw error;
    invalid("3MF XML is not well formed");
  }
}

function boundingBox(
  triangles: readonly Triangle[],
  micrometersPerUnit = 1_000,
) {
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
      Math.max(0, Math.round((maximum[0] - minimum[0]) * micrometersPerUnit)),
    ),
    yMicrometers: String(
      Math.max(0, Math.round((maximum[1] - minimum[1]) * micrometersPerUnit)),
    ),
    zMicrometers: String(
      Math.max(0, Math.round((maximum[2] - minimum[2]) * micrometersPerUnit)),
    ),
  };
}

function pointIdentity(point: Point): string {
  return point.map((coordinate) => coordinate.toPrecision(15)).join(",");
}

type Bounds = {
  minimum: [number, number, number];
  maximum: [number, number, number];
};

type TriangleBvh = {
  bounds: Bounds;
  triangleCount: number;
  triangleIndices?: number[];
  left?: TriangleBvh;
  right?: TriangleBvh;
};

type Shell = {
  bounds: Bounds;
  bvh?: TriangleBvh;
  signedSixTimesVolume: number;
  triangleIndices: number[];
};

function shellBounds(
  triangles: readonly Triangle[],
  triangleIndices: readonly number[],
): Bounds {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const triangleIndex of triangleIndices) {
    for (const point of triangles[triangleIndex]!) {
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
        maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
      }
    }
  }
  return { minimum, maximum };
}

function strictlyContainsBounds(outer: Bounds, inner: Bounds): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (
      outer.minimum[axis]! >= inner.minimum[axis]! ||
      outer.maximum[axis]! <= inner.maximum[axis]!
    ) {
      return false;
    }
  }
  return true;
}

function triangleBounds(triangle: Triangle): Bounds {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of triangle) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
    }
  }
  return { minimum, maximum };
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (
      left.maximum[axis]! < right.minimum[axis]! ||
      right.maximum[axis]! < left.minimum[axis]!
    ) {
      return false;
    }
  }
  return true;
}

function buildTriangleBvh(
  triangles: readonly Triangle[],
  triangleIndices: readonly number[],
): TriangleBvh {
  const bounds = shellBounds(triangles, triangleIndices);
  if (triangleIndices.length <= TRIANGLE_BVH_LEAF_SIZE) {
    return {
      bounds,
      triangleCount: triangleIndices.length,
      triangleIndices: [...triangleIndices],
    };
  }
  let splitAxis = 0;
  for (let axis = 1; axis < 3; axis += 1) {
    if (
      bounds.maximum[axis]! - bounds.minimum[axis]! >
      bounds.maximum[splitAxis]! - bounds.minimum[splitAxis]!
    ) {
      splitAxis = axis;
    }
  }
  const sorted = [...triangleIndices].sort((left, right) => {
    const leftTriangle = triangles[left]!;
    const rightTriangle = triangles[right]!;
    const leftCenter =
      (leftTriangle[0][splitAxis]! +
        leftTriangle[1][splitAxis]! +
        leftTriangle[2][splitAxis]!) /
      3;
    const rightCenter =
      (rightTriangle[0][splitAxis]! +
        rightTriangle[1][splitAxis]! +
        rightTriangle[2][splitAxis]!) /
      3;
    return leftCenter - rightCenter || left - right;
  });
  const middle = Math.floor(sorted.length / 2);
  return {
    bounds,
    triangleCount: sorted.length,
    left: buildTriangleBvh(triangles, sorted.slice(0, middle)),
    right: buildTriangleBvh(triangles, sorted.slice(middle)),
  };
}

function projectedPoint(
  point: Point,
  projection: number,
): readonly [number, number] {
  return projection === 0
    ? [point[1], point[2]]
    : projection === 1
      ? [point[0], point[2]]
      : [point[0], point[1]];
}

function triangleProjection(triangle: Triangle): number {
  for (let projection = 0; projection < 3; projection += 1) {
    const [a, b, c] = triangle.map((point) =>
      projectedPoint(point, projection),
    );
    if (orient2d(...a!, ...b!, ...c!) !== 0) return projection;
  }
  invalid("Model contains a degenerate triangle");
}

function pointInTriangle2d(
  point: readonly [number, number],
  triangle: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ],
): boolean {
  const [a, b, c] = triangle;
  const ab = orient2d(...a, ...b, ...point);
  const bc = orient2d(...b, ...c, ...point);
  const ca = orient2d(...c, ...a, ...point);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

function pointOnSegment2d(
  point: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number],
): boolean {
  return (
    Math.min(start[0], end[0]) <= point[0] &&
    point[0] <= Math.max(start[0], end[0]) &&
    Math.min(start[1], end[1]) <= point[1] &&
    point[1] <= Math.max(start[1], end[1])
  );
}

function segmentsTouch2d(
  leftStart: readonly [number, number],
  leftEnd: readonly [number, number],
  rightStart: readonly [number, number],
  rightEnd: readonly [number, number],
): boolean {
  const leftToRightStart = orient2d(...leftStart, ...leftEnd, ...rightStart);
  const leftToRightEnd = orient2d(...leftStart, ...leftEnd, ...rightEnd);
  const rightToLeftStart = orient2d(...rightStart, ...rightEnd, ...leftStart);
  const rightToLeftEnd = orient2d(...rightStart, ...rightEnd, ...leftEnd);
  if (
    ((leftToRightStart > 0 && leftToRightEnd < 0) ||
      (leftToRightStart < 0 && leftToRightEnd > 0)) &&
    ((rightToLeftStart > 0 && rightToLeftEnd < 0) ||
      (rightToLeftStart < 0 && rightToLeftEnd > 0))
  ) {
    return true;
  }
  return (
    (leftToRightStart === 0 &&
      pointOnSegment2d(rightStart, leftStart, leftEnd)) ||
    (leftToRightEnd === 0 && pointOnSegment2d(rightEnd, leftStart, leftEnd)) ||
    (rightToLeftStart === 0 &&
      pointOnSegment2d(leftStart, rightStart, rightEnd)) ||
    (rightToLeftEnd === 0 && pointOnSegment2d(leftEnd, rightStart, rightEnd))
  );
}

function coplanarSegmentTouchesTriangle(
  start: Point,
  end: Point,
  triangle: Triangle,
): boolean {
  const projection = triangleProjection(triangle);
  const projectedStart = projectedPoint(start, projection);
  const projectedEnd = projectedPoint(end, projection);
  const projectedTriangle = triangle.map((point) =>
    projectedPoint(point, projection),
  ) as [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  if (
    pointInTriangle2d(projectedStart, projectedTriangle) ||
    pointInTriangle2d(projectedEnd, projectedTriangle)
  ) {
    return true;
  }
  return projectedTriangle.some((edgeStart, index) =>
    segmentsTouch2d(
      projectedStart,
      projectedEnd,
      edgeStart,
      projectedTriangle[(index + 1) % 3]!,
    ),
  );
}

function segmentTouchesTriangle(
  start: Point,
  end: Point,
  triangle: Triangle,
): boolean {
  const [a, b, c] = triangle;
  const startSide = orient3d(...a, ...b, ...c, ...start);
  const endSide = orient3d(...a, ...b, ...c, ...end);
  if ((startSide > 0 && endSide > 0) || (startSide < 0 && endSide < 0)) {
    return false;
  }
  if (startSide === 0 && endSide === 0) {
    return coplanarSegmentTouchesTriangle(start, end, triangle);
  }
  const ab = orient3d(...start, ...end, ...a, ...b);
  const bc = orient3d(...start, ...end, ...b, ...c);
  const ca = orient3d(...start, ...end, ...c, ...a);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

function trianglesTouchOrIntersect(left: Triangle, right: Triangle): boolean {
  const edges = (triangle: Triangle) =>
    [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ] as const;
  return (
    edges(left).some(([start, end]) =>
      segmentTouchesTriangle(start, end, right),
    ) ||
    edges(right).some(([start, end]) =>
      segmentTouchesTriangle(start, end, left),
    )
  );
}

function spendIntershellCheck(budget: { count: number }): void {
  budget.count += 1;
  if (budget.count > MAX_INTERSHELL_GEOMETRY_CHECKS) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "Model exceeds the inter-shell geometry inspection limit",
    );
  }
}

function shellsTouchOrIntersect(
  left: Shell,
  right: Shell,
  triangles: readonly Triangle[],
  budget: { count: number },
): boolean {
  left.bvh ??= buildTriangleBvh(triangles, left.triangleIndices);
  right.bvh ??= buildTriangleBvh(triangles, right.triangleIndices);
  const pending: Array<readonly [TriangleBvh, TriangleBvh]> = [
    [left.bvh, right.bvh],
  ];
  while (pending.length > 0) {
    const [leftNode, rightNode] = pending.pop()!;
    spendIntershellCheck(budget);
    if (!boundsOverlap(leftNode.bounds, rightNode.bounds)) continue;
    if (leftNode.triangleIndices && rightNode.triangleIndices) {
      for (const leftIndex of leftNode.triangleIndices) {
        for (const rightIndex of rightNode.triangleIndices) {
          spendIntershellCheck(budget);
          const leftTriangle = triangles[leftIndex]!;
          const rightTriangle = triangles[rightIndex]!;
          if (
            boundsOverlap(
              triangleBounds(leftTriangle),
              triangleBounds(rightTriangle),
            ) &&
            trianglesTouchOrIntersect(leftTriangle, rightTriangle)
          ) {
            return true;
          }
        }
      }
      continue;
    }
    if (
      rightNode.triangleIndices ||
      (!leftNode.triangleIndices &&
        leftNode.triangleCount >= rightNode.triangleCount)
    ) {
      pending.push([leftNode.left!, rightNode], [leftNode.right!, rightNode]);
    } else {
      pending.push([leftNode, rightNode.left!], [leftNode, rightNode.right!]);
    }
  }
  return false;
}

function pointInsideShell(
  point: Point,
  shell: Shell,
  triangles: readonly Triangle[],
  triangleChecks: { count: number },
): boolean {
  let solidAngle = 0;
  let compensation = 0;
  for (const triangleIndex of shell.triangleIndices) {
    triangleChecks.count += 1;
    if (triangleChecks.count > MAX_CONTAINMENT_TRIANGLE_CHECKS) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "RESOURCE_LIMIT_EXCEEDED",
        "Model exceeds the nested-shell inspection limit",
      );
    }
    const vectors = triangles[triangleIndex]!.map(
      (vertex) =>
        [
          vertex[0] - point[0],
          vertex[1] - point[1],
          vertex[2] - point[2],
        ] as Point,
    );
    const [a, b, c] = vectors;
    const aLength = Math.hypot(...a!);
    const bLength = Math.hypot(...b!);
    const cLength = Math.hypot(...c!);
    if (aLength === 0 || bLength === 0 || cLength === 0) {
      invalid("Model contains touching or intersecting geometry shells");
    }
    const numerator =
      a![0] * (b![1] * c![2] - b![2] * c![1]) -
      a![1] * (b![0] * c![2] - b![2] * c![0]) +
      a![2] * (b![0] * c![1] - b![1] * c![0]);
    const denominator =
      aLength * bLength * cLength +
      (a![0] * b![0] + a![1] * b![1] + a![2] * b![2]) * cLength +
      (b![0] * c![0] + b![1] * c![1] + b![2] * c![2]) * aLength +
      (c![0] * a![0] + c![1] * a![1] + c![2] * a![2]) * bLength;
    const angle = 2 * Math.atan2(numerator, denominator);
    const corrected = angle - compensation;
    const next = solidAngle + corrected;
    compensation = next - solidAngle - corrected;
    solidAngle = next;
  }
  const winding = Math.abs(solidAngle) / (4 * Math.PI);
  if (winding <= 1e-6) return false;
  if (Math.abs(winding - 1) <= 1e-6) return true;
  invalid("Model contains touching or intersecting geometry shells");
}

function nestedShellVolume(
  shells: readonly Shell[],
  triangles: readonly Triangle[],
): number {
  if ((shells.length * (shells.length - 1)) / 2 > MAX_SHELL_PAIR_CHECKS) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "Model exceeds the nested-shell inspection limit",
    );
  }
  for (const triangle of triangles) triangleProjection(triangle);
  const intershellBudget = { count: 0 };
  for (let leftIndex = 0; leftIndex < shells.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < shells.length;
      rightIndex += 1
    ) {
      const left = shells[leftIndex]!;
      const right = shells[rightIndex]!;
      if (
        boundsOverlap(left.bounds, right.bounds) &&
        shellsTouchOrIntersect(left, right, triangles, intershellBudget)
      ) {
        invalid("Model contains touching or intersecting geometry shells");
      }
    }
  }
  const triangleChecks = { count: 0 };
  let total = 0;
  for (const inner of shells) {
    const point = triangles[inner.triangleIndices[0]!]![0];
    let depth = 0;
    for (const outer of shells) {
      if (
        outer === inner ||
        !strictlyContainsBounds(outer.bounds, inner.bounds)
      ) {
        continue;
      }
      if (pointInsideShell(point, outer, triangles, triangleChecks)) depth += 1;
    }
    const shellVolume = Math.abs(inner.signedSixTimesVolume);
    total += depth % 2 === 0 ? shellVolume : -shellVolume;
  }
  if (total < 0) invalid("Model contains invalid nested geometry shells");
  return total;
}

function geometryAnalysis(triangles: readonly Triangle[]) {
  const parents = Int32Array.from(triangles, (_, index) => index);
  const signedSixTimesVolumes = new Float64Array(triangles.length);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const parent = parents[index]!;
      parents[index] = root;
      index = parent;
    }
    return root;
  };
  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const edges = new Map<
    string,
    { count: number; direction: number; triangleIndex: number }
  >();
  for (const [triangleIndex, triangle] of triangles.entries()) {
    const [a, b, c] = triangle;
    signedSixTimesVolumes[triangleIndex] =
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
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
      const current = edges.get(key) ?? {
        count: 0,
        direction: 0,
        triangleIndex,
      };
      unite(triangleIndex, current.triangleIndex);
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
  const shellSignedSixTimesVolumes = new Map<number, number>();
  const shellTriangleIndices = new Map<number, number[]>();
  for (let index = 0; index < triangles.length; index += 1) {
    const root = find(index);
    shellSignedSixTimesVolumes.set(
      root,
      (shellSignedSixTimesVolumes.get(root) ?? 0) +
        signedSixTimesVolumes[index]!,
    );
    const indices = shellTriangleIndices.get(root) ?? [];
    indices.push(index);
    shellTriangleIndices.set(root, indices);
  }
  const shells = [...shellTriangleIndices].map(([root, triangleIndices]) => ({
    bounds: shellBounds(triangles, triangleIndices),
    signedSixTimesVolume: shellSignedSixTimesVolumes.get(root)!,
    triangleIndices,
  }));
  return {
    topology: {
      watertight,
      manifold,
      normals: watertight
        ? consistent
          ? "consistent"
          : "inconsistent"
        : "unknown",
    } as const,
    absoluteSixTimesVolume: consistent
      ? nestedShellVolume(shells, triangles)
      : shells.reduce(
          (total, shell) => total + Math.abs(shell.signedSixTimesVolume),
          0,
        ),
  } as const;
}

function volume(
  absoluteSixTimesVolume: number,
  micrometersPerUnit = 1_000,
): string {
  const roundedCubicMicrometers = Math.round(
    (absoluteSixTimesVolume / 6) * micrometersPerUnit ** 3,
  );
  if (!Number.isFinite(roundedCubicMicrometers)) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "Model body volume exceeds the supported limit",
    );
  }
  const cubicMicrometers = BigInt(roundedCubicMicrometers);
  if (cubicMicrometers > MAX_SIGNED_INT64) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "Model body volume exceeds the supported limit",
    );
  }
  return cubicMicrometers.toString();
}

function body(
  bodyId: string,
  triangles: Triangle[],
  assignment: {
    paint: boolean;
    materials: Iterable<string>;
    extruders: Iterable<string>;
  },
  micrometersPerUnit = 1_000,
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
  const dimensions = boundingBox(triangles, micrometersPerUnit);
  const analysis = geometryAnalysis(triangles);
  const bodyVolume = volume(
    analysis.absoluteSixTimesVolume,
    micrometersPerUnit,
  );
  if (
    bodyVolume === "0" ||
    dimensions.xMicrometers === "0" ||
    dimensions.yMicrometers === "0" ||
    dimensions.zMicrometers === "0"
  ) {
    invalid(
      "Model body must have positive volume and three-dimensional bounds",
    );
  }
  return {
    bodyId,
    bodySha256: sha256(canonical),
    boundingBox: dimensions,
    volumeCubicMicrometers: bodyVolume,
    triangleCount: triangles.length,
    topology: analysis.topology,
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
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("STL is neither canonical binary nor valid ASCII");
  }

  const lines = source
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  let cursor = 0;
  if (!/^solid(?:\s.*)?$/iu.test(lines[cursor] ?? "")) {
    invalid("STL is neither canonical binary nor valid ASCII");
  }
  cursor += 1;

  const triangles: Triangle[] = [];
  let closed = false;
  while (cursor < lines.length) {
    if (/^endsolid(?:\s.*)?$/iu.test(lines[cursor]!)) {
      cursor += 1;
      closed = true;
      break;
    }

    const normal = /^facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)$/iu.exec(
      lines[cursor]!,
    );
    if (!normal) invalid("ASCII STL contains an invalid facet");
    finiteNumber(normal[1], "STL normal x coordinate");
    finiteNumber(normal[2], "STL normal y coordinate");
    finiteNumber(normal[3], "STL normal z coordinate");
    cursor += 1;

    if (!/^outer\s+loop$/iu.test(lines[cursor] ?? "")) {
      invalid("ASCII STL facet is missing its outer loop");
    }
    cursor += 1;

    const vertices: Point[] = [];
    for (let index = 0; index < 3; index += 1) {
      const vertex = /^vertex\s+(\S+)\s+(\S+)\s+(\S+)$/iu.exec(
        lines[cursor] ?? "",
      );
      if (!vertex) invalid("ASCII STL facet must contain three vertices");
      vertices.push([
        finiteNumber(vertex[1], "STL x coordinate"),
        finiteNumber(vertex[2], "STL y coordinate"),
        finiteNumber(vertex[3], "STL z coordinate"),
      ]);
      cursor += 1;
    }

    if (!/^endloop$/iu.test(lines[cursor] ?? "")) {
      invalid("ASCII STL facet has an invalid outer loop");
    }
    cursor += 1;
    if (!/^endfacet$/iu.test(lines[cursor] ?? "")) {
      invalid("ASCII STL facet is not closed");
    }
    cursor += 1;

    triangles.push([vertices[0]!, vertices[1]!, vertices[2]!]);
    if (triangles.length > MAX_TRIANGLES) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "RESOURCE_LIMIT_EXCEEDED",
        "STL exceeds the triangle limit",
      );
    }
  }

  if (!closed || triangles.length === 0 || cursor !== lines.length) {
    invalid("ASCII STL contains an invalid solid structure");
  }
  return triangles;
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

function zipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  return readBoundedZipEntries(bytes, {
    label: "3MF archive",
    invalidCode: "INVALID_MODEL",
    maximumEntries: MAX_ZIP_ENTRIES,
    maximumEntryBytes: MAX_XML_BYTES,
    maximumTotalBytes: MAX_ARCHIVE_OUTPUT_BYTES,
  });
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
    const stack: Array<{ uri: string; local: string }> = [];
    let sawRoot = false;
    parseXml(bytes, (parser) => {
      parser.on("opentag", (tag) => {
        const parent = stack.at(-1);
        if (stack.length === 0) {
          if (
            tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE ||
            tag.local !== "Relationships"
          ) {
            invalid("3MF relationship root element is invalid");
          }
          sawRoot = true;
        } else if (
          parent?.uri === PACKAGE_RELATIONSHIPS_NAMESPACE &&
          parent.local === "Relationships" &&
          tag.uri === PACKAGE_RELATIONSHIPS_NAMESPACE &&
          tag.local === "Relationship"
        ) {
          if (attribute(tag, "TargetMode")?.toLowerCase() === "external") {
            invalid("3MF archive contains an external relationship");
          }
          const target = attribute(tag, "Target");
          if (!target) invalid("3MF relationship has no target");
          const packageTarget = relationshipTarget(sourcePart!, target);
          if (!entries.has(packageTarget)) {
            invalid("3MF relationship references a missing package part");
          }
          if (attribute(tag, "Type")?.toLowerCase().endsWith("/3dmodel")) {
            const targets = modelRelationships.get(sourcePart!) ?? new Set();
            targets.add(packageTarget);
            modelRelationships.set(sourcePart!, targets);
          }
        }
        stack.push({ uri: tag.uri, local: tag.local });
      });
      parser.on("closetag", () => {
        stack.pop();
      });
    });
    if (!sawRoot) invalid("3MF relationship root element is missing");
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
  propertyAssignments: Map<string, PropertyAssignment>;
};

type PropertyAssignment = {
  resourceId: string;
  propertyIndex: string;
};

type PropertyResource =
  | {
      kind: "base";
      entryCount: number;
    }
  | {
      kind: "appearance";
      entryCount: number;
    }
  | {
      kind: "composite";
      materialResourceId: string;
      materialIndices: string[];
      entries: string[][];
    }
  | {
      kind: "multi";
      propertyResourceIds: string[];
      entries: string[][];
    };

type ResolvedProperty = {
  assignmentIds: ReadonlySet<string>;
  hasAppearance: boolean;
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

type BuildItemDefinition = {
  objectId: string;
  partPath: string;
  transform: Transform;
  printable: boolean;
};

type ModelPart = {
  path: string;
  unitHint: ModelInspection["unitHint"];
  objects: Map<string, ObjectDefinition>;
  buildItems: BuildItemDefinition[];
};

const IDENTITY_TRANSFORM: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

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

function referencedPart(
  tag: SaxesTagNS,
  currentPart: string,
  relationships: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const reference = attribute(tag, "path", PRODUCTION_3MF_NAMESPACE);
  if (reference === undefined) return currentPart;
  if (!reference.startsWith("/")) {
    invalid("3MF production path is not permitted in this model part");
  }
  const target = relationshipTarget(currentPart, reference);
  if (!relationships.get(currentPart)?.has(target)) {
    invalid("3MF production path has no matching model relationship");
  }
  return target;
}

function parseModelPart(
  partPath: string,
  bytes: Uint8Array,
  relationships: ReadonlyMap<string, ReadonlySet<string>>,
): ModelPart {
  let unitHint: ModelInspection["unitHint"] = "unknown";
  const objects = new Map<string, ObjectDefinition>();
  const buildItems: BuildItemDefinition[] = [];
  const propertyResources = new Map<string, PropertyResource>();
  const stack: Array<{ uri: string; local: string }> = [];
  const partIdentity = createHash("sha256")
    .update(partPath)
    .digest("hex")
    .slice(0, 12);
  let sawModel = false;
  let sourceTriangleCount = 0;
  let sourceComponentCount = 0;
  let currentPropertyResource:
    | {
        uri: string;
        local: string;
        definition: PropertyResource;
      }
    | undefined;
  let currentObject:
    | {
        id: string;
        pid: string | undefined;
        pindex: string | undefined;
        kind: "mesh" | "components" | null;
        mesh: (MeshDefinition & { vertices: Point[] }) | null;
        components: ComponentDefinition[];
      }
    | undefined;

  const parentIs = (uri: string, local: string): boolean => {
    const parent = stack.at(-1);
    return parent?.uri === uri && parent.local === local;
  };
  const positiveIndex = (value: string | undefined, label: string): string => {
    if (!value || !/^[0-9]{1,9}$/u.test(value)) invalid(label);
    return value;
  };
  const indexList = (value: string | undefined, label: string): string[] => {
    if (!value) invalid(label);
    const values = value.trim().split(/\s+/u);
    if (
      values.length < 1 ||
      values.some((candidate) => !/^[0-9]{1,9}$/u.test(candidate))
    ) {
      invalid(label);
    }
    return values;
  };
  const numberList = (value: string | undefined, label: string): number[] => {
    if (!value) invalid(label);
    const values = value.trim().split(/\s+/u).map(Number);
    if (
      values.length < 1 ||
      values.some(
        (candidate) =>
          !Number.isFinite(candidate) || candidate < 0 || candidate > 1,
      )
    ) {
      invalid(label);
    }
    return values;
  };
  const startPropertyResource = (
    tag: SaxesTagNS,
    definition: PropertyResource,
  ): void => {
    if (!parentIs(CORE_3MF_NAMESPACE, "resources")) {
      invalid("3MF property resource is outside model resources");
    }
    if (currentPropertyResource) {
      invalid("3MF property resources cannot be nested");
    }
    const id = positiveIndex(
      attribute(tag, "id"),
      "3MF property resource identifier is invalid",
    );
    if (propertyResources.has(id)) {
      invalid("3MF contains duplicate property resource identifiers");
    }
    if (propertyResources.size >= MAX_MODEL_OBJECTS) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "RESOURCE_LIMIT_EXCEEDED",
        "3MF exceeds the property resource limit",
      );
    }
    propertyResources.set(id, definition);
    currentPropertyResource = {
      uri: tag.uri,
      local: tag.local,
      definition,
    };
  };
  const incrementLeafEntry = (expectedLocal: string): void => {
    const resource = currentPropertyResource;
    if (
      resource?.local !== expectedLocal ||
      (resource.definition.kind !== "base" &&
        resource.definition.kind !== "appearance")
    ) {
      invalid("3MF property entry is outside its resource group");
    }
    resource.definition.entryCount += 1;
    if (resource.definition.entryCount > MAX_TRIANGLES * 3) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "RESOURCE_LIMIT_EXCEEDED",
        "3MF exceeds the property entry limit",
      );
    }
  };

  parseXml(bytes, (parser) => {
    parser.on("opentag", (tag) => {
      if (stack.length === 0) {
        if (tag.uri !== CORE_3MF_NAMESPACE || tag.local !== "model") {
          invalid("3MF model element is missing");
        }
        sawModel = true;
        const declaredUnit =
          attribute(tag, "unit")?.toLowerCase() ?? "millimeter";
        unitHint =
          declaredUnit === "micron" ||
          declaredUnit === "millimeter" ||
          declaredUnit === "centimeter" ||
          declaredUnit === "inch" ||
          declaredUnit === "foot" ||
          declaredUnit === "meter"
            ? declaredUnit
            : "unknown";
      } else if (tag.uri === CORE_3MF_NAMESPACE) {
        switch (tag.local) {
          case "basematerials":
            startPropertyResource(tag, { kind: "base", entryCount: 0 });
            break;
          case "base":
            if (!parentIs(CORE_3MF_NAMESPACE, "basematerials")) {
              invalid("3MF base material is outside its resource group");
            }
            incrementLeafEntry("basematerials");
            break;
          case "object": {
            if (!parentIs(CORE_3MF_NAMESPACE, "resources") || currentObject) {
              invalid("3MF object is outside model resources");
            }
            const objectId = positiveIndex(
              attribute(tag, "id"),
              "3MF object identifier is invalid",
            );
            if (objects.has(objectId)) {
              invalid("3MF contains duplicate object identifiers");
            }
            if (objects.size >= MAX_MODEL_OBJECTS) {
              throw new SlicingWorkerError(
                "deterministic_invalid",
                "RESOURCE_LIMIT_EXCEEDED",
                "3MF exceeds the model object limit",
              );
            }
            const pid = attribute(tag, "pid");
            const pindex = attribute(tag, "pindex");
            if ((pid === undefined) !== (pindex === undefined)) {
              invalid("3MF object property assignment is incomplete");
            }
            currentObject = {
              id: objectId,
              pid:
                pid === undefined
                  ? undefined
                  : positiveIndex(pid, "3MF object property id is invalid"),
              pindex:
                pindex === undefined
                  ? undefined
                  : positiveIndex(
                      pindex,
                      "3MF object property index is invalid",
                    ),
              kind: null,
              mesh: null,
              components: [],
            };
            break;
          }
          case "mesh":
            if (!parentIs(CORE_3MF_NAMESPACE, "object") || !currentObject) {
              invalid("3MF mesh is outside an object");
            }
            if (currentObject.kind !== null) {
              invalid(
                "3MF object must contain exactly one mesh or component graph",
              );
            }
            currentObject.kind = "mesh";
            currentObject.mesh = {
              vertices: [],
              triangles: [],
              paint: false,
              materials: new Set(),
              extruders: new Set(),
              propertyAssignments: new Map(),
            };
            break;
          case "components":
            if (!parentIs(CORE_3MF_NAMESPACE, "object") || !currentObject) {
              invalid("3MF components are outside an object");
            }
            if (currentObject.kind !== null) {
              invalid(
                "3MF object must contain exactly one mesh or component graph",
              );
            }
            currentObject.kind = "components";
            break;
          case "vertex": {
            if (
              !parentIs(CORE_3MF_NAMESPACE, "vertices") ||
              !currentObject?.mesh
            ) {
              invalid("3MF vertex is outside a mesh vertex list");
            }
            if (currentObject.mesh.vertices.length >= MAX_TRIANGLES * 3) {
              throw new SlicingWorkerError(
                "deterministic_invalid",
                "RESOURCE_LIMIT_EXCEEDED",
                "3MF exceeds the vertex limit",
              );
            }
            currentObject.mesh.vertices.push([
              finiteNumber(attribute(tag, "x"), "3MF x coordinate"),
              finiteNumber(attribute(tag, "y"), "3MF y coordinate"),
              finiteNumber(attribute(tag, "z"), "3MF z coordinate"),
            ]);
            break;
          }
          case "triangle": {
            if (
              !parentIs(CORE_3MF_NAMESPACE, "triangles") ||
              !currentObject?.mesh
            ) {
              invalid("3MF triangle is outside a mesh triangle list");
            }
            sourceTriangleCount += 1;
            if (sourceTriangleCount > MAX_TRIANGLES) {
              throw new SlicingWorkerError(
                "deterministic_invalid",
                "RESOURCE_LIMIT_EXCEEDED",
                "3MF exceeds the source triangle limit",
              );
            }
            const indices = ["v1", "v2", "v3"].map((name) =>
              Number(
                positiveIndex(
                  attribute(tag, name),
                  "3MF triangle index is invalid",
                ),
              ),
            );
            const selected = indices.map(
              (index) => currentObject!.mesh!.vertices[index],
            );
            if (selected.some((point) => point === undefined)) {
              invalid("3MF triangle references a missing vertex");
            }
            currentObject.mesh.triangles.push([
              selected[0]!,
              selected[1]!,
              selected[2]!,
            ]);
            const trianglePid = attribute(tag, "pid");
            const pid =
              trianglePid === undefined
                ? currentObject.pid
                : positiveIndex(
                    trianglePid,
                    "3MF triangle property id is invalid",
                  );
            const propertyIndices = ["p1", "p2", "p3"]
              .map((name) => attribute(tag, name))
              .filter((value): value is string => value !== undefined);
            if (propertyIndices.length > 0 && pid === undefined) {
              invalid("3MF triangle property assignment has no resource id");
            }
            const fallbackPropertyIndex =
              trianglePid === undefined ? currentObject.pindex : undefined;
            if (pid) {
              const assigned =
                propertyIndices.length > 0
                  ? propertyIndices
                  : fallbackPropertyIndex
                    ? [fallbackPropertyIndex]
                    : invalid("3MF triangle property assignment is incomplete");
              for (const propertyIndex of assigned) {
                const validatedIndex = positiveIndex(
                  propertyIndex,
                  "3MF triangle property index is invalid",
                );
                currentObject.mesh.propertyAssignments.set(
                  `${pid}\0${validatedIndex}`,
                  { resourceId: pid, propertyIndex: validatedIndex },
                );
              }
            }
            const paintValue =
              attribute(tag, "paint_color") ??
              attribute(tag, "mmu_segmentation", SLIC3R_3MF_NAMESPACE);
            if (paintValue !== undefined) {
              currentObject.mesh.paint = true;
              for (const segment of paintValue.split(/[\s,]+/u)) {
                if (!/^\d+$/u.test(segment)) continue;
                const assignment = Number(segment) >> 2;
                if (assignment > 0) {
                  currentObject.mesh.extruders.add(`extruder-${assignment}`);
                }
              }
            }
            break;
          }
          case "component": {
            if (
              !parentIs(CORE_3MF_NAMESPACE, "components") ||
              currentObject?.kind !== "components"
            ) {
              invalid("3MF component is outside a component graph");
            }
            sourceComponentCount += 1;
            if (sourceComponentCount > MAX_COMPONENT_EDGES) {
              throw new SlicingWorkerError(
                "deterministic_invalid",
                "RESOURCE_LIMIT_EXCEEDED",
                "3MF component graph exceeds the source edge limit",
              );
            }
            currentObject.components.push({
              objectId: positiveIndex(
                attribute(tag, "objectid"),
                "3MF component object identifier is invalid",
              ),
              partPath: referencedPart(tag, partPath, relationships),
              transform: transformValue(attribute(tag, "transform")),
            });
            break;
          }
          case "item": {
            if (!parentIs(CORE_3MF_NAMESPACE, "build")) {
              invalid("3MF build item is outside the build section");
            }
            const printable = attribute(tag, "printable");
            if (
              printable !== undefined &&
              printable !== "0" &&
              printable !== "1"
            ) {
              invalid("3MF build item printable flag is invalid");
            }
            if (buildItems.length >= 256) {
              throw new SlicingWorkerError(
                "deterministic_invalid",
                "RESOURCE_LIMIT_EXCEEDED",
                "3MF exceeds the selectable body limit",
              );
            }
            buildItems.push({
              objectId: positiveIndex(
                attribute(tag, "objectid"),
                "3MF build item object identifier is invalid",
              ),
              partPath: referencedPart(tag, partPath, relationships),
              transform: transformValue(attribute(tag, "transform")),
              printable: printable !== "0",
            });
            break;
          }
        }
      } else if (tag.uri === MATERIAL_3MF_NAMESPACE) {
        switch (tag.local) {
          case "colorgroup":
          case "texture2dgroup":
            startPropertyResource(tag, {
              kind: "appearance",
              entryCount: 0,
            });
            break;
          case "color":
            if (!parentIs(MATERIAL_3MF_NAMESPACE, "colorgroup")) {
              invalid("3MF color is outside its resource group");
            }
            incrementLeafEntry("colorgroup");
            break;
          case "tex2coord":
            if (!parentIs(MATERIAL_3MF_NAMESPACE, "texture2dgroup")) {
              invalid("3MF texture coordinate is outside its resource group");
            }
            incrementLeafEntry("texture2dgroup");
            break;
          case "compositematerials": {
            const materialIndices = indexList(
              attribute(tag, "matindices"),
              "3MF composite material indices are invalid",
            );
            if (materialIndices.length < 2) {
              invalid(
                "3MF composite material requires at least two constituents",
              );
            }
            startPropertyResource(tag, {
              kind: "composite",
              materialResourceId: positiveIndex(
                attribute(tag, "matid"),
                "3MF composite material resource id is invalid",
              ),
              materialIndices,
              entries: [],
            });
            break;
          }
          case "composite": {
            if (!parentIs(MATERIAL_3MF_NAMESPACE, "compositematerials")) {
              invalid("3MF composite is outside its resource group");
            }
            const resource = currentPropertyResource?.definition;
            if (!resource || resource.kind !== "composite") {
              invalid("3MF composite is outside its resource group");
            }
            const values = numberList(
              attribute(tag, "values"),
              "3MF composite values are invalid",
            );
            const selected = resource.materialIndices.filter(
              (_materialIndex, index) => (values[index] ?? 0) > 0,
            );
            resource.entries.push(
              selected.length > 0 ? selected : [...resource.materialIndices],
            );
            break;
          }
          case "multiproperties": {
            startPropertyResource(tag, {
              kind: "multi",
              propertyResourceIds: indexList(
                attribute(tag, "pids"),
                "3MF multiproperty resource ids are invalid",
              ),
              entries: [],
            });
            break;
          }
          case "multi": {
            if (!parentIs(MATERIAL_3MF_NAMESPACE, "multiproperties")) {
              invalid("3MF multiproperty entry is outside its resource group");
            }
            const resource = currentPropertyResource?.definition;
            if (!resource || resource.kind !== "multi") {
              invalid("3MF multiproperty entry is outside its resource group");
            }
            const indices = indexList(
              attribute(tag, "pindices"),
              "3MF multiproperty indices are invalid",
            );
            resource.entries.push(
              resource.propertyResourceIds.map(
                (_resourceId, index) => indices[index] ?? "0",
              ),
            );
            break;
          }
        }
      }
      stack.push({ uri: tag.uri, local: tag.local });
    });
    parser.on("closetag", (tag) => {
      if (tag.uri === CORE_3MF_NAMESPACE && tag.local === "object") {
        if (!currentObject || currentObject.kind === null) {
          invalid(
            "3MF object must contain exactly one mesh or component graph",
          );
        }
        if (currentObject.kind === "mesh") {
          if (!currentObject.mesh || currentObject.mesh.triangles.length < 1) {
            invalid("Model body contains no triangles");
          }
          const { vertices: _vertices, ...mesh } = currentObject.mesh;
          objects.set(currentObject.id, { mesh, components: [] });
        } else {
          if (currentObject.components.length < 1) {
            invalid("3MF component graph is empty");
          }
          objects.set(currentObject.id, {
            mesh: null,
            components: currentObject.components,
          });
        }
        currentObject = undefined;
      }
      if (
        currentPropertyResource?.uri === tag.uri &&
        currentPropertyResource.local === tag.local
      ) {
        currentPropertyResource = undefined;
      }
      stack.pop();
    });
  });
  if (!sawModel) invalid("3MF model element is missing");
  const propertyCache = new Map<string, ResolvedProperty>();
  const resolveProperty = (
    resourceId: string,
    propertyIndex: string,
    stack: ReadonlySet<string>,
  ): ResolvedProperty => {
    const key = `${resourceId}\0${propertyIndex}`;
    const cached = propertyCache.get(key);
    if (cached) return cached;
    if (stack.has(key)) invalid("3MF property resource graph contains a cycle");
    const resource = propertyResources.get(resourceId);
    if (!resource)
      invalid("3MF property assignment references a missing resource");
    const index = Number(propertyIndex);
    if (!Number.isSafeInteger(index)) {
      invalid("3MF property assignment index is invalid");
    }
    const nextStack = new Set(stack).add(key);
    const assignmentIds = new Set<string>();
    let hasAppearance = false;
    if (resource.kind === "base" || resource.kind === "appearance") {
      if (index >= resource.entryCount) {
        invalid("3MF property assignment index is out of range");
      }
      hasAppearance = resource.kind === "appearance";
      assignmentIds.add(
        `material-${partIdentity}-${resourceId}-${propertyIndex}`,
      );
    } else if (resource.kind === "composite") {
      const base = propertyResources.get(resource.materialResourceId);
      if (base?.kind !== "base") {
        invalid("3MF composite references a non-base material resource");
      }
      const constituents = resource.entries[index];
      if (!constituents) {
        invalid("3MF composite property index is out of range");
      }
      for (const constituent of constituents) {
        const resolved = resolveProperty(
          resource.materialResourceId,
          constituent,
          nextStack,
        );
        for (const value of resolved.assignmentIds) {
          assignmentIds.add(value);
        }
        hasAppearance ||= resolved.hasAppearance;
      }
    } else {
      const indices = resource.entries[index];
      if (!indices) invalid("3MF multiproperty index is out of range");
      let materialResourceCount = 0;
      for (
        let position = 0;
        position < resource.propertyResourceIds.length;
        position += 1
      ) {
        const childResourceId = resource.propertyResourceIds[position]!;
        const child = propertyResources.get(childResourceId);
        if (!child) invalid("3MF multiproperty references a missing resource");
        if (child.kind === "multi") {
          invalid("3MF multiproperty cannot reference another multiproperty");
        }
        if (child.kind === "base" || child.kind === "composite") {
          materialResourceCount += 1;
          if (materialResourceCount > 1) {
            invalid("3MF multiproperty references multiple material resources");
          }
        }
        const resolved = resolveProperty(
          childResourceId,
          indices[position]!,
          nextStack,
        );
        for (const value of resolved.assignmentIds) {
          assignmentIds.add(value);
        }
        hasAppearance ||= resolved.hasAppearance;
      }
    }
    const resolved = { assignmentIds, hasAppearance };
    propertyCache.set(key, resolved);
    return resolved;
  };
  for (const definition of objects.values()) {
    if (!definition.mesh) continue;
    for (const assignment of definition.mesh.propertyAssignments.values()) {
      const resolved = resolveProperty(
        assignment.resourceId,
        assignment.propertyIndex,
        new Set(),
      );
      for (const value of resolved.assignmentIds) {
        definition.mesh.materials.add(value);
      }
      definition.mesh.paint ||= resolved.hasAppearance;
    }
    definition.mesh.propertyAssignments.clear();
  }
  return { path: partPath, unitHint, objects, buildItems };
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
  const parts = new Map<string, ModelPart>();
  const loadPart = (partPath: string): ModelPart => {
    const existing = parts.get(partPath);
    if (existing) return existing;
    const partBytes = entries.get(partPath);
    if (!partBytes || !partPath.toLowerCase().endsWith(".model")) {
      invalid("3MF component references a missing model part");
    }
    const parsed = parseModelPart(partPath, partBytes, relationships);
    parts.set(partPath, parsed);
    return parsed;
  };
  const root = loadPart(rootPart);
  const buildItems = root.buildItems.filter(({ printable }) => printable);
  if (buildItems.length < 1) invalid("3MF root model contains no build items");
  const micrometersPerUnit = {
    micron: 1,
    millimeter: 1_000,
    centimeter: 10_000,
    inch: 25_400,
    foot: 304_800,
    meter: 1_000_000,
    unknown: 1_000,
  }[root.unitHint];
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
        propertyAssignments: new Map(),
      };
    }
    const nextStack = new Set(stack).add(identity);
    const combined: MeshDefinition = {
      triangles: [],
      paint: false,
      materials: new Set(),
      extruders: new Set(),
      propertyAssignments: new Map(),
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
    const realized = resolveObject(item.partPath, item.objectId, new Set(), 1);
    return body(
      `body-${String(index + 1).padStart(4, "0")}`,
      transformedTriangles(realized.triangles, item.transform),
      {
        paint: realized.paint,
        materials: realized.materials,
        extruders: realized.extruders,
      },
      micrometersPerUnit,
    );
  });
  const materialIds = new Set(
    parsedBodies.flatMap((item) => item.materialAssignmentIds),
  );
  const extruderIds = new Set(
    parsedBodies.flatMap((item) => item.extruderAssignmentIds),
  );
  if (
    materialIds.size > MAX_ASSIGNMENT_IDS ||
    extruderIds.size > MAX_ASSIGNMENT_IDS
  ) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "RESOURCE_LIMIT_EXCEEDED",
      "3MF exceeds the distinct material or extruder assignment limit",
    );
  }
  return {
    unitHint: root.unitHint,
    bodies: parsedBodies,
    boundingBox: boundingBox(
      parsedBodies.flatMap((item) => item.triangles),
      micrometersPerUnit,
    ),
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

function translatedTriangle(triangle: Triangle, origin: Point): Triangle {
  return triangle.map(
    (point) =>
      point.map(
        (coordinate, axis) => coordinate - origin[axis]!,
      ) as unknown as Point,
  ) as unknown as Triangle;
}

function selectionOrigin(triangles: readonly Triangle[]): Point {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  for (const triangle of triangles) {
    for (const point of triangle) {
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
      }
    }
  }
  return minimum;
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
  const scaledTriangles = selected.map((item) =>
    item!.triangles.map((triangle) => scaledTriangle(triangle, factor)),
  );
  const origin = selectionOrigin(scaledTriangles.flat());
  const scaledBodies = selected.map((item, index) =>
    body(
      item!.bodyId,
      scaledTriangles[index]!.map((triangle) =>
        translatedTriangle(triangle, origin),
      ),
      {
        paint: item!.hasPaintAssignments,
        materials: item!.materialAssignmentIds,
        extruders: item!.extruderAssignmentIds,
      },
    ),
  );
  const triangles = scaledBodies.flatMap((item) => item.triangles);
  const canonical = canonicalBinaryStl(triangles);
  const serializedInspection = inspectModel("stl", canonical);
  const serializedTriangles = parseBinaryStl(canonical);
  if (!serializedTriangles) invalid("Canonical STL serialization is invalid");
  let triangleOffset = 0;
  const serializedBodies = scaledBodies.map((intendedBody) => {
    const nextOffset = triangleOffset + intendedBody.triangleCount;
    const serializedBody = body(
      intendedBody.bodyId,
      serializedTriangles.slice(triangleOffset, nextOffset),
      {
        paint: intendedBody.hasPaintAssignments,
        materials: intendedBody.materialAssignmentIds,
        extruders: intendedBody.extruderAssignmentIds,
      },
    );
    triangleOffset = nextOffset;
    if (
      JSON.stringify(serializedBody.boundingBox) !==
        JSON.stringify(intendedBody.boundingBox) ||
      JSON.stringify(serializedBody.topology) !==
        JSON.stringify(intendedBody.topology)
    ) {
      invalid("Canonical STL serialization loses body precision");
    }
    return serializedBody;
  });
  if (triangleOffset !== serializedTriangles.length) {
    invalid("Canonical STL serialization loses body correspondence");
  }
  const intendedBounds = boundingBox(triangles);
  if (
    JSON.stringify(serializedInspection.boundingBox) !==
    JSON.stringify(intendedBounds)
  ) {
    invalid("Canonical STL serialization loses model precision");
  }
  return {
    bytes: canonical,
    sha256: sha256(canonical),
    inspection: {
      unitHint: "millimeter",
      bodies: serializedBodies.map(
        ({ triangles: _triangles, ...value }) => value,
      ),
      boundingBox: intendedBounds,
      objectCount: serializedBodies.length,
      hasPaintAssignments: serializedBodies.some(
        (item) => item.hasPaintAssignments,
      ),
      materialAssignmentCount: new Set(
        serializedBodies.flatMap((item) => item.materialAssignmentIds),
      ).size,
      extruderAssignmentCount: new Set(
        serializedBodies.flatMap((item) => item.extruderAssignmentIds),
      ).size,
    },
  };
}

export function inspectionFingerprint(inspection: ModelInspection): string {
  return createHash("sha256").update(JSON.stringify(inspection)).digest("hex");
}
